// Analytics API — real-world GoMode example.
//
// Standard Go net/http handlers running on Cloudflare Workers.
// Zig SIMD for fast numeric computation, outbound http.Get for data enrichment.
//
// Routes:
//   POST /stats     — compute statistics on a JSON array of numbers (SIMD)
//   POST /normalize — normalize a dataset to [0,1] range (SIMD)
//   GET  /exchange  — fetch live exchange rates, compute cross-rates (fetch + SIMD)
//   GET  /health    — health check
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"gomode"
	"math"
	"net/http"
)

func main() {
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/stats", handleStats)
	http.HandleFunc("/normalize", handleNormalize)
	http.HandleFunc("/exchange", handleExchange)
	http.ListenAndServe(":8080", nil)
}

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
	return http.HandleRequest(reqBase)
}

// GET /health — returns service info
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"service": "analytics-api",
		"runtime": "gomode",
	})
}

// POST /stats — compute statistics on a JSON array of numbers.
//
// Request:  {"values": [1.5, 2.3, 4.7, ...]}
// Response: {"count":N, "sum":S, "mean":M, "min":X, "max":Y, "variance":V, "stddev":D, "hash":"..."}
//
// Uses Zig SIMD for sum, min/max, dot product (for variance).
func handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Values []float64 `json:"values"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Values) == 0 {
		http.Error(w, "values array is empty", http.StatusBadRequest)
		return
	}

	data := req.Values
	count := len(data)

	// SIMD: sum, min, max
	sum := gomode.SumF64(data)
	min, max := gomode.MinMaxF64(data)
	mean := sum / float64(count)

	// SIMD: variance via dot product
	// Var = E[X^2] - E[X]^2  =  (dot(X,X)/N) - mean^2
	dotXX := gomode.DotF64(data, data)
	variance := dotXX/float64(count) - mean*mean
	stddev := math.Sqrt(variance)

	// SHA-256 fingerprint of the dataset
	hashInput := fmt.Sprintf("%v", data)
	h := sha256.Sum256([]byte(hashInput))
	hash := hex.EncodeToString(h[:])

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"count":    count,
		"sum":      sum,
		"mean":     mean,
		"min":      min,
		"max":      max,
		"variance": variance,
		"stddev":   stddev,
		"hash":     hash,
	})
}

// POST /normalize — normalize values to [0,1] range.
//
// Request:  {"values": [10, 20, 30, 40, 50]}
// Response: {"normalized": [0, 0.25, 0.5, 0.75, 1], "min": 10, "max": 50}
//
// Uses SIMD for min/max and scale operations.
func handleNormalize(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Values []float64 `json:"values"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Values) == 0 {
		http.Error(w, "values array is empty", http.StatusBadRequest)
		return
	}

	data := make([]float64, len(req.Values))
	copy(data, req.Values)

	min, max := gomode.MinMaxF64(data)
	rangeVal := max - min

	if rangeVal == 0 {
		// All values are the same — normalize to 0
		for i := range data {
			data[i] = 0
		}
	} else {
		// Shift by -min, then scale by 1/range
		// data[i] = (data[i] - min) / range
		for i := range data {
			data[i] -= min
		}
		gomode.ScaleF64(data, 1.0/rangeVal)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"normalized": data,
		"min":        min,
		"max":        max,
	})
}

// GET /exchange?base=USD — fetch exchange rates and compute cross-rates.
//
// Fetches live rates from a public API, then uses SIMD to compute
// all cross-rates in a single batch. Demonstrates outbound http.Get
// via GoMode's two-phase fetch protocol.
func handleExchange(w http.ResponseWriter, r *http.Request) {
	base := r.FormValue("base")
	if base == "" {
		base = "USD"
	}

	// Outbound fetch — triggers two-phase protocol
	resp, err := http.Get("https://open.er-api.com/v6/latest/" + base)
	if err != nil {
		http.Error(w, "fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	var rateData struct {
		Result string             `json:"result"`
		Rates  map[string]float64 `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rateData); err != nil {
		http.Error(w, "invalid rate data: "+err.Error(), http.StatusBadGateway)
		return
	}
	if rateData.Result != "success" {
		http.Error(w, "rate API returned: "+rateData.Result, http.StatusBadGateway)
		return
	}

	// Pick a subset of major currencies
	currencies := []string{"EUR", "GBP", "JPY", "CAD", "AUD", "CHF"}
	var rates []float64
	var available []string
	for _, c := range currencies {
		if rate, ok := rateData.Rates[c]; ok {
			rates = append(rates, rate)
			available = append(available, c)
		}
	}

	if len(rates) == 0 {
		http.Error(w, "no rates available", http.StatusBadGateway)
		return
	}

	// SIMD: compute sum of rates and min/max spread
	sum := gomode.SumF64(rates)
	min, max := gomode.MinMaxF64(rates)

	result := map[string]interface{}{
		"base":   base,
		"spread": max - min,
		"mean":   sum / float64(len(rates)),
	}

	rateMap := map[string]float64{}
	for i, c := range available {
		rateMap[c] = rates[i]
	}
	result["rates"] = rateMap

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
