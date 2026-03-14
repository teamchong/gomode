// GoMode replacement for net/http.
// Users import "net/http" — this file gets swapped in at build time.
// Same types, same interfaces, same function signatures as Go stdlib.
package http

import (
	"io"
	"strings"
	"unsafe"
)

// zerobuf internals
const (
	zbTagI32       = 2
	zbTagString    = 4
	zbValueSlot    = 16
	zbStringHeader = 4
)

// Response buffer — grows dynamically to fit any response size.
// With leaking GC this converges: once the buffer fits the largest
// response, no further allocations happen.
var respBuf []byte

// ---------------------------------------------------------------------------
// Header — case-insensitive, same as net/http.Header
// ---------------------------------------------------------------------------

type Header map[string][]string

func canonicalKey(key string) string {
	b := []byte(strings.ToLower(key))
	upper := true
	for i, c := range b {
		if upper && c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
		upper = c == '-'
	}
	return string(b)
}

func CanonicalHeaderKey(s string) string {
	return canonicalKey(s)
}

func (h Header) Set(key, value string) {
	h[canonicalKey(key)] = []string{value}
}

func (h Header) Get(key string) string {
	if v, ok := h[canonicalKey(key)]; ok && len(v) > 0 {
		return v[0]
	}
	return ""
}

func (h Header) Add(key, value string) {
	k := canonicalKey(key)
	h[k] = append(h[k], value)
}

func (h Header) Del(key string) {
	delete(h, canonicalKey(key))
}

