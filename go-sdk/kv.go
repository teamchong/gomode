package gomode

import (
	"encoding/json"
	"io"
	"net/http"
)

// KVGet reads a value from Cloudflare KV.
// Returns the value and true if found, empty string and false if not found.
// Uses the multi-fetch protocol: Go returns to JS, JS calls env.KV.get(), replays.
func KVGet(key string) (string, bool, error) {
	resp, err := http.DefaultClient.Do(mustNewRequest("__KV_GET", key))
	if err != nil {
		return "", false, err
	}
	if resp.StatusCode == 404 {
		return "", false, nil
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", false, &kvError{string(body)}
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false, err
	}
	return string(body), true, nil
}

// KVPut writes a value to Cloudflare KV.
func KVPut(key, value string) error {
	resp, err := http.DefaultClient.Do(mustNewRequestWithBody("__KV_PUT", key, value))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return &kvError{string(body)}
	}
	return nil
}

// KVDelete removes a key from Cloudflare KV.
func KVDelete(key string) error {
	resp, err := http.DefaultClient.Do(mustNewRequest("__KV_DELETE", key))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return &kvError{string(body)}
	}
	return nil
}

// KVList returns keys matching the given prefix from Cloudflare KV.
func KVList(prefix string) ([]string, error) {
	resp, err := http.DefaultClient.Do(mustNewRequest("__KV_LIST", prefix))
	if err != nil {
		return nil, err
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var keys []string
	if err := json.Unmarshal(body, &keys); err != nil {
		return nil, err
	}
	return keys, nil
}

func mustNewRequest(method, key string) *http.Request {
	req, _ := http.NewRequest(method, key, nil)
	return req
}

func mustNewRequestWithBody(method, key, body string) *http.Request {
	req, _ := http.NewRequest(method, key, &stringBody{s: body})
	return req
}

type stringBody struct {
	s   string
	pos int
}

func (sb *stringBody) Read(p []byte) (int, error) {
	if sb.pos >= len(sb.s) {
		return 0, io.EOF
	}
	n := copy(p, sb.s[sb.pos:])
	sb.pos += n
	return n, nil
}

type kvError struct {
	msg string
}

func (e *kvError) Error() string { return "kv: " + e.msg }
