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

// Two-phase fetch protocol (no Asyncify needed):
//
// Phase 1: Go handler calls http.Get() → doFetch stores the outbound URL and
// method in fetchURL/fetchMethod and sets fetchPending=true. The handler runs
// to completion with a zero-status Response. HandleRequest detects fetchPending
// and returns status=-1 to JS with the fetch URL in the body.
//
// JS reads the fetch params from the response, performs the actual fetch(),
// writes the result into WASM memory as zerobuf slots, then re-calls
// handle_zerobuf with the fetch result pointer in slot 4.
//
// Phase 2 (replay): HandleRequest reads the fetch result from slot 4,
// sets fetchResult, and re-runs the handler. doFetch returns the cached
// result. The handler completes normally.

var fetchURL string
var fetchMethod string
var fetchPending bool
var fetchResult *Response

// errFetchPending is returned by doFetch in phase 1 of the two-phase protocol.
// The handler sees this error and returns early without processing the response.
// HandleRequest detects fetchPending and signals JS to do the real fetch.
// On phase 2, doFetch returns the cached result with no error.
var errFetchPending = &httpError{"gomode: fetch pending"}

func doFetch(method, rawurl, body, contentType string) (*Response, error) {
	// Replay phase: JS already did the fetch and injected the result
	if fetchResult != nil {
		r := fetchResult
		fetchResult = nil
		return r, nil
	}

	// First phase: store the URL and method for HandleRequest to read.
	// Return an error so the handler exits early via its err != nil check.
	fetchURL = rawurl
	fetchMethod = method
	fetchPending = true
	return nil, errFetchPending
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
