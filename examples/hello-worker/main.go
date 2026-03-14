package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"gomode"
	"net/http"
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

	http.ListenAndServe(":8080", nil)
}

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
	return http.HandleRequest(reqBase)
}
