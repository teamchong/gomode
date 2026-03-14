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

	// GET /fetch — outbound http.Get via Asyncify
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

	http.ListenAndServe(":8080", nil)
}

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
	return http.HandleRequest(reqBase)
}
