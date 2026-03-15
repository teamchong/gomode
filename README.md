# GoMode

Standard Go HTTP servers on Cloudflare Workers. Zero code changes.

Write normal `net/http` handlers, GoMode compiles them to WASM and runs them on the edge — with Zig SIMD for fast numeric computation, outbound `http.Get()`, and Durable Objects for state.

## Quick Start

```go
package main

import (
    "encoding/json"
    "gomode"
    "net/http"
)

func main() {
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Hello from GoMode!"))
    })

    http.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
        data := []float64{1, 2, 3, 4, 5, 6, 7, 8}
        sum := gomode.SumF64(data)           // Zig SIMD
        min, max := gomode.MinMaxF64(data)   // Zig SIMD

        json.NewEncoder(w).Encode(map[string]float64{
            "sum": sum, "min": min, "max": max,
        })
    })

    http.HandleFunc("/proxy", func(w http.ResponseWriter, r *http.Request) {
        // Outbound fetch — works transparently
        resp, err := http.Get("https://api.example.com/data")
        if err != nil {
            http.Error(w, err.Error(), 502)
            return
        }
        // Process resp.Body as normal Go code...
    })

    http.ListenAndServe(":8080", nil)
}

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
    return http.HandleRequest(reqBase)
}
```

That's it. Standard `net/http` — handlers, middleware, cookies, headers, JSON, `http.Get()`, `ServeMux` — all work unchanged.

## How It Works

```
Zig src → zig build-obj → zig-abi.o ──┐
                                       ├── wasm-ld → go.wasm (single binary)
Go src  → tinygo build ───────────────┘

CF Request → Worker (JS)
  → writes request into WASM memory (zerobuf zero-copy)
  → calls handle_zerobuf(ptr)
  → Go handler runs: reads request, calls Zig SIMD, writes response
  → JS reads response bytes directly from WASM memory
  → CF Response
```

- **Single WASM binary** — Go + Zig linked via `wasm-ld`, Zig functions are direct `call` instructions
- **Zero-copy** — JS writes request fields into WASM memory, reads response as `Uint8Array`
- **net/http overlay** — replaces TinyGo's missing `net/http` with a WASM-compatible implementation using identical types and interfaces
- **Multi-fetch** — `http.Get()` works via a two-phase protocol, multiple calls per handler supported

## Build & Run

```bash
# Prerequisites
brew install tinygo   # TinyGo compiler
# Zig 0.15+ and wasm-ld required

npm install

# Build single WASM binary (Go + Zig linked)
npm run build

# Dev server
npm run dev           # wrangler dev on localhost:8787

# Run tests (84 tests)
npm test
```

## What Works

### Standard net/http
- `http.HandleFunc`, `http.Handle`, `http.ServeMux` (with subtree routing)
- `http.ResponseWriter` — `Write`, `WriteHeader`, `Header().Set/Get/Add`
- `http.Request` — `Method`, `URL`, `Header`, `Body`, `FormValue`, `PostFormValue`, `Cookie`, `BasicAuth`, `UserAgent`, `Referer`
- `http.Error`, `http.Redirect`, `http.NotFound`, `http.StripPrefix`, `http.MaxBytesReader`
- `http.SetCookie` with full cookie attributes (Path, Domain, MaxAge, HttpOnly, Secure, SameSite)
- `http.Get`, `http.Post`, `http.Head`, `Client.Do` — outbound fetch with multi-call support
- Custom `http.Handler` structs, middleware chaining `func(http.Handler) http.Handler`
- JSON via `encoding/json`, crypto via `crypto/sha256`

### Zig SIMD Operations
All use WASM SIMD v128 instructions, called from Go via CGo (zero overhead):

| Function | Description |
|----------|-------------|
| `SumF64(data)` | Sum of float64 array |
| `SumI32(data)` | Sum of int32 array |
| `DotF64(a, b)` | Dot product |
| `MinMaxF64(data)` | Min and max in one pass |
| `ScaleF64(data, s)` | Multiply by scalar (in-place) |
| `AddF64(dst, a, b)` | Element-wise addition |
| `SubF64(dst, a, b)` | Element-wise subtraction |
| `MulF64(dst, a, b)` | Element-wise multiplication |
| `ClampF64(data, lo, hi)` | Clamp to range (in-place) |
| `MapLinearF64(data, a, b)` | Affine transform y=ax+b (in-place) |

### Columnar Analytics
Higher-level API built on SIMD primitives:

| Function | Description |
|----------|-------------|
| `Stats(col)` | Count, sum, mean, min, max, variance, stddev |
| `NormalizeColumn(col)` | Normalize to [0,1] range (in-place) |
| `Correlation(a, b)` | Pearson correlation coefficient |
| `WeightedSum(data, weights)` | Weighted sum via dot product |

## Two Modes

| | Worker (`/*`) | Durable Object (`/do/*`) |
|---|---|---|
| Use case | Stateless APIs, transforms | Sessions, counters, WebSockets |
| Concurrency | CF scales isolates horizontally | Single instance per ID |
| WASM lifetime | Cached per isolate | Alive for DO lifetime |
| State | None | Go globals persist across requests |

Both modes have full parity: body, headers, cookies, multi-fetch, zero-copy responses.

## Benchmarks

10,000 requests, 100 concurrency, local wrangler dev:

| Endpoint | Native Go | GoMode WASM | Ratio |
|----------|-----------|-------------|-------|
| `GET /` (hello) | 59,912 rps | 3,022 rps | ~20x |
| `GET /json` | 65,102 rps | 3,011 rps | ~22x |

All GoMode endpoints (hello, JSON, SHA-256, SIMD, string ops) hit the same ~3,000 rps — the bottleneck is wrangler dev overhead (~30ms/req), not WASM execution. **Handler logic adds zero measurable latency.**

WASM binary: **822KB**.

## Architecture

```
worker/src/
  worker.ts         — Entry point, routes /* and /do/*
  go-do.ts          — Durable Object (full parity with worker)

zig-abi/src/
  main.zig          — Memory management + SIMD exports
  simd.zig          — WASM SIMD v128 batch operations
  allocator.zig     — Bump allocator

go-sdk/
  gomode.go         — CGo wrappers for Zig functions
  simd.go           — High-level SIMD API (SumF64, DotF64, etc.)
  columnar.go       — Columnar analytics (Stats, Correlation, etc.)
  zig_abi.h         — C header declaring Zig exports

overlay/net/http/
  server.go         — ServeMux, HandleFunc, ResponseWriter, HandleRequest
  client.go         — http.Get/Post/Head, multi-fetch two-phase protocol
  status.go         — Status codes and text
  method.go         — HTTP method constants

examples/
  hello-worker/     — Full demo: routing, SIMD, crypto, fetch, middleware
  analytics-api/    — Real-world API: stats, normalization, exchange rates

test/               — 84 tests (conformance, compatibility, fetch, DO)
```

## CI

GitHub Actions runs on every push and PR: builds Zig + TinyGo, starts wrangler dev, runs all 84 tests.

## License

MIT
