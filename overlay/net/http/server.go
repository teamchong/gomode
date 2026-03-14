// GoMode replacement for net/http.
// Users import "net/http" — this file gets swapped in at build time.
// Same types, same interfaces, same function signatures.
package http

import (
	"io"
	"unsafe"
)

// zerobuf internals — users never see these
const (
	zbTagI32       = 2
	zbTagString    = 4
	zbValueSlot    = 16
	zbStringHeader = 4
)

var respBuf [8192]byte

// ---------------------------------------------------------------------------
// Header — same as net/http.Header
// ---------------------------------------------------------------------------

type Header map[string][]string

func (h Header) Set(key, value string) {
	h[key] = []string{value}
}

func (h Header) Get(key string) string {
	if v, ok := h[key]; ok && len(v) > 0 {
		return v[0]
	}
	return ""
}

func (h Header) Add(key, value string) {
	h[key] = append(h[key], value)
}

func (h Header) Del(key string) {
	delete(h, key)
}

func (h Header) Values(key string) []string {
	return h[key]
}

func (h Header) Clone() Header {
	h2 := Header{}
	for k, v := range h {
		v2 := make([]string, len(v))
		copy(v2, v)
		h2[k] = v2
	}
	return h2
}

// Write writes the header in wire format. Minimal implementation.
func (h Header) Write(w io.Writer) error {
	for key, values := range h {
		for _, v := range values {
			io.WriteString(w, key+": "+v+"\r\n")
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Request — same as net/http.Request
// ---------------------------------------------------------------------------

type Request struct {
	Method     string
	URL        *URL
	Header     Header
	Body       io.ReadCloser
	Host       string
	RequestURI string

	bodyStr string  // internal: raw body from zerobuf
	reqBase uint32  // internal: zerobuf base pointer
}

type URL struct {
	Scheme   string
	Host     string
	Path     string
	RawPath  string
	RawQuery string
	Fragment string
}

func (u *URL) String() string {
	s := u.Path
	if u.RawQuery != "" {
		s += "?" + u.RawQuery
	}
	return s
}

func (u *URL) Query() map[string][]string {
	return parseQuery(u.RawQuery)
}

func parseQuery(query string) map[string][]string {
	m := map[string][]string{}
	if query == "" {
		return m
	}
	for query != "" {
		var key string
		i := indexOf(query, '&')
		var pair string
		if i < 0 {
			pair = query
			query = ""
		} else {
			pair = query[:i]
			query = query[i+1:]
		}
		j := indexOf(pair, '=')
		if j < 0 {
			key = pair
			m[key] = append(m[key], "")
		} else {
			key = pair[:j]
			m[key] = append(m[key], pair[j+1:])
		}
	}
	return m
}

func indexOf(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// FormValue returns the first form value for key from query string.
func (r *Request) FormValue(key string) string {
	if vals, ok := r.URL.Query()[key]; ok && len(vals) > 0 {
		return vals[0]
	}
	return ""
}

// stringReader implements io.ReadCloser for the body
type stringReader struct {
	s   string
	pos int
}

func (r *stringReader) Read(p []byte) (n int, err error) {
	if r.pos >= len(r.s) {
		return 0, io.EOF
	}
	n = copy(p, r.s[r.pos:])
	r.pos += n
	return n, nil
}

func (r *stringReader) Close() error {
	return nil
}

// ---------------------------------------------------------------------------
// ResponseWriter — same interface as net/http.ResponseWriter
// ---------------------------------------------------------------------------

type ResponseWriter interface {
	Header() Header
	Write([]byte) (int, error)
	WriteHeader(statusCode int)
}

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

// ---------------------------------------------------------------------------
// Handler / HandlerFunc — same as net/http
// ---------------------------------------------------------------------------

type Handler interface {
	ServeHTTP(ResponseWriter, *Request)
}

type HandlerFunc func(ResponseWriter, *Request)

func (f HandlerFunc) ServeHTTP(w ResponseWriter, r *Request) {
	f(w, r)
}

// ---------------------------------------------------------------------------
// ServeMux — same as net/http.ServeMux
// ---------------------------------------------------------------------------

type ServeMux struct {
	entries map[string]Handler
}

func NewServeMux() *ServeMux {
	return &ServeMux{entries: map[string]Handler{}}
}

func (mux *ServeMux) Handle(pattern string, handler Handler) {
	mux.entries[pattern] = handler
}

func (mux *ServeMux) HandleFunc(pattern string, handler func(ResponseWriter, *Request)) {
	mux.entries[pattern] = HandlerFunc(handler)
}

func (mux *ServeMux) ServeHTTP(w ResponseWriter, r *Request) {
	if h, ok := mux.entries[r.URL.Path]; ok {
		h.ServeHTTP(w, r)
		return
	}
	NotFound(w, r)
}

// ---------------------------------------------------------------------------
// Default mux + top-level functions — same as net/http
// ---------------------------------------------------------------------------

var defaultServeMux = NewServeMux()

func HandleFunc(pattern string, handler func(ResponseWriter, *Request)) {
	defaultServeMux.HandleFunc(pattern, handler)
}

func Handle(pattern string, handler Handler) {
	defaultServeMux.Handle(pattern, handler)
}

var globalHandler Handler

func ListenAndServe(addr string, handler Handler) error {
	if handler != nil {
		globalHandler = handler
	}
	return nil
}

func ListenAndServeTLS(addr, certFile, keyFile string, handler Handler) error {
	return ListenAndServe(addr, handler)
}

// ---------------------------------------------------------------------------
// Helper functions — same as net/http
// ---------------------------------------------------------------------------

func Error(w ResponseWriter, error string, code int) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	w.Write([]byte(error))
}

func NotFound(w ResponseWriter, r *Request) {
	Error(w, "404 page not found", StatusNotFound)
}

func NotFoundHandler() Handler {
	return HandlerFunc(NotFound)
}

func Redirect(w ResponseWriter, r *Request, url string, code int) {
	w.Header().Set("Location", url)
	w.WriteHeader(code)
}

func MaxBytesReader(w ResponseWriter, r io.ReadCloser, n int64) io.ReadCloser {
	return r
}

func StripPrefix(prefix string, h Handler) Handler {
	return HandlerFunc(func(w ResponseWriter, r *Request) {
		p := r.URL.Path
		if len(p) >= len(prefix) && p[:len(prefix)] == prefix {
			r.URL.Path = p[len(prefix):]
			if r.URL.Path == "" {
				r.URL.Path = "/"
			}
		}
		h.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// zerobuf read/write — internal
// ---------------------------------------------------------------------------

func readZBString(slotAddr uintptr) string {
	headerPtr := uintptr(*(*uint32)(unsafe.Pointer(slotAddr + 4)))
	byteLen := *(*uint32)(unsafe.Pointer(headerPtr))
	if byteLen == 0 {
		return ""
	}
	bytes := unsafe.Slice((*byte)(unsafe.Pointer(headerPtr+zbStringHeader)), int(byteLen))
	return string(bytes)
}

func writeZerobufResponse(status int32, contentType string, body string) uint32 {
	base := uintptr(unsafe.Pointer(&respBuf[0]))

	*(*uint8)(unsafe.Pointer(base)) = zbTagI32
	*(*int32)(unsafe.Pointer(base + 4)) = status

	dataOffset := uintptr(48)

	ctPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(ctPtr)) = uint32(len(contentType))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ctPtr+zbStringHeader)), len(contentType)), contentType)
	*(*uint8)(unsafe.Pointer(base + zbValueSlot)) = zbTagString
	*(*uint32)(unsafe.Pointer(base + zbValueSlot + 4)) = uint32(ctPtr)
	dataOffset += zbStringHeader + uintptr(len(contentType))
	dataOffset = (dataOffset + 3) &^ 3

	bodyPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(bodyPtr)) = uint32(len(body))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(bodyPtr+zbStringHeader)), len(body)), body)
	*(*uint8)(unsafe.Pointer(base + 2*zbValueSlot)) = zbTagString
	*(*uint32)(unsafe.Pointer(base + 2*zbValueSlot + 4)) = uint32(bodyPtr)

	return uint32(base)
}

// HandleRequest is called by the WASM export. Routes through mux or custom handler.
func HandleRequest(reqBase uint32) uint32 {
	reqAddr := uintptr(reqBase)

	bodyStr := readZBString(reqAddr + 2*zbValueSlot)
	req := &Request{
		Method:  readZBString(reqAddr + 0*zbValueSlot),
		URL:     &URL{Path: readZBString(reqAddr + 1*zbValueSlot)},
		Header:  Header{},
		Body:    &stringReader{s: bodyStr},
		bodyStr: bodyStr,
		reqBase: reqBase,
	}

	w := &responseWriter{
		headers:    Header{},
		statusCode: 200,
	}

	if globalHandler != nil {
		globalHandler.ServeHTTP(w, req)
	} else {
		defaultServeMux.ServeHTTP(w, req)
	}

	ct := w.headers.Get("Content-Type")
	if ct == "" {
		ct = "text/plain; charset=utf-8"
	}

	return writeZerobufResponse(int32(w.statusCode), ct, string(w.body))
}