func (h Header) Values(key string) []string {
	return h[canonicalKey(key)]
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

func (h Header) Write(w io.Writer) error {
	for key, values := range h {
		for _, v := range values {
			io.WriteString(w, key+": "+v+"\r\n")
		}
	}
	return nil
}

func (h Header) WriteSubset(w io.Writer, exclude map[string]bool) error {
	for key, values := range h {
		if exclude != nil && exclude[key] {
			continue
		}
		for _, v := range values {
			io.WriteString(w, key+": "+v+"\r\n")
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Cookie — same as net/http.Cookie
// ---------------------------------------------------------------------------

type SameSite int

const (
	SameSiteDefaultMode SameSite = iota + 1
	SameSiteLaxMode
	SameSiteStrictMode
	SameSiteNoneMode
)

type Cookie struct {
	Name     string
	Value    string
	Path     string
	Domain   string
	MaxAge   int
	Secure   bool
	HttpOnly bool
	SameSite SameSite
	Raw      string
}

func (c *Cookie) String() string {
	s := c.Name + "=" + c.Value
	if c.Path != "" {
		s += "; Path=" + c.Path
	}
	if c.Domain != "" {
		s += "; Domain=" + c.Domain
	}
	if c.MaxAge > 0 {
		s += "; Max-Age=" + itoa(c.MaxAge)
	} else if c.MaxAge < 0 {
		s += "; Max-Age=0"
	}
	if c.HttpOnly {
		s += "; HttpOnly"
	}
	if c.Secure {
		s += "; Secure"
	}
	switch c.SameSite {
	case SameSiteLaxMode:
		s += "; SameSite=Lax"
	case SameSiteStrictMode:
		s += "; SameSite=Strict"
	case SameSiteNoneMode:
		s += "; SameSite=None"
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	if neg {
		s = "-" + s
	}
	return s
}

func SetCookie(w ResponseWriter, cookie *Cookie) {
	w.Header().Add("Set-Cookie", cookie.String())
}

// ---------------------------------------------------------------------------
// URL — same as net/url.URL
// ---------------------------------------------------------------------------

type URL struct {
	Scheme   string
	Host     string
	Path     string
	RawPath  string
	RawQuery string
	Fragment string
}

func (u *URL) String() string {
	s := ""
	if u.Scheme != "" {
		s += u.Scheme + "://"
	}
	if u.Host != "" {
		s += u.Host
	}
	if u.Path != "" {
		s += u.Path
	} else if u.Scheme != "" || u.Host != "" {
		s += "/"
	}
	if u.RawQuery != "" {
		s += "?" + u.RawQuery
	}
	if u.Fragment != "" {
		s += "#" + u.Fragment
	}
	return s
}

func parseRawURL(rawurl string) *URL {
	u := &URL{}
	if i := strings.Index(rawurl, "://"); i >= 0 {
		u.Scheme = rawurl[:i]
		rawurl = rawurl[i+3:]
		j := strings.IndexByte(rawurl, '/')
		if j < 0 {
			u.Host = rawurl
			u.Path = "/"
			return u
		}
		u.Host = rawurl[:j]
		rawurl = rawurl[j:]
	}
	if i := strings.IndexByte(rawurl, '#'); i >= 0 {
		u.Fragment = rawurl[i+1:]
		rawurl = rawurl[:i]
	}
	if i := strings.IndexByte(rawurl, '?'); i >= 0 {
		u.RawQuery = rawurl[i+1:]
		rawurl = rawurl[:i]
	}
	u.Path = rawurl
	if u.Path == "" {
		u.Path = "/"
	}
	return u
}

func (u *URL) Query() map[string][]string {
	return parseQuery(u.RawQuery)
}

func (u *URL) RequestURI() string {
	s := u.Path
	if s == "" {
		s = "/"
	}
	if u.RawQuery != "" {
		s += "?" + u.RawQuery
	}
	return s
}

func (u *URL) Hostname() string {
	h := u.Host
	i := strings.LastIndex(h, ":")
	if i < 0 {
		return h
	}
	return h[:i]
}

func (u *URL) Port() string {
	h := u.Host
	i := strings.LastIndex(h, ":")
	if i < 0 {
		return ""
	}
	return h[i+1:]
}

func (u *URL) EscapedPath() string {
	if u.RawPath != "" {
		return u.RawPath
	}
	return u.Path
}

func parseQuery(query string) map[string][]string {
	m := map[string][]string{}
	if query == "" {
		return m
	}
	for query != "" {
		var pair string
		i := strings.IndexByte(query, '&')
		if i < 0 {
			pair = query
			query = ""
		} else {
			pair = query[:i]
			query = query[i+1:]
		}
		j := strings.IndexByte(pair, '=')
		if j < 0 {
			m[pair] = append(m[pair], "")
		} else {
			key := queryUnescape(pair[:j])
			val := queryUnescape(pair[j+1:])
			m[key] = append(m[key], val)
		}
	}
	return m
}

func queryUnescape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '+':
			b.WriteByte(' ')
		case '%':
			if i+2 < len(s) {
				h := unhex(s[i+1])<<4 | unhex(s[i+2])
				b.WriteByte(h)
				i += 2
			} else {
				b.WriteByte('%')
			}
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	}
	return 0
}

// ---------------------------------------------------------------------------
// Request — same as net/http.Request
// ---------------------------------------------------------------------------

type Request struct {
	Method           string
	URL              *URL
	Proto            string
	ProtoMajor       int
	ProtoMinor       int
	Header           Header
	Body             io.ReadCloser
	GetBody          func() (io.ReadCloser, error)
	ContentLength    int64
	TransferEncoding []string
	Close            bool
	Host             string
	Form             map[string][]string
	PostForm         map[string][]string
	RemoteAddr       string
	RequestURI       string

	reqBase uint32
	bodyStr string
	parsed  bool
}

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

// ParseForm parses the query string and (for POST/PUT/PATCH) the request body.
func (r *Request) ParseForm() error {
	if r.parsed {
		return nil
	}
	r.parsed = true
	r.Form = r.URL.Query()
	r.PostForm = map[string][]string{}

	if (r.Method == "POST" || r.Method == "PUT" || r.Method == "PATCH") && r.bodyStr != "" {
		ct := r.Header.Get("Content-Type")
		if ct == "" || strings.HasPrefix(ct, "application/x-www-form-urlencoded") {
			postVals := parseQuery(r.bodyStr)
			r.PostForm = postVals
			for k, v := range postVals {
				r.Form[k] = append(r.Form[k], v...)
			}
		}
	}
	return nil
}

// FormValue returns the first value for the named component of the query
// or POST/PUT body. POST body takes precedence over query string.
func (r *Request) FormValue(key string) string {
	r.ParseForm()
	if vs := r.Form[key]; len(vs) > 0 {
		return vs[0]
	}
	return ""
}

// PostFormValue returns the first value for the named component of the POST body.
func (r *Request) PostFormValue(key string) string {
	r.ParseForm()
	if vs := r.PostForm[key]; len(vs) > 0 {
		return vs[0]
	}
	return ""
}

// Cookie returns the named cookie or ErrNoCookie.
func (r *Request) Cookie(name string) (*Cookie, error) {
	for _, c := range r.Cookies() {
		if c.Name == name {
			return c, nil
		}
	}
	return nil, ErrNoCookie
}

// Cookies parses and returns the cookies sent with the request.
func (r *Request) Cookies() []*Cookie {
	var cookies []*Cookie
	for _, line := range r.Header.Values("Cookie") {
		parts := strings.Split(line, ";")
		for _, part := range parts {
			part = strings.TrimSpace(part)
			eq := strings.IndexByte(part, '=')
			if eq < 0 {
				continue
			}
			cookies = append(cookies, &Cookie{
				Name:  part[:eq],
				Value: part[eq+1:],
			})
		}
	}
	return cookies
}

// BasicAuth returns the username and password from the Authorization header.
func (r *Request) BasicAuth() (username, password string, ok bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Basic ") {
		return "", "", false
	}
	decoded := base64Decode(auth[6:])
	i := strings.IndexByte(decoded, ':')
	if i < 0 {
		return "", "", false
	}
	return decoded[:i], decoded[i+1:], true
}

// RFC 4648 standard base64 decoder
func base64Decode(s string) string {
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var buf []byte
	bits := 0
	val := 0
	for _, c := range s {
		if c == '=' {
			break
		}
		idx := strings.IndexRune(table, c)
		if idx < 0 {
			continue
		}
		val = val<<6 | idx
		bits += 6
		if bits >= 8 {
			bits -= 8
			buf = append(buf, byte(val>>bits))
			val &= (1 << bits) - 1
		}
	}
	return string(buf)
}

// Referer returns the referring URL.
func (r *Request) Referer() string {
	return r.Header.Get("Referer")
}

// UserAgent returns the client's User-Agent.
func (r *Request) UserAgent() string {
	return r.Header.Get("User-Agent")
}

// ProtoAtLeast returns whether the HTTP protocol is at least major.minor.
func (r *Request) ProtoAtLeast(major, minor int) bool {
	return r.ProtoMajor > major || (r.ProtoMajor == major && r.ProtoMinor >= minor)
}

// FanoutString reads a fan-out result from the request.
// Index 0 = first fan-out result (JS slot 6). GoMode extension.
func (r *Request) FanoutString(index int) string {
	return readZBString(uintptr(r.reqBase) + uintptr((6+index)*zbValueSlot))
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type httpError struct {
	msg string
}

func (e *httpError) Error() string { return e.msg }

var ErrNoCookie = &httpError{"http: named cookie not present"}

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

func (mux *ServeMux) Handler(r *Request) (h Handler, pattern string) {
	path := r.URL.Path
	// Exact match first
	if h, ok := mux.entries[path]; ok {
		return h, path
	}
	// Subtree match: patterns ending in "/" match any subpath (Go stdlib behavior)
	longest := ""
	var matched Handler
	for p, h := range mux.entries {
		if len(p) > 0 && p[len(p)-1] == '/' && len(p) <= len(path) && path[:len(p)] == p {
			if len(p) > len(longest) {
				longest = p
				matched = h
			}
		}
	}
	if matched != nil {
		return matched, longest
	}
	return NotFoundHandler(), ""
}

func (mux *ServeMux) ServeHTTP(w ResponseWriter, r *Request) {
	h, _ := mux.Handler(r)
	h.ServeHTTP(w, r)
}

// ---------------------------------------------------------------------------
// Default mux + top-level functions
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
	w.Header().Set("X-Content-Type-Options", "nosniff")
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
	w.Write([]byte("<a href=\"" + url + "\">" + StatusText(code) + "</a>.\n"))
}

func RedirectHandler(url string, code int) Handler {
	return HandlerFunc(func(w ResponseWriter, r *Request) {
		Redirect(w, r, url, code)
	})
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

func MaxBytesReader(w ResponseWriter, r io.ReadCloser, n int64) io.ReadCloser {
	return &maxBytesReader{r: r, n: n}
}

type maxBytesReader struct {
	r    io.ReadCloser
	n    int64
	read int64
}

func (r *maxBytesReader) Read(p []byte) (int, error) {
	if r.read >= r.n {
		return 0, &httpError{"http: request body too large"}
	}
	remaining := r.n - r.read
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := r.r.Read(p)
	r.read += int64(n)
	return n, err
}

func (r *maxBytesReader) Close() error {
	return r.r.Close()
}

func DetectContentType(data []byte) string {
	if len(data) > 512 {
		data = data[:512]
	}
	if len(data) == 0 {
		return "application/octet-stream"
	}
	if len(data) >= 5 && string(data[:5]) == "<?xml" {
		return "text/xml; charset=utf-8"
	}
	if len(data) >= 14 && string(data[:14]) == "<!DOCTYPE html" {
		return "text/html; charset=utf-8"
	}
	if len(data) >= 5 && string(data[:5]) == "<html" {
		return "text/html; charset=utf-8"
	}
	if len(data) >= 1 && (data[0] == '{' || data[0] == '[') {
		return "application/json"
	}
	if len(data) >= 4 && string(data[:4]) == "%PDF" {
		return "application/pdf"
	}
	if len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return "image/jpeg"
	}
	if len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n" {
		return "image/png"
	}
	if len(data) >= 4 && string(data[:4]) == "GIF8" {
		return "image/gif"
	}
	for _, b := range data {
		if b < 0x20 && b != '\t' && b != '\n' && b != '\r' {
			return "application/octet-stream"
		}
	}
	return "text/plain; charset=utf-8"
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

func serializeHeaders(h Header) string {
	var s string
	for key, values := range h {
		for _, v := range values {
			s += key + ": " + v + "\n"
		}
	}
	return s
}

func parseHeaderString(s string) Header {
	h := Header{}
	for s != "" {
		var line string
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			line = s
			s = ""
		} else {
			line = s[:i]
			s = s[i+1:]
		}
		j := strings.Index(line, ": ")
		if j < 0 {
			continue
		}
		h.Add(line[:j], line[j+2:])
	}
	return h
}

func writeZerobufResponse(status int32, contentType string, body string, headers string) uint32 {
	// Calculate total size: 4 slots + 3 string payloads (each 4-byte aligned)
	needed := 4*zbValueSlot +
		(zbStringHeader + len(contentType) + 3) & ^3 +
		(zbStringHeader + len(body) + 3) & ^3 +
		(zbStringHeader + len(headers) + 3) & ^3
	if len(respBuf) < needed {
		respBuf = make([]byte, needed)
	}

	base := uintptr(unsafe.Pointer(&respBuf[0]))

	*(*uint8)(unsafe.Pointer(base)) = zbTagI32
	*(*int32)(unsafe.Pointer(base + 4)) = status

	dataOffset := uintptr(4 * zbValueSlot)

	ctPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(ctPtr)) = uint32(len(contentType))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ctPtr+zbStringHeader)), len(contentType)), contentType)
	*(*uint8)(unsafe.Pointer(base + zbValueSlot)) = zbTagString
	*(*uint32)(unsafe.Pointer(base + zbValueSlot + 4)) = uint32(ctPtr)
	dataOffset += (zbStringHeader + uintptr(len(contentType)) + 3) &^ 3

	bodyPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(bodyPtr)) = uint32(len(body))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(bodyPtr+zbStringHeader)), len(body)), body)
	*(*uint8)(unsafe.Pointer(base + 2*zbValueSlot)) = zbTagString
	*(*uint32)(unsafe.Pointer(base + 2*zbValueSlot + 4)) = uint32(bodyPtr)
	dataOffset += (zbStringHeader + uintptr(len(body)) + 3) &^ 3

	hdrsPtr := base + dataOffset
	*(*uint32)(unsafe.Pointer(hdrsPtr)) = uint32(len(headers))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(hdrsPtr+zbStringHeader)), len(headers)), headers)
	*(*uint8)(unsafe.Pointer(base + 3*zbValueSlot)) = zbTagString
	*(*uint32)(unsafe.Pointer(base + 3*zbValueSlot + 4)) = uint32(hdrsPtr)

	return uint32(base)
}

