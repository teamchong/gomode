/**
 * GoMode Worker — Fan-out architecture.
 *
 * JS orchestrates all async work (fetch, KV, R2) in parallel,
 * writes results into WASM memory, then calls the Go handler
 * with everything pre-fetched. WASM stays pure compute.
 *
 *   /do/*  → Durable Object (stateful, persistent WASM instance)
 *   /*     → Direct WASM execution (stateless, max concurrency)
 */

export { GoDO } from "./go-do";
import goWasmModule from "./go.wasm";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// zerobuf constants
const VALUE_SLOT = 16;
const TAG_I32 = 2;
const TAG_STRING = 4;
const TAG_BYTES = 8;
const STRING_HEADER = 4;

// Pre-encoded HTTP methods
const METHOD_BYTES: Record<string, Uint8Array> = {
  GET: new Uint8Array([71, 69, 84]),
  POST: new Uint8Array([80, 79, 83, 84]),
  PUT: new Uint8Array([80, 85, 84]),
  DELETE: new Uint8Array([68, 69, 76, 69, 84, 69]),
  PATCH: new Uint8Array([80, 65, 84, 67, 72]),
  HEAD: new Uint8Array([72, 69, 65, 68]),
  OPTIONS: new Uint8Array([79, 80, 84, 73, 79, 78, 83]),
};

interface Env {
  GO_DO: DurableObjectNamespace;
  [key: string]: unknown;
}

interface GoWasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  handle_zerobuf: (reqBase: number) => number;
  malloc: (size: number) => number;
  asyncify_start_unwind: (dataAddr: number) => void;
  asyncify_stop_unwind: () => void;
  asyncify_start_rewind: (dataAddr: number) => void;
  asyncify_stop_rewind: () => void;
  asyncify_get_state: () => number;
}

let wasmExports: GoWasmExports | null = null;
let initPromise: Promise<void> | null = null;
let reqScratch = 0;

// Max request scratch: 8 slots (method, path, body, + 5 fan-out results) + 4KB data
const REQ_SCRATCH_SIZE = 8 * VALUE_SLOT + 4096;

// ============================================================================
// Asyncify runtime — enables Go code to call async JS functions (fetch, etc.)
// ============================================================================

const ASYNCIFY_DATA_SIZE = 16384; // 16KB stack save buffer
let asyncifyDataAddr = 0;
let asyncifyResuming = false;
let pendingFetchPromise: Promise<{ status: number; contentType: string; body: string }> | null = null;
let fetchResponsePtr = 0;

function resetAsyncifyData(): void {
  const mem = new DataView(wasmExports!.memory.buffer);
  mem.setInt32(asyncifyDataAddr, asyncifyDataAddr + 8, true);
  mem.setInt32(asyncifyDataAddr + 4, asyncifyDataAddr + ASYNCIFY_DATA_SIZE, true);
}

/** Write a fetch response into WASM memory as zerobuf slots for Go to read. */
function writeFetchResponseToWasm(resp: { status: number; contentType: string; body: string }): number {
  const ctBytes = textEncoder.encode(resp.contentType);
  const bodyBytes = textEncoder.encode(resp.body);
  const totalSize = 3 * VALUE_SLOT + STRING_HEADER + ctBytes.length + 4 + STRING_HEADER + bodyBytes.length + 4;
  const ptr = wasmExports!.malloc(totalSize);

  const mem = new DataView(wasmExports!.memory.buffer);
  const u8 = new Uint8Array(wasmExports!.memory.buffer);

  // Slot 0: status (i32)
  writeI32Slot(mem, ptr, resp.status);

  // Slot 1: content-type (string)
  let dataOffset = ptr + 3 * VALUE_SLOT;
  dataOffset = writeStringSlot(mem, u8, ptr + VALUE_SLOT, dataOffset, ctBytes);

  // Slot 2: body (string)
  writeStringSlot(mem, u8, ptr + 2 * VALUE_SLOT, dataOffset, bodyBytes);

  return ptr;
}

