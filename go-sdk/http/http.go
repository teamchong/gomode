// Package http provides a net/http compatible API for GoMode.
//
// User code looks identical to standard Go:
//
//	import "gomode/http"
//
//	func main() {
//	    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
//	        w.Write([]byte("Hello!"))
//	    })
//	    http.ListenAndServe(":8080", nil)
//	}
//
// Only the import path changes. Everything else — ResponseWriter, Request,
// HandleFunc, ListenAndServe — works the same as net/http.
package http

import "unsafe"

// zerobuf internals
const (
	tagI32       = 2
	tagString    = 4
	valueSlot    = 16
	stringHeader = 4
)

// Header represents HTTP headers. Maps string keys to string slice values,
// same as net/http.Header.
type Header map[string][]string

// Set sets the header entry for key to value.
func (h Header) Set(key, value string) {
	h[key] = []string{value}
}

// Get gets the first value for key.
func (h Header) Get(key string) string {
	if v, ok := h[key]; ok && len(v) > 0 {
		return v[0]
	}
	return ""
}

// Add adds the value to key (appends to existing values).
func (h Header) Add(key, value string) {
	h[key] = append(h[key], value)
}

// Request matches net/http.Request — same fields, same usage.
type Request struct {
	Method string
	URL    *URL
	Body   string
	Header Header

	reqBase uint32 // internal: zerobuf base pointer for fan-out
}

// URL matches the fields users access on net/http.Request.URL.
type URL struct {
	Path     string
	RawQuery string
}

// FanoutString reads a fan-out result from the request.
// Index 0 = first fan-out result (JS slot 3).
func (r *Request) FanoutString(index int) string {
	return readZBString(uintptr(r.reqBase) + uintptr((3+index)*valueSlot))
}

// ResponseWriter matches net/http.ResponseWriter — same interface.
type ResponseWriter interface {
	Header() Header
	Write([]byte) (int, error)
	WriteHeader(statusCode int)
}

// Handler matches net/http.Handler.
type Handler interface {
	ServeHTTP(ResponseWriter, *Request)
}

// HandlerFunc matches net/http.HandlerFunc.
type HandlerFunc func(ResponseWriter, *Request)

func (f HandlerFunc) ServeHTTP(w ResponseWriter, r *Request) {
	f(w, r)
}

// --- response writer implementation ---

var respBuf [8192]byte

type responseWriter struct {
	headers    Header
	statusCode int
	body       []byte
	wroteHead  bool
}

func (w *responseWriter) Header() Header {
	return w.headers
}

func (w *responseWriter) Write(data []byte) (int, error) {
	if !w.wroteHead {
		w.statusCode = 200
		w.wroteHead = true
	}
	w.body = append(w.body, data...)
	return len(data), nil
}

func (w *responseWriter) WriteHeader(statusCode int) {
	if w.wroteHead {
		return
	}
	w.statusCode = statusCode
	w.wroteHead = true
}

// --- default mux ---

type muxEntry struct {
	handler Handler
}

var defaultMux = map[string]muxEntry{}

// HandleFunc registers a handler function for the given pattern.
// Same as net/http.HandleFunc.
func HandleFunc(pattern string, handler func(ResponseWriter, *Request)) {
	defaultMux[pattern] = muxEntry{handler: HandlerFunc(handler)}
}

// Handle registers a handler for the given pattern.
// Same as net/http.Handle.
func Handle(pattern string, handler Handler) {
	defaultMux[pattern] = muxEntry{handler: handler}
}

// ListenAndServe matches net/http.ListenAndServe.
// In GoMode, the address is ignored — CF Workers handle the listening.
// If handler is nil, the default mux is used.
// This is a no-op that exists for API compatibility — the actual serving
// happens via the handle_zerobuf WASM export.
func ListenAndServe(addr string, handler Handler) error {
	if handler != nil {
		customHandler = handler
	}
	return nil
}

var customHandler Handler

// --- zerobuf read/write ---

func readZBString(slotAddr uintptr) string {
	headerPtr := uintptr(*(*uint32)(unsafe.Pointer(slotAddr + 4)))
	byteLen := *(*uint32)(unsafe.Pointer(headerPtr))
	if byteLen == 0 {
		return ""
	}
	bytes := unsafe.Slice((*byte)(unsafe.Pointer(headerPtr+stringHeader)), int(byteLen))
	return string(bytes)
}

func writeZerobufResponse(status int32, contentType string, body string) uint32 {
	base := uintptr(unsafe.Pointer(&respBuf[0]))

	*(*uint8)(unsafe.Pointer(base)) = tagI32
	*(*int32)(unsafe.Pointer(base + 4)) = status

	dataOffset := uintptr(48)

	ctPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(ctPtr)) = uint32(len(contentType))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ctPtr+stringHeader)), len(contentType)), contentType)
	*(*uint8)(unsafe.Pointer(base + valueSlot)) = tagString
	*(*uint32)(unsafe.Pointer(base + valueSlot + 4)) = uint32(ctPtr)
	dataOffset += stringHeader + uintptr(len(contentType))
	dataOffset = (dataOffset + 3) &^ 3

	bodyPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(bodyPtr)) = uint32(len(body))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(bodyPtr+stringHeader)), len(body)), body)
	*(*uint8)(unsafe.Pointer(base + 2*valueSlot)) = tagString
	*(*uint32)(unsafe.Pointer(base + 2*valueSlot + 4)) = uint32(bodyPtr)

	return uint32(base)
}

// HandleRequest is the entry point called by the WASM export.
// Routes the request through the default mux or custom handler.
func HandleRequest(reqBase uint32) uint32 {
	reqAddr := uintptr(reqBase)

	req := &Request{
		Method: readZBString(reqAddr + 0*valueSlot),
		URL:    &URL{Path: readZBString(reqAddr + 1*valueSlot)},
		Body:   readZBString(reqAddr + 2*valueSlot),
		Header: Header{},

		reqBase: reqBase,
	}

	w := &responseWriter{
		headers:    Header{},
		statusCode: 200,
	}

	// Custom handler (from ListenAndServe with non-nil handler)
	if customHandler != nil {
		customHandler.ServeHTTP(w, req)
	} else {
		// Default mux lookup
		entry, ok := defaultMux[req.URL.Path]
		if !ok {
			return writeZerobufResponse(404, "text/plain", "404 page not found\n")
		}
		entry.handler.ServeHTTP(w, req)
	}

	// Determine content type
	ct := w.headers.Get("Content-Type")
	if ct == "" {
		ct = "text/plain; charset=utf-8"
	}

	return writeZerobufResponse(int32(w.statusCode), ct, string(w.body))
}
