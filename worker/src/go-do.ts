/**
 * GoDO — Durable Object with fast path direct memory access.
 *
 * Same optimizations as worker.ts: direct DataView writes/reads,
 * no zerobuf schema objects, pre-encoded methods.
 */

import goWasmModule from "./go.wasm";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const VALUE_SLOT = 16;
const TAG_STRING = 4;
const STRING_HEADER = 4;

const METHOD_BYTES: Record<string, Uint8Array> = {
  GET: new Uint8Array([71, 69, 84]),
  POST: new Uint8Array([80, 79, 83, 84]),
  PUT: new Uint8Array([80, 85, 84]),
  DELETE: new Uint8Array([68, 69, 76, 69, 84, 69]),
  PATCH: new Uint8Array([80, 65, 84, 67, 72]),
  HEAD: new Uint8Array([72, 69, 65, 68]),
  OPTIONS: new Uint8Array([79, 80, 84, 73, 79, 78, 83]),
};

// Scratch space allocated per DO instance after WASM init

interface Env {
  [key: string]: unknown;
}

interface GoWasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  handle_zerobuf: (reqBase: number) => number;
  malloc: (size: number) => number;
}

function writeStringSlot(
  mem: DataView, u8: Uint8Array,
  slotOffset: number, dataOffset: number,
  bytes: Uint8Array
): number {
  mem.setUint32(dataOffset, bytes.byteLength, true);
  u8.set(bytes, dataOffset + STRING_HEADER);
  mem.setUint8(slotOffset, TAG_STRING);
  mem.setUint32(slotOffset + 4, dataOffset, true);
  return (dataOffset + STRING_HEADER + bytes.byteLength + 3) & ~3;
}

export class GoDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private wasmExports: GoWasmExports | null = null;
  private initPromise: Promise<void> | null = null;
  private reqScratch = 0;

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

    this.reqScratch = this.wasmExports.malloc(256);
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.wasmExports) {
      if (!this.initPromise) {
        this.initPromise = this.initWasm();
      }
      await this.initPromise;
    }

    const exports = this.wasmExports!;
    const url = request.url;
    const schemeEnd = url.indexOf("//");
    const pathStart = schemeEnd === -1 ? 0 : url.indexOf("/", schemeEnd + 2);
    const queryStart = url.indexOf("?", pathStart === -1 ? 0 : pathStart);
    const pathname = pathStart === -1 ? "/" :
      queryStart === -1 ? url.slice(pathStart) : url.slice(pathStart, queryStart);

    const memory = exports.memory;
    const buf = memory.buffer;
    const mem = new DataView(buf);
    const u8 = new Uint8Array(buf);

    let dataOffset = this.reqScratch + 2 * VALUE_SLOT;

    const methodBytes = METHOD_BYTES[request.method] || textEncoder.encode(request.method);
    dataOffset = writeStringSlot(mem, u8, this.reqScratch, dataOffset, methodBytes);

    const pathBytes = textEncoder.encode(pathname);
    dataOffset = writeStringSlot(mem, u8, this.reqScratch + VALUE_SLOT, dataOffset, pathBytes);

    const respPtr = exports.handle_zerobuf(this.reqScratch);

    const status = mem.getInt32(respPtr + 4, true);

    const ctPtr = mem.getUint32(respPtr + VALUE_SLOT + 4, true);
    const ctLen = mem.getUint32(ctPtr, true);
    const contentType = textDecoder.decode(new Uint8Array(buf, ctPtr + STRING_HEADER, ctLen));

    const bodyPtr = mem.getUint32(respPtr + 2 * VALUE_SLOT + 4, true);
    const bodyLen = mem.getUint32(bodyPtr, true);
    const body = textDecoder.decode(new Uint8Array(buf, bodyPtr + STRING_HEADER, bodyLen));

    return new Response(body, {
      status,
      headers: { "content-type": contentType },
    });
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
