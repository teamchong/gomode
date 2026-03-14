package http

import (
	"io"
	"unsafe"
)

// Response represents an HTTP response — same as net/http.Response.
type Response struct {
	Status        string
	StatusCode    int
	Proto         string
	ProtoMajor    int
	ProtoMinor    int
	Header        Header
	Body          io.ReadCloser
	ContentLength int64
}

type RoundTripper interface {
	RoundTrip(*Request) (*Response, error)
}

type Client struct {
	Transport RoundTripper
}

var DefaultClient = &Client{}

// Multi-fetch two-phase protocol (no Asyncify needed):
//
// Supports multiple http.Get() calls in a single handler. Each call triggers
// one round-trip: handler exits early, JS does the fetch, replays.
// Results are cached by call index (not URL) so even duplicate URLs work correctly.
//
// Each replay resolves one more fetch. N fetches = N+1 WASM invocations.
// The handler replays from the start each time — resolved calls return
// instantly from cache, advancing to the next unresolved call.

var fetchURL string
var fetchMethod string
var fetchPending bool
var fetchCallIndex int
var fetchPendingIndex int
var fetchResults map[int]*Response

// errFetchPending is returned by doFetch when a call hasn't been resolved yet.
var errFetchPending = &httpError{"gomode: fetch pending"}

func doFetch(method, rawurl, body, contentType string) (*Response, error) {
	idx := fetchCallIndex
	fetchCallIndex++

	// Check cache by call index
	if fetchResults != nil {
		if r, ok := fetchResults[idx]; ok {
			return r, nil
		}
	}

	// Not resolved: store params for HandleRequest and exit early
	fetchPendingIndex = idx
	fetchURL = rawurl
	fetchMethod = method
	fetchPending = true
	return nil, errFetchPending
}

func storeFetchResult(idx int, resp *Response) {
	if fetchResults == nil {
		fetchResults = map[int]*Response{}
	}
	fetchResults[idx] = resp
}

func readFetchResponse(base uintptr) *Response {
	status := int(*(*int32)(unsafe.Pointer(base + 4)))
	ct := readZBString(base + uintptr(zbValueSlot))
	bodyStr := readZBString(base + uintptr(2*zbValueSlot))

	resp := &Response{
		StatusCode:    status,
		Status:        itoa(status) + " " + StatusText(status),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        Header{},
		Body:          &stringReader{s: bodyStr},
		ContentLength: int64(len(bodyStr)),
	}
	if ct != "" {
		resp.Header.Set("Content-Type", ct)
	}
	return resp
}

func readBody(body io.Reader) string {
	if body == nil {
		return ""
	}
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 1024)
	for {
		n, err := body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			break
		}
	}
	return string(buf)
}

func Get(url string) (*Response, error) {
	return DefaultClient.Get(url)
}

func Post(url, contentType string, body io.Reader) (*Response, error) {
	return DefaultClient.Post(url, contentType, body)
}

func Head(url string) (*Response, error) {
	return DefaultClient.Head(url)
}

func (c *Client) Get(url string) (*Response, error) {
	return doFetch(MethodGet, url, "", "")
}

func (c *Client) Head(url string) (*Response, error) {
	return doFetch(MethodHead, url, "", "")
}

func (c *Client) Post(url, contentType string, body io.Reader) (*Response, error) {
	return doFetch(MethodPost, url, readBody(body), contentType)
}

func (c *Client) Do(req *Request) (*Response, error) {
	ct := ""
	if req.Header != nil {
		ct = req.Header.Get("Content-Type")
	}
	return doFetch(req.Method, req.URL.String(), readBody(req.Body), ct)
}

func NewRequest(method, rawurl string, body io.Reader) (*Request, error) {
	u := parseRawURL(rawurl)
	req := &Request{
		Method:     method,
		URL:        u,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     Header{},
		Host:       u.Host,
	}
	if body != nil {
		req.Body = &readerCloser{body}
	}
	return req, nil
}

type readerCloser struct {
	io.Reader
}

func (rc *readerCloser) Close() error {
	return nil
}
