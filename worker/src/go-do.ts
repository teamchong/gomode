/**
 * GoDO — Durable Object with persistent WASM instance.
 *
 * Same request/response protocol as worker.ts: full zerobuf slots,
 * multi-fetch two-phase, zero-copy response bytes.
 *
 * Key difference: WASM instance persists for the DO lifetime,
 * so Go globals (maps, counters, state) survive across requests.
 */

import goWasmModule from "./go.wasm";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const VALUE_SLOT = 16;
const TAG_I32 = 2;
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

// 10 slots (method, path, body, headers, fetch-result, fetch-url, + 4 fan-out) + 8KB data
const REQ_SCRATCH_SIZE = 10 * VALUE_SLOT + 8192;

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

function writeI32Slot(mem: DataView, slotOffset: number, value: number): void {
  mem.setUint8(slotOffset, TAG_I32);
  mem.setInt32(slotOffset + 4, value, true);
}

interface WasmResponse {
  status: number;
  contentType: string;
  bodyBytes: Uint8Array;
  rawHeaders: string;
  headers: Headers;
}

function readRawResponse(exports: GoWasmExports, respPtr: number): WasmResponse {
  const buf = exports.memory.buffer;
  const mem = new DataView(buf);

  const status = mem.getInt32(respPtr + 4, true);

  const ctPtr = mem.getUint32(respPtr + VALUE_SLOT + 4, true);
  const ctLen = mem.getUint32(ctPtr, true);
  const contentType = textDecoder.decode(new Uint8Array(buf, ctPtr + STRING_HEADER, ctLen));

  const bodyPtr = mem.getUint32(respPtr + 2 * VALUE_SLOT + 4, true);
  const bodyLen = mem.getUint32(bodyPtr, true);
  const bodyBytes = new Uint8Array(buf, bodyPtr + STRING_HEADER, bodyLen).slice();

  let rawHeaders = "";
  const respHeaders = new Headers();
  if (status >= 0) {
    respHeaders.set("content-type", contentType);
  }
  const hdrsTag = mem.getUint8(respPtr + 3 * VALUE_SLOT);
  if (hdrsTag === TAG_STRING) {
    const hdrsDataPtr = mem.getUint32(respPtr + 3 * VALUE_SLOT + 4, true);
    const hdrsLen = mem.getUint32(hdrsDataPtr, true);
    if (hdrsLen > 0) {
      rawHeaders = textDecoder.decode(new Uint8Array(buf, hdrsDataPtr + STRING_HEADER, hdrsLen));
      for (const line of rawHeaders.split("\n")) {
        const colonIdx = line.indexOf(": ");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).toLowerCase();
          const val = line.slice(colonIdx + 2);
          if (key !== "content-type") {
            respHeaders.append(key, val);
          }
        }
      }
    }
  }

  return { status, contentType, bodyBytes, rawHeaders, headers: respHeaders };
}

