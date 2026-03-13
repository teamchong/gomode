package main

import (
	"encoding/json"
	"fmt"
	"unsafe"
)

// Request matches the JSON structure from the CF Worker.
type Request struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body,omitempty"`
}

// Response is serialized to JSON for the CF Worker.
type Response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// Response buffer — stays alive between calls (leaking GC keeps it).
var respBuf []byte

//export gomode_malloc
func gomodeMalloc(size uint32) uint32 {
	buf := make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(&buf[0])))
}

//export handle
func handle(reqPtr, reqLen uint32) uint32 {
	reqBytes := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(reqPtr))), int(reqLen))

	var req Request
	if err := json.Unmarshal(reqBytes, &req); err != nil {
		respBuf = marshalResponse(Response{
			Status:  400,
			Headers: map[string]string{"content-type": "text/plain"},
			Body:    "invalid request: " + err.Error(),
		})
		return uint32(len(respBuf))
	}

	var resp Response
	switch req.Path {
	case "/":
		resp = Response{
			Status:  200,
			Headers: map[string]string{"content-type": "text/plain"},
			Body:    "Hello from GoMode!",
		}
	case "/json":
		data := map[string]interface{}{
			"message": "Hello from GoMode!",
			"method":  req.Method,
			"path":    req.Path,
		}
		body, _ := json.Marshal(data)
		resp = Response{
			Status:  200,
			Headers: map[string]string{"content-type": "application/json"},
			Body:    string(body),
		}
	default:
		resp = Response{
			Status:  404,
			Headers: map[string]string{"content-type": "text/plain"},
			Body:    fmt.Sprintf("not found: %s", req.Path),
		}
	}

	respBuf = marshalResponse(resp)
	return uint32(len(respBuf))
}

//export getResponsePtr
func getResponsePtr() uint32 {
	if len(respBuf) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&respBuf[0])))
}

func marshalResponse(resp Response) []byte {
	out, _ := json.Marshal(resp)
	return out
}

func main() {
	// No-op. Go runtime is initialized by _start().
	// Subsequent requests call handle() directly.
}
