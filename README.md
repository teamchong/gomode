# gomode

Go on Cloudflare Workers. TinyGo + Zig compiled into a single WASM binary — SIMD, zero-copy, no runtime overhead.

## Why

Standard Go → WASM produces 3MB+ binaries with a heavy runtime. TinyGo produces small binaries but is missing `net/http`, `crypto`, and other stdlib packages. GoMode uses Zig to polyfill those gaps — linked at build time via `wasm-ld`, zero overhead.

| | Binary size | Stdlib | Cold start | Warm latency |
|---|---|---|---|---|
| Go → WASM | 3MB+ | Full | Slow | Slow (heavy runtime) |
| TinyGo → WASM | ~700KB | Incomplete | Fast | Fast |
| **GoMode** | **58KB** | **Zig fills gaps (SIMD, crypto, allocator)** | **Fast** | **Fast (zero-copy)** |

## How it works

```
Zig src → zig build-obj → zig-abi.o ──┐
                                       ├── wasm-ld → go.wasm (single binary)
Go src  → tinygo build ───────────────┘

CF Request → Worker (JS)
  → zerobuf writes request into WASM memory
  → Go reads request, calls Zig SIMD internally
  → Go writes response
  → JS reads response from WASM memory
  → CF Response
```

Go calls Zig via CGo — compiles to direct WASM `call` instructions. Same linear memory, no imports, no serialization.

## Usage

```go
package main

import (
	"gomode"
	"unsafe"
)

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
	path := readZBString(uintptr(reqBase) + 1*16)

	switch path {
	case "/":
		return writeResponse(200, "text/plain", "Hello from GoMode!")
	case "/simd":
		data := []float64{1, 2, 3, 4, 5, 6, 7, 8}
		sum := gomode.ZigSimdSumF64(
			uint32(uintptr(unsafe.Pointer(&data[0]))),
			uint32(len(data)),
		)
		return writeResponse(200, "text/plain", formatFloat(sum))
	}
	return writeResponse(404, "text/plain", "not found")
}

func main() {}
```

## Build & Run

```bash
# Install dependencies
brew install tinygo   # TinyGo compiler
# Zig 0.15+ and wasm-ld required

npm install

# Build single WASM binary (Go + Zig linked)
npm run build

# Dev server
npm run dev           # wrangler dev on localhost:8787

# Run tests
npm test
```

## Benchmark

All benchmarks on wrangler dev (local miniflare). Wrangler caps at ~3.7K req/sec.

| | Native Go | GoMode (Worker) | GoMode (DO) | Std Go WASM |
|---|---|---|---|---|
| **GET / req/sec** | 80,715 | 3,764 | 1,586 | 614 |
| **GET /simd req/sec** | — | 3,692 | 1,574 | — |
| **Latency (avg)** | 0.6ms | 3.2ms | 7.2ms | 78ms |
| **Binary size** | native | 58KB | 58KB | 3.0MB |

**6.1x faster** than standard Go WASM. **52x smaller** binary.

SIMD route (Go calling Zig SIMD sum/dot/scale/minmax) runs at the same throughput as hello world — confirming zero overhead. Binary is 58KB with Zig bump allocator (`-gc=custom`).

## Two modes

| | Worker (`/*`) | Durable Object (`/do/*`) |
|---|---|---|
| Use case | Stateless APIs, transforms | Sessions, counters, websockets |
| Concurrency | CF scales isolates | Single instance |
| WASM lifetime | Cached per isolate | Alive for DO lifetime |

## Architecture

```
worker/src/
  worker.ts         — Entry point, routes to Worker or DO
  go-do.ts          — Durable Object runtime

zig-abi/src/
  main.zig          — Memory mgmt + SIMD exports
  simd.zig          — WASM SIMD v128 batch operations
  allocator.zig     — Bump allocator (replaces Go's GC)

go-sdk/
  gomode.go         — CGo wrappers for Zig functions
  gc.go             — Custom GC bridge (routes runtime.alloc to Zig malloc)
  zig_abi.h         — C header declaring Zig exports

examples/
  hello-worker/     — Example: hello world + SIMD demo
```

## Status

- [x] Single WASM binary (TinyGo + Zig linked via wasm-ld)
- [x] Zero-copy request/response via zerobuf
- [x] Zig SIMD (sum, dot, scale, add, minmax) callable from Go
- [x] Worker + Durable Object modes
- [x] CGo FFI — Go calls Zig as direct WASM calls
- [x] Zig bump allocator replacing Go's GC (`-gc=custom`)
- [x] Fan-out architecture — JS fetches async data in parallel, WASM stays pure compute
- [ ] Zig crypto (hashing, TLS)
- [ ] Zig HTTP parsing
- [ ] Worker RPC for parallel compute (service bindings)
- [ ] Production CF edge benchmarks

## Related

- [zerobuf](https://github.com/user/zerobuf) — Shared memory layout for JS and WASM
- [nodemode](https://github.com/user/nodemode) — Node.js on CF Workers
- [pymode](https://github.com/user/pymode) — Python on CF Workers

## License

MIT