function writeFetchResponseToWasm(exports: GoWasmExports, resp: { status: number; contentType: string; body: string }): number {
  const ctBytes = textEncoder.encode(resp.contentType);
  const bodyBytes = textEncoder.encode(resp.body);
  const totalSize = 3 * VALUE_SLOT + STRING_HEADER + ctBytes.length + 4 + STRING_HEADER + bodyBytes.length + 4;
  const ptr = exports.malloc(totalSize);

  const mem = new DataView(exports.memory.buffer);
  const u8 = new Uint8Array(exports.memory.buffer);

  writeI32Slot(mem, ptr, resp.status);

  let dataOffset = ptr + 3 * VALUE_SLOT;
  dataOffset = writeStringSlot(mem, u8, ptr + VALUE_SLOT, dataOffset, ctBytes);
  writeStringSlot(mem, u8, ptr + 2 * VALUE_SLOT, dataOffset, bodyBytes);

  return ptr;
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

    this.reqScratch = this.wasmExports.malloc(REQ_SCRATCH_SIZE);
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
    const pathAndQuery = pathStart === -1 ? "/" : url.slice(pathStart);

    // WebSocket upgrade
    if (request.headers.get("upgrade") === "websocket") {
      return this.handleWebSocket(exports, pathAndQuery, request.headers);
    }

    // Read request body
    let body: string | null = null;
    if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
      body = await request.text();
    }

    // Build zerobuf request
    const reqPtr = this.buildRequest(exports, request.method, pathAndQuery, body, request.headers);

    // Call WASM handler with multi-fetch loop
    let respPtr: number;
    try {
      respPtr = exports.handle_zerobuf(reqPtr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(`panic: ${msg}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    let raw = readRawResponse(exports, respPtr);

    while (raw.status === -1) {
      // Body field: "URL\nfetchBody", Content-type field: "method\nfetchContentType"
      const bodyField = textDecoder.decode(raw.bodyBytes);
      const nlIdx = bodyField.indexOf("\n");
      const fetchUrl = (nlIdx >= 0 ? bodyField.slice(0, nlIdx) : bodyField).trim();
      const fetchBodyStr = nlIdx >= 0 ? bodyField.slice(nlIdx + 1) : "";

      const ctField = raw.contentType;
      const ctNlIdx = ctField.indexOf("\n");
      const fetchMethod = (ctNlIdx >= 0 ? ctField.slice(0, ctNlIdx) : ctField).trim() || "GET";
      const fetchContentType = ctNlIdx >= 0 ? ctField.slice(ctNlIdx + 1) : "";

      const callIndex = parseInt(raw.rawHeaders || "0", 10);

      const fetchInit: RequestInit = { method: fetchMethod };
      if (fetchBodyStr && fetchMethod !== "GET" && fetchMethod !== "HEAD") {
        fetchInit.body = fetchBodyStr;
        if (fetchContentType) {
          fetchInit.headers = { "Content-Type": fetchContentType };
        }
      }

      const fetchResp = await fetch(fetchUrl, fetchInit).catch((err) =>
        new Response(String(err), { status: 502, headers: { "content-type": "text/plain" } })
      );
      const fetchBody = await fetchResp.text();
      const fetchCt = fetchResp.headers.get("content-type") || "";

      const fetchResultPtr = writeFetchResponseToWasm(exports, {
        status: fetchResp.status,
        contentType: fetchCt,
        body: fetchBody,
      });

      const reqPtr2 = this.buildRequest(exports, request.method, pathAndQuery, body, request.headers);
      const mem = new DataView(exports.memory.buffer);

      mem.setUint8(reqPtr2 + 4 * VALUE_SLOT, TAG_STRING);
      mem.setUint32(reqPtr2 + 4 * VALUE_SLOT + 4, fetchResultPtr, true);
      writeI32Slot(mem, reqPtr2 + 5 * VALUE_SLOT, callIndex);

      try {
        respPtr = exports.handle_zerobuf(reqPtr2);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(`panic: ${msg}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      raw = readRawResponse(exports, respPtr);
    }

    const nullBodyStatus = raw.status === 101 || raw.status === 204 || raw.status === 205 || raw.status === 304;
    return new Response(nullBodyStatus ? null : raw.bodyBytes, { status: raw.status, headers: raw.headers });
  }

  private handleWebSocket(
    exports: GoWasmExports,
    pathAndQuery: string,
    headers: Headers
  ): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    server.addEventListener("message", (event: MessageEvent) => {
      const msg = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      const reqPtr = this.buildRequest(exports, "WEBSOCKET", pathAndQuery, msg, headers);
      try {
        const respPtr = exports.handle_zerobuf(reqPtr);
        const raw = readRawResponse(exports, respPtr);
        // If handler writes a response body, send it back as WS message
        if (raw.bodyBytes.byteLength > 0) {
          server.send(textDecoder.decode(raw.bodyBytes));
        }
        // Check for close signal
        if (raw.headers.get("x-ws-close") === "true") {
          server.close(1000, "closed by handler");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        server.send(`error: ${msg}`);
        server.close(1011, "handler panic");
      }
    });

    server.addEventListener("close", () => {
      // Notify Go handler of disconnect
      const reqPtr = this.buildRequest(exports, "WEBSOCKET_CLOSE", pathAndQuery, null, headers);
      try {
        exports.handle_zerobuf(reqPtr);
      } catch (_) {
        // Ignore errors on close
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private buildRequest(
    exports: GoWasmExports,
    method: string, pathname: string,
    body: string | null,
    headers: Headers
  ): number {
    const buf = exports.memory.buffer;
    const mem = new DataView(buf);
    const u8 = new Uint8Array(buf);

    const numSlots = 6;
    let dataOffset = this.reqScratch + numSlots * VALUE_SLOT;

    // Slot 0: method
    const methodBytes = METHOD_BYTES[method] || textEncoder.encode(method);
    dataOffset = writeStringSlot(mem, u8, this.reqScratch, dataOffset, methodBytes);

    // Slot 1: path+query
    const pathBytes = textEncoder.encode(pathname);
    dataOffset = writeStringSlot(mem, u8, this.reqScratch + VALUE_SLOT, dataOffset, pathBytes);

    // Slot 2: body
    const bodyBytes = body ? textEncoder.encode(body) : new Uint8Array(0);
    dataOffset = writeStringSlot(mem, u8, this.reqScratch + 2 * VALUE_SLOT, dataOffset, bodyBytes);

    // Slot 3: headers
    let headerStr = "";
    headers.forEach((value, key) => {
      headerStr += key + ": " + value + "\n";
    });
    const headerBytes = textEncoder.encode(headerStr);
    dataOffset = writeStringSlot(mem, u8, this.reqScratch + 3 * VALUE_SLOT, dataOffset, headerBytes);

    // Slot 4: fetch result (zeroed)
    mem.setUint8(this.reqScratch + 4 * VALUE_SLOT, 0);
    mem.setUint32(this.reqScratch + 4 * VALUE_SLOT + 4, 0, true);

    // Slot 5: fetch call index (zeroed)
    mem.setUint8(this.reqScratch + 5 * VALUE_SLOT, 0);
    mem.setUint32(this.reqScratch + 5 * VALUE_SLOT + 4, 0, true);

    return this.reqScratch;
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
            console.log("[gomode:do:stderr]", textDecoder.decode(new Uint8Array(memory.buffer, ptr, len)));
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