/** Call handle_zerobuf with Asyncify suspend/resume support. */
async function callWasmAsync(reqPtr: number): Promise<number> {
  let result = wasmExports!.handle_zerobuf(reqPtr);

  while (pendingFetchPromise) {
    wasmExports!.asyncify_stop_unwind();

    const fetchResult = await pendingFetchPromise;
    pendingFetchPromise = null;

    fetchResponsePtr = writeFetchResponseToWasm(fetchResult);

    asyncifyResuming = true;
    resetAsyncifyData();
    wasmExports!.asyncify_start_rewind(asyncifyDataAddr);
    result = wasmExports!.handle_zerobuf(reqPtr);
  }

  return result;
}

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
    env: {
      __gomode_fetch(
        urlPtr: number, urlLen: number,
        methodPtr: number, methodLen: number,
        bodyPtr: number, bodyLen: number,
        ctPtr: number, ctLen: number,
      ): number {
        if (asyncifyResuming) {
          asyncifyResuming = false;
          wasmExports!.asyncify_stop_rewind();
          return fetchResponsePtr;
        }

        const buf = wasmExports!.memory.buffer;
        const url = textDecoder.decode(new Uint8Array(buf, urlPtr, urlLen));
        const method = textDecoder.decode(new Uint8Array(buf, methodPtr, methodLen));
        const body = bodyLen > 0 ? textDecoder.decode(new Uint8Array(buf, bodyPtr, bodyLen)) : null;
        const ct = ctLen > 0 ? textDecoder.decode(new Uint8Array(buf, ctPtr, ctLen)) : undefined;

        const headers: Record<string, string> = {};
        if (ct) headers["content-type"] = ct;

        pendingFetchPromise = fetch(url, { method, body, headers })
          .then(async (resp) => ({
            status: resp.status,
            contentType: resp.headers.get("content-type") || "",
            body: await resp.text(),
          }))
          .catch((err) => ({
            status: 0,
            contentType: "text/plain",
            body: String(err),
          }));

        resetAsyncifyData();
        wasmExports!.asyncify_start_unwind(asyncifyDataAddr);
        return 0;
      },
    },
  });

  wasmExports = instance.exports as unknown as GoWasmExports;

  try {
    wasmExports._start();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("exit code: 0") && !msg.includes("proc_exit")) throw e;
  }

  reqScratch = wasmExports.malloc(REQ_SCRATCH_SIZE);

  // Allocate Asyncify data buffer for suspend/resume
  asyncifyDataAddr = wasmExports.malloc(ASYNCIFY_DATA_SIZE);
  resetAsyncifyData();
}

async function ensureWasm(): Promise<GoWasmExports> {
  if (!wasmExports) {
    if (!initPromise) initPromise = initWasm();
    await initPromise;
  }
  return wasmExports!;
}

// ============================================================================
// Zerobuf slot writers — write directly into WASM memory
// ============================================================================

/** Write a string slot. Returns next aligned data offset. */
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

/** Write a bytes slot (for fan-out results). Returns next aligned data offset. */
function writeBytesSlot(
  mem: DataView, u8: Uint8Array,
  slotOffset: number, dataOffset: number,
  data: Uint8Array
): number {
  mem.setUint32(dataOffset, data.byteLength, true);
  u8.set(data, dataOffset + STRING_HEADER);
  mem.setUint8(slotOffset, TAG_BYTES);
  mem.setUint32(slotOffset + 4, dataOffset, true);
  return (dataOffset + STRING_HEADER + data.byteLength + 3) & ~3;
}

/** Write an i32 slot. */
function writeI32Slot(mem: DataView, slotOffset: number, value: number): void {
  mem.setUint8(slotOffset, TAG_I32);
  mem.setInt32(slotOffset + 4, value, true);
}

// ============================================================================
// Request builder — writes zerobuf request with optional fan-out data
// ============================================================================

/**
 * Fan-out data item. JS fetches these in parallel before calling WASM.
 * Each becomes a zerobuf slot in the request that Go can read.
 */
interface FanOutItem {
  type: "string" | "bytes" | "i32";
  value: string | Uint8Array | number;
}

/**
 * Build a zerobuf request in WASM memory.
 *
 * Slot layout:
 *   [0] method (string)
 *   [1] path (string)
 *   [2] body (string, from request body)
 *   [3..N] fan-out results (string/bytes/i32)
 *
 * Go handler reads slots by index — slot 3 is the first fan-out result.
 */
