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
import { WasiFs, buildWasiImports, initSchema, preloadFromR2, flushToR2 } from "./wasi";

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
  FS_BUCKET?: R2Bucket;
  KV?: KVNamespace;
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
  private wasiFs: WasiFs;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.wasiFs = new WasiFs();
  }

  private async initWasm(): Promise<void> {
    // Initialize SQLite schema and pre-load files from R2
    if (this.env.FS_BUCKET) {
      const sql = this.state.storage.sql;
      initSchema(sql);
      await preloadFromR2(this.wasiFs, this.env.FS_BUCKET, this.state.id.toString(), sql);
    }

    const instance = await WebAssembly.instantiate(goWasmModule, {
      wasi_snapshot_preview1: buildWasiImports(
        () => this.wasmExports!.memory,
        this.wasiFs,
        "do"
      ),
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

      const hdrsField = raw.rawHeaders || "0";
      const hdrsNlIdx = hdrsField.indexOf("\n");
      const callIndex = parseInt(hdrsNlIdx >= 0 ? hdrsField.slice(0, hdrsNlIdx) : hdrsField, 10);
      const customHdrs = hdrsNlIdx >= 0 ? hdrsField.slice(hdrsNlIdx + 1) : "";

      const fetchInit: RequestInit = { method: fetchMethod };
      const fetchHdrs: Record<string, string> = {};
      if (fetchContentType) {
        fetchHdrs["Content-Type"] = fetchContentType;
      }
      if (customHdrs) {
        for (const line of customHdrs.split("\n")) {
          const ci = line.indexOf(": ");
          if (ci > 0) {
            fetchHdrs[line.slice(0, ci)] = line.slice(ci + 2);
          }
        }
      }
      if (Object.keys(fetchHdrs).length > 0) {
        fetchInit.headers = fetchHdrs;
      }
      if (fetchBodyStr && fetchMethod !== "GET" && fetchMethod !== "HEAD") {
        fetchInit.body = fetchBodyStr;
      }

      let fetchResp: Response;
      if (fetchMethod.startsWith("__")) {
        fetchResp = await handleBindingOp(fetchMethod, fetchUrl, fetchBodyStr, this.env);
      } else {
        fetchResp = await fetch(fetchUrl, fetchInit).catch((err) =>
          new Response(String(err), { status: 502, headers: { "content-type": "text/plain" } })
        );
      }
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

    // Flush dirty files to R2 after handler completes
    if (this.env.FS_BUCKET && this.wasiFs.dirty.size > 0 || this.wasiFs.deleted.size > 0) {
      await flushToR2(this.wasiFs, this.env.FS_BUCKET!, this.state.id.toString(), this.state.storage.sql);
    }

    const nullBodyStatus = raw.status === 101 || raw.status === 204 || raw.status === 205 || raw.status === 304;
    if (nullBodyStatus) {
      return new Response(null, { status: raw.status, headers: raw.headers });
    }
    // Stream large bodies in chunks to reduce peak memory
    if (raw.bodyBytes.byteLength > 65536) {
      const bytes = raw.bodyBytes;
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.byteLength; i += 16384) {
            controller.enqueue(bytes.subarray(i, Math.min(i + 16384, bytes.byteLength)));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: raw.status, headers: raw.headers });
    }
    return new Response(raw.bodyBytes, { status: raw.status, headers: raw.headers });
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
      const isBinary = typeof event.data !== "string";
      const msg = isBinary ? new TextDecoder().decode(event.data as ArrayBuffer) : event.data;
      const method = isBinary ? "WEBSOCKET_BINARY" : "WEBSOCKET";
      const reqPtr = this.buildRequest(exports, method, pathAndQuery, msg, headers);
      try {
        const respPtr = exports.handle_zerobuf(reqPtr);
        const raw = readRawResponse(exports, respPtr);
        // If handler writes a response body, send it back as WS message
        if (raw.bodyBytes.byteLength > 0) {
          // Send binary if the incoming was binary, or if handler sets X-Ws-Binary header
          if (isBinary || raw.headers.get("x-ws-binary") === "true") {
            server.send(raw.bodyBytes);
          } else {
            server.send(textDecoder.decode(raw.bodyBytes));
          }
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

  // WASI imports are now provided by the shared wasi.ts module
}

async function handleBindingOp(method: string, key: string, body: string, env: Env): Promise<Response> {
  try {
    switch (method) {
      case "__KV_GET": {
        if (!env.KV) return new Response("KV binding not configured", { status: 500 });
        const value = await env.KV.get(key);
        if (value === null) return new Response("", { status: 404 });
        return new Response(value, { status: 200 });
      }
      case "__KV_PUT": {
        if (!env.KV) return new Response("KV binding not configured", { status: 500 });
        await env.KV.put(key, body);
        return new Response("ok", { status: 200 });
      }
      case "__KV_DELETE": {
        if (!env.KV) return new Response("KV binding not configured", { status: 500 });
        await env.KV.delete(key);
        return new Response("ok", { status: 200 });
      }
      case "__KV_LIST": {
        if (!env.KV) return new Response("KV binding not configured", { status: 500 });
        const list = await env.KV.list({ prefix: key || undefined });
        const keys = list.keys.map((k: { name: string }) => k.name);
        return new Response(JSON.stringify(keys), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      default:
        return new Response(`unknown binding op: ${method}`, { status: 400 });
    }
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
}