// HandleRequest is called by the WASM export. Routes through mux or custom handler.
//
// Multi-fetch two-phase protocol:
//   Each http.Get() call in the handler triggers one round-trip to JS.
//   Results are cached by URL. On each replay, previously-fetched URLs
//   return immediately. The handler replays N+1 times for N distinct fetches.
//
//   Slot 4 carries the fetch result from the previous round-trip.
//   Slot 5 carries the URL that was fetched (so Go can cache it by URL).
func HandleRequest(reqBase uint32) uint32 {
	reqAddr := uintptr(reqBase)

	bodyStr := readZBString(reqAddr + 2*zbValueSlot)
	rawPath := readZBString(reqAddr + 1*zbValueSlot)
	urlPath := rawPath
	rawQuery := ""
	if qi := strings.IndexByte(rawPath, '?'); qi >= 0 {
		urlPath = rawPath[:qi]
		rawQuery = rawPath[qi+1:]
	}
	hdrs := parseHeaderString(readZBString(reqAddr + 3*zbValueSlot))

	// Check if this is a replay with fetch result in slot 4 + call index in slot 5
	fetchSlotAddr := reqAddr + 4*zbValueSlot
	fetchSlotTag := *(*uint8)(unsafe.Pointer(fetchSlotAddr))
	if fetchSlotTag == zbTagString {
		fetchResultPtr := uintptr(*(*uint32)(unsafe.Pointer(fetchSlotAddr + 4)))
		callIdx := int(*(*int32)(unsafe.Pointer(reqAddr + 5*zbValueSlot + 4)))
		storeFetchResult(callIdx, readFetchResponse(fetchResultPtr))
	}

	req := &Request{
		Method:      readZBString(reqAddr + 0*zbValueSlot),
		URL:         &URL{Path: urlPath, RawQuery: rawQuery},
		Proto:       "HTTP/1.1",
		ProtoMajor:  1,
		ProtoMinor:  1,
		Header:      hdrs,
		Body:        &stringReader{s: bodyStr},
		bodyStr:     bodyStr,
		reqBase:     reqBase,
		RemoteAddr:  "",
	}
	req.ContentLength = int64(len(bodyStr))
	host := hdrs.Get("Host")
	if host != "" {
		req.Host = host
	} else {
		req.Host = req.URL.Host
	}
	req.RequestURI = req.URL.RequestURI()

	fetchPending = false
	fetchCallIndex = 0

	w := &responseWriter{
		headers:    Header{},
		statusCode: 200,
	}

	if globalHandler != nil {
		globalHandler.ServeHTTP(w, req)
	} else {
		defaultServeMux.ServeHTTP(w, req)
	}

	// If the handler triggered a fetch, return status=-1 so JS does the fetch and replays.
	// Headers field carries the pending call index for the round-trip.
	if fetchPending {
		fetchPending = false
		return writeZerobufResponse(-1, fetchMethod, fetchURL, itoa(fetchPendingIndex))
	}

	// All fetches resolved — clear cache for next request
	fetchResults = nil

	ct := w.headers.Get("Content-Type")
	if ct == "" {
		ct = DetectContentType(w.body)
	}

	return writeZerobufResponse(int32(w.statusCode), ct, string(w.body), serializeHeaders(w.headers))
}
