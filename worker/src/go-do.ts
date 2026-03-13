/**
 * GoDO — Durable Object that runs TinyGo WASM.
 *
 * WASM instance is created once and kept alive for the lifetime of the DO.
 * Each request calls the exported handle() function — no re-instantiation.
 *
 * Flow:
 * 1. First request: compile + instantiate WASM, call _start() to init Go runtime
 * 2. Every request: write request JSON to WASM memory, call handle(), read response
 */

import goWasmModule from "./go.wasm";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface Env {
  [key: string]: unknown;
}

interface GoWasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  gomode_malloc: (size: number) => number;
  handle: (reqPtr: number, reqLen: number) => number;
  getResponsePtr: () => number;
}

export class GoDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private wasmExports: GoWasmExports | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initWasm(): Promise<void> {
    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: this.buildWasiImports(),
      gomode_host: this.buildHostImports(),
    };

    const instance = await WebAssembly.instantiate(goWasmModule, imports);
    this.wasmExports = instance.exports as unknown as GoWasmExports;

    // Call _start() to initialize the Go runtime.
    // TinyGo calls proc_exit(0) at the end of main(), which throws.
    try {
      this.wasmExports._start();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("exit code: 0") && !msg.includes("proc_exit")) {
        throw e;
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    // Initialize WASM once (lazy, on first request)
    if (!this.wasmExports) {
      if (!this.initPromise) {
        this.initPromise = this.initWasm();
      }
      await this.initPromise;
    }

    const exports = this.wasmExports!;
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

    // Write request into WASM memory
    const reqPtr = exports.gomode_malloc(reqBytes.length);
    new Uint8Array(exports.memory.buffer, reqPtr, reqBytes.length).set(
      reqBytes
    );

    // Call handle — returns response length
    const respLen = exports.handle(reqPtr, reqBytes.length);
    const respPtr = exports.getResponsePtr();

    // Read response from WASM memory
    const respBytes = new Uint8Array(
      exports.memory.buffer,
      respPtr,
      respLen
    );
    const respText = textDecoder.decode(respBytes);

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

  private buildWasiImports(): Record<string, WebAssembly.ImportValue> {
    // Memory reference is resolved lazily since exports aren't set yet
    const getMemory = () => this.wasmExports!.memory;

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
          if (fd === 2) {
            const bytes = new Uint8Array(memory.buffer, ptr, len);
            console.log(
              "[gomode:stderr]",
              textDecoder.decode(bytes)
            );
          }
          written += len;
        }
        mem.setUint32(nwritten, written, true);
        return 0;
      },

      fd_read: (
        _fd: number,
        _iovs: number,
        _iovsLen: number,
        nread: number
      ) => {
        // No stdin in reactor mode — handle() reads from memory directly
        const mem = new DataView(getMemory().buffer);
        mem.setUint32(nread, 0, true);
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
      fd_fdstat_set_flags: () => 0,
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
      poll_oneoff: (
        _in: number,
        _out: number,
        _nsubs: number,
        nevents: number
      ) => {
        const mem = new DataView(getMemory().buffer);
        mem.setUint32(nevents, 0, true);
        return 0;
      },
      sched_yield: () => 0,
    };
  }

  private buildHostImports(): Record<string, WebAssembly.ImportValue> {
    const getMemory = () => this.wasmExports!.memory;

    return {
      host_net_connect: (
        hostPtr: number,
        hostLen: number,
        _port: number
      ) => {
        const _hostname = textDecoder.decode(
          new Uint8Array(getMemory().buffer, hostPtr, hostLen)
        );
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
        const _key = textDecoder.decode(
          new Uint8Array(getMemory().buffer, keyPtr, keyLen)
        );
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
