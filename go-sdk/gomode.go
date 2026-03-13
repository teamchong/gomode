// Package gomode provides the Go SDK for writing Cloudflare Workers in Go.
//
// Usage:
//
//	package main
//
//	import "github.com/user/gomode/go-sdk"
//
//	func main() {
//	    gomode.Handle(func(req gomode.Request, env gomode.Env) gomode.Response {
//	        return gomode.NewResponse(200, "Hello from Go!")
//	    })
//	}
//
// The handler is called for each incoming request. Request/Response data
// is exchanged via WASM linear memory — zero copy with the JS host.
package gomode

import (
	"encoding/json"
	"os"
	"unsafe"
)

// Request represents an incoming HTTP request.
type Request struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body,omitempty"`
}

// Response represents an outgoing HTTP response.
type Response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body"`
}

// Env provides access to Cloudflare Workers bindings.
type Env struct {
	bindings map[string]string
}

// Get returns an environment variable or binding value.
func (e Env) Get(key string) string {
	return e.bindings[key]
}

// NewResponse creates a response with the given status and body.
func NewResponse(status int, body string) Response {
	return Response{
		Status:  status,
		Headers: map[string]string{"content-type": "text/plain"},
		Body:    []byte(body),
	}
}

// JSONResponse creates a JSON response.
func JSONResponse(status int, data any) Response {
	body, err := json.Marshal(data)
	if err != nil {
		return NewResponse(500, "json marshal error: "+err.Error())
	}
	return Response{
		Status:  status,
		Headers: map[string]string{"content-type": "application/json"},
		Body:    body,
	}
}

// Handler is the function signature for request handlers.
type Handler func(req Request, env Env) Response

// Handle registers a request handler. This is the entry point for gomode workers.
// It reads the request from stdin (JSON), calls the handler, and writes
// the response to stdout (JSON), following the stdin/stdout protocol.
func Handle(handler Handler) {
	// Read request JSON from stdin
	input, err := os.ReadFile("/dev/stdin")
	if err != nil {
		writeError(500, "failed to read request: "+err.Error())
		return
	}

	var req Request
	if err := json.Unmarshal(input, &req); err != nil {
		writeError(400, "invalid request JSON: "+err.Error())
		return
	}

	env := Env{bindings: make(map[string]string)}

	resp := handler(req, env)

	output, err := json.Marshal(resp)
	if err != nil {
		writeError(500, "failed to marshal response: "+err.Error())
		return
	}

	os.Stdout.Write(output)
}

func writeError(status int, msg string) {
	resp := NewResponse(status, msg)
	output, _ := json.Marshal(resp)
	os.Stdout.Write(output)
}

// --- Zig ABI FFI (for direct columnar access from Go) ---

//go:wasmimport gomode zig_alloc
func zigAlloc(len uint32) uint32

//go:wasmimport gomode zig_free
func zigFree(ptr uint32, len uint32)

//go:wasmimport gomode zig_table_create
func zigTableCreate(nCols uint32) uint32

//go:wasmimport gomode zig_table_push_i32
func zigTablePushI32(table uint32, colIdx uint32, value int32) int32

//go:wasmimport gomode zig_table_push_f64
func zigTablePushF64(table uint32, colIdx uint32, value float64) int32

//go:wasmimport gomode zig_table_row_count
func zigTableRowCount(table uint32) uint32

//go:wasmimport gomode zig_table_free
func zigTableFree(table uint32)

// AllocWasm allocates memory in WASM linear memory.
// Returns a pointer that JS can read directly.
func AllocWasm(size int) (unsafe.Pointer, uint32) {
	ptr := zigAlloc(uint32(size))
	if ptr == 0 {
		return nil, 0
	}
	return unsafe.Pointer(uintptr(ptr)), ptr
}

// FreeWasm frees memory allocated by AllocWasm.
func FreeWasm(ptr uint32, size int) {
	zigFree(ptr, uint32(size))
}
