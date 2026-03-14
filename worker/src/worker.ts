/**
 * GoMode Worker — Two modes:
 *   /do/*  → Durable Object (stateful, persistent WASM instance)
 *   /*     → Direct WASM execution (stateless, max concurrency)
 *
 * Single WASM binary: TinyGo + Zig linked via wasm-ld.
 * Go calls Zig SIMD directly — internal function calls, zero overhead.
 */

export { GoDO } from "./go-do";
import goWasmModule from "./go.wasm";
import { Arena, defineSchema } from "zerobuf";

const textDecoder = new TextDecoder();

interface Env {
  GO_DO: DurableObjectNamespace;
}

interface GoWasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  handle_zerobuf: (reqBase: number) => number;
}

const RequestSchema = defineSchema<{ method: string; path: string }>(["method", "path"]);
const ResponseSchema = defineSchema<{ status: number; contentType: string; body: string }>(["status", "contentType", "body"]);

let wasmExports: GoWasmExports | null = null;
let initPromise: Promise<void> | null = null;
let zbArena: Arena | null = null;

function buildWasiImports(
  getMemory: () => WebAssembly.Memory
): Record<string, WebAssembly.ImportValue> {
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

async function initWasm(): Promise<void> {
  const getMemory = () => wasmExports!.memory;

  const instance = await WebAssembly.instantiate(goWasmModule, {
    wasi_snapshot_preview1: buildWasiImports(getMemory),
  });

  wasmExports = instance.exports as unknown as GoWasmExports;

  try {
    wasmExports._start();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("exit code: 0") && !msg.includes("proc_exit")) throw e;
  }
}

async function ensureWasm(): Promise<GoWasmExports> {
  if (!wasmExports) {
    if (!initPromise) initPromise = initWasm();
    await initPromise;
  }
  return wasmExports!;
}

async function handleRequest(request: Request, pathname: string): Promise<Response> {
  const exports = await ensureWasm();

  if (!zbArena) {
    zbArena = new Arena(exports.memory, 1024 * 1024);
  }

  const checkpoint = zbArena.save();

  try {
    const req = RequestSchema.create(zbArena, {
      method: request.method,
      path: pathname,
    });

    const reqPtr = (req as unknown as { __zerobuf_ptr: number }).__zerobuf_ptr;
    const respPtr = exports.handle_zerobuf(reqPtr);

    const resp = ResponseSchema.toJS(zbArena, respPtr);

    return new Response(resp.body, {
      status: resp.status,
      headers: { "content-type": resp.contentType },
    });
  } finally {
    zbArena.restore(checkpoint);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/do/")) {
      const id = env.GO_DO.idFromName("singleton");
      const durable = env.GO_DO.get(id);
      const innerUrl = new URL(request.url);
      innerUrl.pathname = url.pathname.slice(3) || "/";
      return durable.fetch(new Request(innerUrl.toString(), request));
    }

    return handleRequest(request, url.pathname);
  },
};
