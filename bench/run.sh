#!/usr/bin/env bash
set -euo pipefail

# GoMode Benchmark: Native Go vs GoMode (TinyGo WASM on Wrangler)
#
# Compares identical HTTP handlers running as:
#   1. Native Go (compiled binary, net/http stdlib)
#   2. GoMode (TinyGo WASM on Cloudflare Workers via wrangler dev)
#
# Usage: ./bench/run.sh [requests] [concurrency]
#   requests:    total requests per endpoint (default: 5000)
#   concurrency: concurrent connections (default: 50)

REQUESTS="${1:-5000}"
CONCURRENCY="${2:-50}"
NATIVE_PORT=8788
GOMODE_PORT=8787

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS="$ROOT/bench/results"
mkdir -p "$RESULTS"

# Require hey
if ! command -v hey &>/dev/null; then
    echo "Install 'hey': brew install hey"
    exit 1
fi

cleanup() {
    echo ""
    echo "Cleaning up..."
    [ -n "${NATIVE_PID:-}" ] && kill "$NATIVE_PID" 2>/dev/null || true
    [ -n "${WRANGLER_PID:-}" ] && kill "$WRANGLER_PID" 2>/dev/null || true
    wait 2>/dev/null
}
trap cleanup EXIT

wait_for_server() {
    local port=$1 name=$2 max=30
    echo -n "Waiting for $name on :$port"
    for i in $(seq 1 $max); do
        if curl -s "http://localhost:$port/" > /dev/null 2>&1; then
            echo " ready!"
            return 0
        fi
        echo -n "."
        sleep 1
    done
    echo " TIMEOUT"
    return 1
}

run_hey() {
    local url=$1 label=$2
    shift 2
    echo "--- $label ---"
    hey -n "$REQUESTS" -c "$CONCURRENCY" "$@" "$url" 2>&1 | tee -a "$RESULTS/latest.txt"
    echo ""
}

OUTFILE="$RESULTS/latest.txt"
echo "GoMode Benchmark — $(date)" > "$OUTFILE"
echo "requests=$REQUESTS concurrency=$CONCURRENCY" >> "$OUTFILE"
echo "" >> "$OUTFILE"

echo "============================================"
echo " GoMode Benchmark"
echo " requests=$REQUESTS concurrency=$CONCURRENCY"
echo "============================================"
echo ""

# --- WASM binary size ---
WASM_SIZE=$(stat -f%z "$ROOT/worker/src/go.wasm" 2>/dev/null || stat -c%s "$ROOT/worker/src/go.wasm" 2>/dev/null || echo "0")
echo "WASM binary: $(echo "$WASM_SIZE / 1024" | bc)KB" | tee -a "$OUTFILE"
echo "" | tee -a "$OUTFILE"

# --- Native Go ---
echo "Building native Go server..."
cd "$ROOT/bench/native"
go build -o "$ROOT/build/bench-native" .
"$ROOT/build/bench-native" &
NATIVE_PID=$!
wait_for_server $NATIVE_PORT "native Go"

echo "" | tee -a "$OUTFILE"
echo "=== NATIVE GO (port $NATIVE_PORT) ===" | tee -a "$OUTFILE"
run_hey "http://localhost:$NATIVE_PORT/" "GET / (hello text)"
run_hey "http://localhost:$NATIVE_PORT/json" "GET /json (JSON encode)"

kill "$NATIVE_PID" 2>/dev/null; wait "$NATIVE_PID" 2>/dev/null || true
NATIVE_PID=""

# --- GoMode (wrangler dev) ---
echo "Starting GoMode (wrangler dev)..."
cd "$ROOT/worker"
npx wrangler dev --port $GOMODE_PORT 2>/dev/null &
WRANGLER_PID=$!
wait_for_server $GOMODE_PORT "GoMode (wrangler)"

echo "" | tee -a "$OUTFILE"
echo "=== GOMODE / TINYGO WASM (port $GOMODE_PORT) ===" | tee -a "$OUTFILE"
run_hey "http://localhost:$GOMODE_PORT/" "GET / (hello text)"
run_hey "http://localhost:$GOMODE_PORT/json" "GET /json (JSON encode)"
run_hey "http://localhost:$GOMODE_PORT/sha256?input=benchmark" "GET /sha256 (crypto)"
run_hey "http://localhost:$GOMODE_PORT/simd" "GET /simd (Zig SIMD ops)"
run_hey "http://localhost:$GOMODE_PORT/upper?text=hello+world" "GET /upper (string transform)"

kill "$WRANGLER_PID" 2>/dev/null; wait "$WRANGLER_PID" 2>/dev/null || true
WRANGLER_PID=""

echo "============================================" | tee -a "$OUTFILE"
echo " Results saved to bench/results/latest.txt" | tee -a "$OUTFILE"
echo "============================================"