function buildRequest(
  exports: GoWasmExports,
  method: string, pathname: string,
  body?: string | null,
  fanout?: FanOutItem[]
): number {
  const memory = exports.memory;
  const buf = memory.buffer;
  const mem = new DataView(buf);
  const u8 = new Uint8Array(buf);

  const numSlots = 3 + (fanout?.length ?? 0);
  let dataOffset = reqScratch + numSlots * VALUE_SLOT;

  // Slot 0: method
  const methodBytes = METHOD_BYTES[method] || textEncoder.encode(method);
  dataOffset = writeStringSlot(mem, u8, reqScratch, dataOffset, methodBytes);

  // Slot 1: path
  const pathBytes = textEncoder.encode(pathname);
  dataOffset = writeStringSlot(mem, u8, reqScratch + VALUE_SLOT, dataOffset, pathBytes);

  // Slot 2: body (empty string if no body)
  const bodyBytes = body ? textEncoder.encode(body) : new Uint8Array(0);
  dataOffset = writeStringSlot(mem, u8, reqScratch + 2 * VALUE_SLOT, dataOffset, bodyBytes);

  // Slots 3+: fan-out results
  if (fanout) {
    for (let i = 0; i < fanout.length; i++) {
      const slot = reqScratch + (3 + i) * VALUE_SLOT;
      const item = fanout[i];
      if (item.type === "string") {
        const bytes = textEncoder.encode(item.value as string);
        dataOffset = writeStringSlot(mem, u8, slot, dataOffset, bytes);
      } else if (item.type === "bytes") {
        dataOffset = writeBytesSlot(mem, u8, slot, dataOffset, item.value as Uint8Array);
      } else {
        writeI32Slot(mem, slot, item.value as number);
      }
    }
  }

  return reqScratch;
}

/** Read response from WASM memory. */
function readResponse(exports: GoWasmExports, respPtr: number): Response {
  const buf = exports.memory.buffer;
  const mem = new DataView(buf);

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

// ============================================================================
// Fan-out: JS does all async work, passes results to WASM
// ============================================================================

/**
 * Route handler with fan-out support.
 *
 * Define routes that need async data. JS fetches everything in parallel,
 * then calls WASM with all data pre-loaded. WASM does pure compute.
 *
 * Example usage in a real app:
 *   /api/dashboard → fan-out to [KV.get("user"), fetch(analyticsAPI), D1.query("SELECT...")]
 *                  → all 3 resolve in parallel
 *                  → WASM receives 3 extra slots with the results
 *                  → Go handler transforms/combines data, returns response
 */
async function handleWithFanout(
  exports: GoWasmExports,
  request: Request,
  pathname: string,
  env: Env
): Promise<Response> {
  // Fan-out: fetch all async data needed for this route in parallel
  const fanout = await resolveFanout(pathname, request, env);

  // Read request body if present
  let body: string | null = null;
  if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
    body = await request.text();
  }

  // Build request with fan-out results already in WASM memory
  const reqPtr = buildRequest(exports, request.method, pathname, body, fanout);

  // Call WASM with Asyncify support — suspends if Go calls http.Get() etc.
  const respPtr = await callWasmAsync(reqPtr);

  return readResponse(exports, respPtr);
}

/**
 * Resolve fan-out data for a route. Override this for your app's routes.
 * Returns an array of pre-fetched data items that become zerobuf slots 3+.
 *
 * All promises run in parallel via Promise.all.
 */
async function resolveFanout(
  _pathname: string,
  _request: Request,
  _env: Env
): Promise<FanOutItem[] | undefined> {
  // No fan-out needed for the example routes.
  // Real app would match routes and fetch data:
  //
  // if (pathname === "/api/dashboard") {
  //   const [user, stats] = await Promise.all([
  //     env.KV.get("user:123"),
  //     fetch("https://api.example.com/stats").then(r => r.text()),
  //   ]);
  //   return [
  //     { type: "string", value: user ?? "" },
  //     { type: "string", value: stats },
  //   ];
  // }
  return undefined;
}

// ============================================================================
// Entry point
// ============================================================================

function extractPathname(url: string): string {
  const schemeEnd = url.indexOf("//");
  if (schemeEnd === -1) return url;
  const pathStart = url.indexOf("/", schemeEnd + 2);
  if (pathStart === -1) return "/";
  const queryStart = url.indexOf("?", pathStart);
  return queryStart === -1 ? url.slice(pathStart) : url.slice(pathStart, queryStart);
}

/** Extract path + query string (e.g., "/sha256?input=hello") for WASM. */
function extractPathAndQuery(url: string): string {
  const schemeEnd = url.indexOf("//");
  if (schemeEnd === -1) return url;
  const pathStart = url.indexOf("/", schemeEnd + 2);
  if (pathStart === -1) return "/";
  return url.slice(pathStart);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = extractPathname(request.url);

    if (pathname.startsWith("/do/")) {
      const id = env.GO_DO.idFromName("singleton");
      const durable = env.GO_DO.get(id);
      const innerPath = pathname.slice(3) || "/";
      const innerUrl = request.url.replace(pathname, innerPath);
      return durable.fetch(new Request(innerUrl, request));
    }

    const exports = await ensureWasm();
    const pathAndQuery = extractPathAndQuery(request.url);
    return handleWithFanout(exports, request, pathAndQuery, env);
  },
};
