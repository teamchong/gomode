/**
 * GoDO — Durable Object that runs TinyGo + Zig ABI WASM.
 *
 * Each request:
 * 1. Serializes CF Request → JSON
 * 2. Writes JSON to WASM stdin
 * 3. Runs go.wasm (_start)
 * 4. Reads response JSON from stdout
 * 5. Builds CF Response
 *
 * Host imports (gomode_host namespace) provide raw I/O:
 * - host_net_connect/send/recv/close (raw sockets via CF connect())
 * - host_random_get (crypto.getRandomValues)
 * - host_time_now (Date.now)
 * - host_console_log (console.log)
 * - host_kv_get/put (CF KV via binding)
 *
 * Columnar data stays in wasm.memory — JS reads via DataView (zero copy).
 */

import goWasmModule from "./go.wasm";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface Env {
  [key: string]: unknown;
}

export class GoDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });

    let body: number[] | undefined;
    if (request.body) {
      const buf = await request.arrayBuffer();
      body = [...new Uint8Array(buf)];
    }

    const reqJson = JSON.stringify({
      method: request.method,
      url: request.url,
      path: url.pathname,
      headers,
      body,
    });

    const reqBytes = textEncoder.encode(reqJson);

    let stdinOffset = 0;
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    let wasmMemory: WebAssembly.Memory;

    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: this.buildWasiImports(
        reqBytes,
        () => stdinOffset,
        (n: number) => {
          stdinOffset += n;
        },
        stdoutChunks,
        stderrChunks,
        () => wasmMemory
      ),
      gomode_host: this.buildHostImports(() => wasmMemory),
    };

    const instance = await WebAssembly.instantiate(goWasmModule, imports);
    const exports = instance.exports as {
      memory: WebAssembly.Memory;
      _start: () => void;
    };
    wasmMemory = exports.memory;

    try {
      exports._start();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("exit code: 0") && !msg.includes("proc_exit")) {
        const stderr = concatBuffers(stderrChunks);
        return new Response(
          JSON.stringify({
            error: msg,
            stderr: textDecoder.decode(stderr),
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    const stdout = concatBuffers(stdoutChunks);
    const respText = textDecoder.decode(stdout);

    try {
      const resp = JSON.parse(respText) as {
        status: number;
        headers?: Record<string, string>;
        body?: number[] | string;
      };

      const respHeaders = new Headers(resp.headers || {});
      let respBody: BodyInit;
      if (Array.isArray(resp.body)) {
        respBody = new Uint8Array(resp.body);
      } else {
        respBody = resp.body || "";
      }

      return new Response(respBody, {
        status: resp.status || 200,
        headers: respHeaders,
      });
    } catch {
      return new Response(respText, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
  }

  /**
   * WASI preview1 imports — enough for TinyGo's _start().
   */
  private buildWasiImports(
    stdinData: Uint8Array,
    getStdinOffset: () => number,
    advanceStdin: (n: number) => void,
    stdoutChunks: Uint8Array[],
    stderrChunks: Uint8Array[],
    getMemory: () => WebAssembly.Memory
  ): Record<string, WebAssembly.ImportValue> {
    return {
      fd_write: (
        fd: number,
        iovs: number,
        iovsLen: number,
        nwritten: number
      ) => {
        const memory = getMemory();
        const mem = new DataView(memory.buffer);
        let written = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = mem.getUint32(iovs + i * 8, true);
          const len = mem.getUint32(iovs + i * 8 + 4, true);
          const bytes = new Uint8Array(memory.buffer, ptr, len);
          if (fd === 1) {
            stdoutChunks.push(bytes.slice());
          } else if (fd === 2) {
            stderrChunks.push(bytes.slice());
          }
          written += len;
        }
        mem.setUint32(nwritten, written, true);
        return 0;
      },

      fd_read: (
        fd: number,
        iovs: number,
        iovsLen: number,
        nread: number
      ) => {
        const memory = getMemory();
        const mem = new DataView(memory.buffer);
        if (fd !== 0) {
          mem.setUint32(nread, 0, true);
          return 0;
        }
        let totalRead = 0;
        const offset = getStdinOffset();
        for (let i = 0; i < iovsLen; i++) {
          const ptr = mem.getUint32(iovs + i * 8, true);
          const len = mem.getUint32(iovs + i * 8 + 4, true);
          const available = stdinData.length - offset - totalRead;
          const toRead = Math.min(len, available);
          if (toRead > 0) {
            const src = stdinData.subarray(
              offset + totalRead,
              offset + totalRead + toRead
            );
            new Uint8Array(memory.buffer, ptr, toRead).set(src);
            totalRead += toRead;
          }
        }
        advanceStdin(totalRead);
        mem.setUint32(nread, totalRead, true);
        return 0;
      },

      fd_close: () => 0,
      fd_seek: () => 0,
      fd_fdstat_get: (fd: number, buf: number) => {
        const mem = new DataView(getMemory().buffer);
        mem.setUint8(buf, fd <= 2 ? 2 : 4);
        mem.setUint8(buf + 1, 0);
        mem.setBigUint64(buf + 8, 0n, true);
        mem.setBigUint64(buf + 16, 0n, true);
        return 0;
      },
      fd_prestat_get: () => 8,
      fd_prestat_dir_name: () => 8,

      environ_get: () => 0,
      environ_sizes_get: (count: number, size: number) => {
        const mem = new DataView(getMemory().buffer);
        mem.setUint32(count, 0, true);
        mem.setUint32(size, 0, true);
        return 0;
      },

      args_get: () => 0,
      args_sizes_get: (argc: number, argvBufSize: number) => {
        const mem = new DataView(getMemory().buffer);
        mem.setUint32(argc, 0, true);
        mem.setUint32(argvBufSize, 0, true);
        return 0;
      },

      clock_time_get: (_id: number, _precision: bigint, out: number) => {
        const mem = new DataView(getMemory().buffer);
        mem.setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
        return 0;
      },

      proc_exit: (code: number) => {
        throw new Error(`exit code: ${code}`);
      },

      random_get: (ptr: number, len: number) => {
        const buf = new Uint8Array(getMemory().buffer, ptr, len);
        crypto.getRandomValues(buf);
        return 0;
      },

      path_open: () => 44,
      path_filestat_get: () => 44,
      path_create_directory: () => 44,
      path_remove_directory: () => 44,
      path_unlink_file: () => 44,
      path_rename: () => 44,
      fd_readdir: () => 44,
      poll_oneoff: (_in: number, _out: number, _nsubs: number, nevents: number) => {
        const mem = new DataView(getMemory().buffer);
        mem.setUint32(nevents, 0, true);
        return 0;
      },
      sched_yield: () => 0,
    };
  }

  /**
   * GoMode host imports — raw I/O for the Zig ABI layer.
   *
   * Networking: CF Workers use fetch() for HTTP and connect() for raw TCP.
   * Since connect() requires specific CF plans and is async, raw socket
   * operations return -1 (connection refused). HTTP goes through the
   * fetch() binding via Asyncify once integrated (same pattern as pymode).
   *
   * KV: CF KV is async. Synchronous KV access requires Asyncify stack
   * unwind/rewind (same pattern as pymode's kv_get). Returns -1 until
   * Asyncify integration is wired up.
   */
  private buildHostImports(
    getMemory: () => WebAssembly.Memory
  ): Record<string, WebAssembly.ImportValue> {
    return {
      host_net_connect: (hostPtr: number, hostLen: number, _port: number) => {
        // Read hostname from WASM memory (validates the pointer is real)
        const _hostname = textDecoder.decode(
          new Uint8Array(getMemory().buffer, hostPtr, hostLen)
        );
        // Raw TCP requires CF connect() API + Asyncify — returns connection refused
        return -1;
      },
      host_net_send: (_fd: number, _ptr: number, _len: number) => -1,
      host_net_recv: (_fd: number, _ptr: number, _len: number) => -1,
      host_net_close: (_fd: number) => {},

      host_random_get: (ptr: number, len: number) => {
        const buf = new Uint8Array(getMemory().buffer, ptr, len);
        crypto.getRandomValues(buf);
      },

      host_time_now: () => Date.now(),

      host_console_log: (ptr: number, len: number) => {
        const msg = textDecoder.decode(
          new Uint8Array(getMemory().buffer, ptr, len)
        );
        console.log("[gomode]", msg);
      },

      host_kv_get: (
        keyPtr: number,
        keyLen: number,
        _bufPtr: number,
        _bufLen: number
      ) => {
        // Read key from WASM memory (validates the pointer)
        const _key = textDecoder.decode(
          new Uint8Array(getMemory().buffer, keyPtr, keyLen)
        );
        // CF KV is async — requires Asyncify to suspend WASM, await KV, resume
        return -1;
      },
      host_kv_put: (
        keyPtr: number,
        keyLen: number,
        _valPtr: number,
        _valLen: number
      ) => {
        const _key = textDecoder.decode(
          new Uint8Array(getMemory().buffer, keyPtr, keyLen)
        );
        // CF KV is async — requires Asyncify to suspend WASM, await KV, resume
        return -1;
      },
    };
  }
}

function concatBuffers(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
