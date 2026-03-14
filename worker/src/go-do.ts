/**
 * GoDO — Durable Object that runs TinyGo + Zig WASM.
 *
 * Single WASM binary: TinyGo + Zig linked via wasm-ld.
 * WASM instance created once and kept alive for the DO lifetime.
 */

import goWasmModule from "./go.wasm";
import { Arena, defineSchema } from "zerobuf";

const textDecoder = new TextDecoder();

interface Env {
  [key: string]: unknown;
}

interface GoWasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  handle_zerobuf: (reqBase: number) => number;
}

const RequestSchema = defineSchema<{ method: string; path: string }>(["method", "path"]);
const ResponseSchema = defineSchema<{ status: number; contentType: string; body: string }>(["status", "contentType", "body"]);

export class GoDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private wasmExports: GoWasmExports | null = null;
  private initPromise: Promise<void> | null = null;
  private arena: Arena | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initWasm(): Promise<void> {
    const instance = await WebAssembly.instantiate(goWasmModule, {
      wasi_snapshot_preview1: this.buildWasiImports(),
    });

    this.wasmExports = instance.exports as unknown as GoWasmExports;

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
    if (!this.wasmExports) {
      if (!this.initPromise) {
        this.initPromise = this.initWasm();
      }
      await this.initPromise;
    }

    const exports = this.wasmExports!;

    if (!this.arena) {
      this.arena = new Arena(exports.memory, 1024 * 1024);
    }

    const checkpoint = this.arena.save();

    try {
      const url = new URL(request.url);

      const req = RequestSchema.create(this.arena, {
        method: request.method,
        path: url.pathname,
      });

      const reqPtr = (req as unknown as { __zerobuf_ptr: number }).__zerobuf_ptr;
      const respPtr = exports.handle_zerobuf(reqPtr);

      const resp = ResponseSchema.toJS(this.arena, respPtr);

      return new Response(resp.body, {
        status: resp.status,
        headers: { "content-type": resp.contentType },
      });
    } finally {
      this.arena.restore(checkpoint);
    }
  }

  private buildWasiImports(): Record<string, WebAssembly.ImportValue> {
    const getMemory = () => this.wasmExports!.memory;

    return {
      fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
        const memory = getMemory();
        const mem = new DataView(memory.buffer);
        let written = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = mem.getUint32(iovs + i * 8, true);
          const len = mem.getUint32(iovs + i * 8 + 4, true);
          if (fd === 2) {
            console.log("[gomode:stderr]", textDecoder.decode(new Uint8Array(memory.buffer, ptr, len)));
          }
          written += len;
        }
        mem.setUint32(nwritten, written, true);
        return 0;
      },
      fd_read: (_fd: number, _iovs: number, _iovsLen: number, nread: number) => {
        new DataView(getMemory().buffer).setUint32(nread, 0, true);
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
        new DataView(getMemory().buffer).setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
        return 0;
      },
      proc_exit: (code: number) => { throw new Error(`exit code: ${code}`); },
      random_get: (ptr: number, len: number) => {
        crypto.getRandomValues(new Uint8Array(getMemory().buffer, ptr, len));
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
        new DataView(getMemory().buffer).setUint32(nevents, 0, true);
        return 0;
      },
      sched_yield: () => 0,
    };
  }
}
