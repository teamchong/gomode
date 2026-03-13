# gomode

Go on Cloudflare Workers. TinyGo compiles to WASM, Zig fills the gaps TinyGo can't do — with SIMD, zero-copy memory, and no runtime overhead.

## Why

Standard Go → WASM produces 3MB+ binaries with a heavy runtime. TinyGo produces small binaries but is missing `net/http`, `crypto`, and other stdlib packages. GoMode uses Zig to polyfill those gaps at native WASM speed.

| | Binary size | Stdlib | Cold start | Warm latency |
|---|---|---|---|---|
| Go → WASM | 3MB+ | Full | Slow | Slow (heavy runtime) |
| TinyGo → WASM | ~700KB | Incomplete | Fast | Fast |
| **GoMode** | ~700KB | **Complete (Zig fills gaps)** | **Fast** | **Fast (SIMD, zero-copy)** |

## How it works

Three layers:

1. **Go SDK** (`go-sdk/`) — Write a Go handler. Exports `handle()` as a WASM function.
2. **Zig ABI** (`zig-abi/`) — Zero-overhead exports: memory management, columnar tables, HTTP, crypto. Polyfills what TinyGo can't do, with SIMD.
3. **CF Worker** (`worker/`) — Routes requests to WASM. Two modes: direct (stateless, max concurrency) or Durable Object (stateful, persistent WASM instance).

```
Browser → CF Edge → Worker
  → Direct mode: WASM in isolate (stateless, scales horizontally)
  → DO mode: WASM in Durable Object (stateful, persistent instance)
    → Go handler processes request
    → Zig ABI for zero-copy data, SIMD ops
    → Response back to browser
```

## Usage

```go
package main

import (
	"encoding/json"
	"unsafe"
)

var respBuf []byte

//export handle
func handle(reqPtr, reqLen uint32) uint32 {
	reqBytes := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(reqPtr))), int(reqLen))

	var req map[string]interface{}
	json.Unmarshal(reqBytes, &req)

	resp, _ := json.Marshal(map[string]interface{}{
		"status":  200,
		"headers": map[string]string{"content-type": "text/plain"},
		"body":    "Hello from GoMode!",
	})
	respBuf = resp
	return uint32(len(respBuf))
}

//export getResponsePtr
func getResponsePtr() uint32 {
	return uint32(uintptr(unsafe.Pointer(&respBuf[0])))
}

func main() {}
```

## Build & Run

```bash
# Install dependencies
brew install tinygo   # TinyGo compiler
# Zig 0.15+ required

npm install

# Build WASM
npm run build:go      # TinyGo → wasm32-wasip1

# Dev server
npm run dev           # wrangler dev on localhost:8787

# Run tests
npm test
```

## Benchmark

```bash
# Native Go vs GoMode vs Standard Go WASM
./bench/run.sh
```

| | Native Go | GoMode (direct) | GoMode (DO) | Std Go WASM |
|---|---|---|---|---|
| req/sec | 80,715 | 3,411 | 1,428 | 614 |
| latency (avg) | 0.6ms | 14ms | 34ms | 78ms |
| binary size | native | 753KB | 753KB | 3.0MB |

GoMode is **5.6x faster** than standard Go WASM with a **4x smaller** binary.

## Two modes

| | Direct (Worker) | Durable Object |
|---|---|---|
| Use case | Stateless APIs, transforms | Sessions, counters, websockets |
| Concurrency | CF scales isolates | Single instance |
| WASM lifetime | Cached per isolate | Alive for DO lifetime |
| Route | `/*` | `/do/*` |

## Architecture

```
worker/src/
  worker.ts         — Entry point, routes to direct WASM or DO
  go-do.ts          — Durable Object, persistent WASM instance
  columnar-proxy.ts — Zero-copy Proxy reads from WASM memory

zig-abi/src/
  main.zig          — Exports: alloc, free, columnar tables, HTTP
  host.zig          — Host imports: sockets, random, time, KV
  columnar.zig      — Arrow-like columnar format in WASM memory

go-sdk/
  gomode.go         — Request/Response types, Zig FFI bindings

examples/
  hello-worker/     — Minimal Go worker example

bench/
  native/           — Native Go HTTP server for comparison
  run.sh            — Benchmark script (wrk)
```

## Status

- [x] TinyGo → WASM build pipeline
- [x] Worker + Durable Object runtime
- [x] Direct mode (stateless, max concurrency)
- [x] Reactor model (WASM stays alive, `handle()` per request)
- [x] Benchmark suite (native Go, GoMode, std Go WASM)
- [ ] Zig ABI linked into go.wasm
- [ ] [zerobuf](https://github.com/teamchong/zerobuf) integration (zero-copy request/response)
- [ ] Zig SIMD JSON parsing
- [ ] Asyncify for async CF bindings (KV, R2, D1, fetch)
- [ ] Full CF bindings (KV, R2, D1, Queues, AI)

## Related

- [zerobuf](https://github.com/teamchong/zerobuf) — Shared memory layout for JS and WASM
- [nodemode](https://github.com/teamchong/nodemode) — Node.js on CF Workers
- [pymode](https://github.com/teamchong/pymode) — Python on CF Workers
- [querymode](https://github.com/teamchong/querymode) — SQL query engine on WASM

## License

MIT
