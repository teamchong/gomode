package gomode

import "unsafe"

// zerobuf constants — internal to SDK, users never see these
const (
	tagI32       = 2
	tagString    = 4
	valueSlot    = 16
	stringHeader = 4
)

// Static response buffer — reused across requests, no allocation per request.
// 3 fields x 16 bytes = 48 bytes for slots + 4048 bytes for string data = 4096 bytes
var respBuf [4096]byte

// Request is the incoming HTTP request. Users read fields directly.
type Request struct {
	Method  string
	Path    string
	Body    string
	reqBase uint32 // internal: base pointer for fan-out slot reads
}

// Response is what handlers return.
type Response struct {
	Status      int
	ContentType string
	Body        string
}

// HandlerFunc is the signature for route handlers.
type HandlerFunc func(r *Request) Response

// Text returns a plain text response.
func Text(status int, body string) Response {
	return Response{Status: status, ContentType: "text/plain", Body: body}
}

// JSON returns a JSON response.
func JSON(status int, body string) Response {
	return Response{Status: status, ContentType: "application/json", Body: body}
}

// HTML returns an HTML response.
func HTML(status int, body string) Response {
	return Response{Status: status, ContentType: "text/html", Body: body}
}

type route struct {
	method  string
	handler HandlerFunc
}

// Internal router — populated by GET/POST/PUT/DELETE/PATCH/HandleFunc in main()
var routes = map[string]route{}

// HandleFunc registers a handler for a path (any HTTP method). Call this in main().
func HandleFunc(path string, handler HandlerFunc) {
	routes[path] = route{method: "", handler: handler}
}

// GET registers a handler for GET requests on a path.
func GET(path string, handler HandlerFunc) {
	routes["GET:"+path] = route{method: "GET", handler: handler}
}

// POST registers a handler for POST requests on a path.
func POST(path string, handler HandlerFunc) {
	routes["POST:"+path] = route{method: "POST", handler: handler}
}

// PUT registers a handler for PUT requests on a path.
func PUT(path string, handler HandlerFunc) {
	routes["PUT:"+path] = route{method: "PUT", handler: handler}
}

// DELETE registers a handler for DELETE requests on a path.
func DELETE(path string, handler HandlerFunc) {
	routes["DELETE:"+path] = route{method: "DELETE", handler: handler}
}

// PATCH registers a handler for PATCH requests on a path.
func PATCH(path string, handler HandlerFunc) {
	routes["PATCH:"+path] = route{method: "PATCH", handler: handler}
}

// readZBString reads a zerobuf string from a tagged value slot in WASM memory.
func readZBString(slotAddr uintptr) string {
	headerPtr := uintptr(*(*uint32)(unsafe.Pointer(slotAddr + 4)))
	byteLen := *(*uint32)(unsafe.Pointer(headerPtr))
	if byteLen == 0 {
		return ""
	}
	bytes := unsafe.Slice((*byte)(unsafe.Pointer(headerPtr+stringHeader)), int(byteLen))
	return string(bytes)
}

// FanoutString reads a fan-out result string from the request.
// Index 0 = first fan-out result (slot 3 in zerobuf).
func (r *Request) FanoutString(index int) string {
	return readZBString(uintptr(r.reqBase) + uintptr((3+index)*valueSlot))
}

// writeZerobufResponse writes the response into the static buffer and returns its WASM pointer.
func writeZerobufResponse(status int32, contentType string, body string) uint32 {
	base := uintptr(unsafe.Pointer(&respBuf[0]))

	// Slot 0: status (i32)
	*(*uint8)(unsafe.Pointer(base)) = tagI32
	*(*int32)(unsafe.Pointer(base + 4)) = status

	// String data starts after the 3 slots (48 bytes)
	dataOffset := uintptr(48)

	// Slot 1: contentType string
	ctPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(ctPtr)) = uint32(len(contentType))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ctPtr+stringHeader)), len(contentType)), contentType)
	*(*uint8)(unsafe.Pointer(base + valueSlot)) = tagString
	*(*uint32)(unsafe.Pointer(base + valueSlot + 4)) = uint32(ctPtr)
	dataOffset += stringHeader + uintptr(len(contentType))
	dataOffset = (dataOffset + 3) &^ 3

	// Slot 2: body string
	bodyPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(bodyPtr)) = uint32(len(body))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(bodyPtr+stringHeader)), len(body)), body)
	*(*uint8)(unsafe.Pointer(base + 2*valueSlot)) = tagString
	*(*uint32)(unsafe.Pointer(base + 2*valueSlot + 4)) = uint32(bodyPtr)

	return uint32(base)
}

// HandleRequest is the internal entry point called by the exported handle_zerobuf.
// Users don't call this — it's called by the generated export.
func HandleRequest(reqBase uint32) uint32 {
	reqAddr := uintptr(reqBase)

	req := &Request{
		Method: readZBString(reqAddr + 0*valueSlot),
		Path:   readZBString(reqAddr + 1*valueSlot),
		Body:   readZBString(reqAddr + 2*valueSlot),
	}
	req.reqBase = reqBase

	// Try method-specific route first (e.g. "GET:/json")
	if r, ok := routes[req.Method+":"+req.Path]; ok {
		resp := r.handler(req)
		return writeZerobufResponse(int32(resp.Status), resp.ContentType, resp.Body)
	}

	// Fall back to any-method route
	if r, ok := routes[req.Path]; ok {
		resp := r.handler(req)
		return writeZerobufResponse(int32(resp.Status), resp.ContentType, resp.Body)
	}

	return writeZerobufResponse(404, "text/plain", "not found: "+req.Path)
}
