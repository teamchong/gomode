package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"gomode"
	"net/http"
	"strconv"
	"strings"
)

// apiHandler is a struct that implements http.Handler — common pattern in real Go apps.
type apiHandler struct {
	version string
}

func (a *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"version": a.version,
		"runtime": "gomode",
	})
}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Hello from GoMode!")
	})

	http.HandleFunc("/json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"message": "Hello from GoMode!",
			"method":  r.Method,
			"path":    r.URL.Path,
		})
	})

	http.HandleFunc("/sha256", func(w http.ResponseWriter, r *http.Request) {
		input := r.FormValue("input")
		if input == "" {
			input = "hello"
		}
		hash := sha256.Sum256([]byte(input))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"input":  input,
			"sha256": hex.EncodeToString(hash[:]),
		})
	})

	http.HandleFunc("/upper", func(w http.ResponseWriter, r *http.Request) {
		input := r.FormValue("text")
		if input == "" {
			input = "hello gomode"
		}
		fmt.Fprintf(w, strings.ToUpper(input))
	})

	http.HandleFunc("/simd", func(w http.ResponseWriter, r *http.Request) {
		data := []float64{1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0}

		sum := gomode.SumF64(data)
		dot := gomode.DotF64(data, data)

		gomode.ScaleF64(data, 2.0)
		scaledSum := gomode.SumF64(data)

		min, max := gomode.MinMaxF64(data)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]float64{
			"sum":        sum,
			"dot":        dot,
			"scaled_sum": scaledSum,
			"min":        min,
			"max":        max,
		})
	})

	// ---- Conformance test endpoints ----

	// POST /echo — echoes form values, tests ParseForm/FormValue/PostFormValue
	http.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"method": r.Method,
			"name":   r.FormValue("name"),
			"age":    r.PostFormValue("age"),
			"query":  r.FormValue("q"),
		})
	})

	// GET /headers — echoes request headers back as JSON
	http.HandleFunc("/headers", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"user-agent": r.UserAgent(),
			"x-custom":   r.Header.Get("X-Custom"),
			"host":       r.Host,
			"accept":     r.Header.Get("Accept"),
		})
	})

	// GET /set-cookie — sets a cookie via SetCookie
	http.HandleFunc("/set-cookie", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name:  "session",
			Value: "abc123",
			Path:  "/",
		})
		fmt.Fprintf(w, "cookie set")
	})

	// GET /read-cookie — reads cookies from request
	http.HandleFunc("/read-cookie", func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session")
		if err != nil {
			http.Error(w, "no cookie", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"name":  c.Name,
			"value": c.Value,
		})
	})

	// GET /redirect — redirects to /json
	http.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/json", http.StatusFound)
	})

	// GET /status — returns custom status code
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		code, _ := strconv.Atoi(r.FormValue("code"))
		if code == 0 {
			code = 200
		}
		w.WriteHeader(code)
		fmt.Fprintf(w, "%d %s", code, http.StatusText(code))
	})

	// GET /basicauth — tests BasicAuth parsing
	http.HandleFunc("/basicauth", func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok {
			w.Header().Set("Www-Authenticate", `Basic realm="test"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"user": user,
			"pass": pass,
		})
	})

	// GET /fetch — outbound http.Get via two-phase fetch
	http.HandleFunc("/fetch", func(w http.ResponseWriter, r *http.Request) {
		url := r.FormValue("url")
		if url == "" {
			url = "https://example.com"
		}
		resp, err := http.Get(url)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":         resp.StatusCode,
			"content_length": resp.ContentLength,
		})
	})

	// ---- Real-world compatibility endpoints ----

	// Middleware pattern: func(http.Handler) http.Handler
	corsMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == "OPTIONS" {
				w.WriteHeader(204)
				return
			}
			next.ServeHTTP(w, r)
		})
	}

	// Handler struct pattern — implements http.Handler
	api := &apiHandler{version: "1.0.0"}
	http.Handle("/api/info", corsMiddleware(api))

	// Method-based routing
	http.HandleFunc("/api/items", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		switch r.Method {
		case "GET":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"items": []map[string]string{
					{"id": "1", "name": "alpha"},
					{"id": "2", "name": "beta"},
				},
			})
		case "POST":
			var body struct {
				Name string `json:"name"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"error":"invalid json"}`, 400)
				return
			}
			if body.Name == "" {
				http.Error(w, `{"error":"name required"}`, 422)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":      "3",
				"name":    body.Name,
				"created": true,
			})
		case "DELETE":
			w.WriteHeader(204)
		default:
			http.Error(w, `{"error":"method not allowed"}`, 405)
		}
	})

	// StripPrefix pattern
	http.Handle("/static/", http.StripPrefix("/static", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"stripped_path": r.URL.Path,
		})
	})))

	// Content negotiation via Accept header
	http.HandleFunc("/negotiate", func(w http.ResponseWriter, r *http.Request) {
		accept := r.Header.Get("Accept")
		switch {
		case strings.Contains(accept, "text/plain"):
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprintf(w, "version=1.0.0 status=ok")
		case strings.Contains(accept, "text/html"):
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, "<h1>Status: OK</h1>")
		default:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": "1.0.0"})
		}
	})

	// Multiple cookies + secure cookie attributes
	http.HandleFunc("/multi-cookie", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name:     "sid",
			Value:    "sess-abc",
			Path:     "/",
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteStrictMode,
		})
		http.SetCookie(w, &http.Cookie{
			Name:   "theme",
			Value:  "dark",
			Path:   "/",
			MaxAge: 86400,
		})
		fmt.Fprintf(w, "cookies set")
	})

	// MaxBytesReader — body size limiting
	http.HandleFunc("/limited", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 64)
		var body struct {
			Data string `json:"data"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"body too large or invalid"}`, 413)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"received": len(body.Data),
			"data":     body.Data,
		})
	})

	// Chained write — multiple w.Write calls build response
	http.HandleFunc("/chunked-write", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("line1\n"))
		w.Write([]byte("line2\n"))
		w.Write([]byte("line3\n"))
	})

	// Request context — URL parts, proto, method reflection
	http.HandleFunc("/reflect", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"method":       r.Method,
			"path":         r.URL.Path,
			"raw_query":    r.URL.RawQuery,
			"host":         r.Host,
			"proto":        r.Proto,
			"proto_at_1_1": r.ProtoAtLeast(1, 1),
			"request_uri":  r.RequestURI,
			"referer":      r.Referer(),
			"user_agent":   r.UserAgent(),
			"content_len":  r.ContentLength,
		})
	})

	// Multi-fetch — calls http.Get() twice in one handler
	http.HandleFunc("/multi-fetch", func(w http.ResponseWriter, r *http.Request) {
		url1 := r.FormValue("url1")
		url2 := r.FormValue("url2")
		if url1 == "" {
			url1 = "https://httpbin.org/get"
		}
		if url2 == "" {
			url2 = "https://example.com"
		}

		resp1, err := http.Get(url1)
		if err != nil {
			http.Error(w, "fetch1 failed: "+err.Error(), 502)
			return
		}

		resp2, err := http.Get(url2)
		if err != nil {
			http.Error(w, "fetch2 failed: "+err.Error(), 502)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"fetch1_status": resp1.StatusCode,
			"fetch1_length": resp1.ContentLength,
			"fetch2_status": resp2.StatusCode,
			"fetch2_length": resp2.ContentLength,
		})
	})

	// Large response — proves dynamic buffer works beyond old 16KB limit
	http.HandleFunc("/large", func(w http.ResponseWriter, r *http.Request) {
		sizeStr := r.FormValue("size")
		size := 32768 // default 32KB
		if sizeStr != "" {
			n, _ := strconv.Atoi(sizeStr)
			if n > 0 && n <= 1048576 {
				size = n
			}
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Body-Size", strconv.Itoa(size))
		buf := make([]byte, size)
		for i := range buf {
			buf[i] = byte('A' + (i % 26))
		}
		w.Write(buf)
	})

	http.ListenAndServe(":8080", nil)
}

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
	return http.HandleRequest(reqBase)
}
