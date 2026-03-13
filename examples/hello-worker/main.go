package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Request matches the JSON structure from the CF Worker.
type Request struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body,omitempty"`
}

// Response is serialized to JSON on stdout for the CF Worker.
type Response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

func main() {
	// Read request JSON from stdin
	input := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			input = append(input, buf[:n]...)
		}
		if err != nil {
			break
		}
	}

	var req Request
	if err := json.Unmarshal(input, &req); err != nil {
		writeResponse(Response{
			Status:  400,
			Headers: map[string]string{"content-type": "text/plain"},
			Body:    "invalid request: " + err.Error(),
		})
		return
	}

	// Route by path
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

	writeResponse(resp)
}

func writeResponse(resp Response) {
	output, _ := json.Marshal(resp)
	os.Stdout.Write(output)
}
