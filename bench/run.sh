#!/usr/bin/env bash
set -euo pipefail

# GoMode Benchmark: Native Go vs GoMode (TinyGo WASM on Wrangler)
#
# Usage: ./bench/run.sh [duration] [connections] [threads]
#   duration:    wrk duration (default: 10s)
#   connections: concurrent connections (default: 50)
#   threads:     wrk threads (default: 4)

DURATION="${1:-10s}"
CONNECTIONS="${2:-50}"
THREADS="${3:-4}"
NATIVE_PORT=8788
GOMODE_PORT=8787

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS="$ROOT/bench/results"
mkdir -p "$RESULTS"

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

run_wrk() {
    local url=$1 label=$2
    echo "--- $label ---"
    wrk -t"$THREADS" -c"$CONNECTIONS" -d"$DURATION" "$url" 2>&1 | tee -a "$RESULTS/latest.txt"
    echo ""
}

echo "============================================"
echo " GoMode Benchmark"
echo " duration=$DURATION connections=$CONNECTIONS threads=$THREADS"
echo "============================================"
echo ""
echo "$(date)" > "$RESULTS/latest.txt"
echo "duration=$DURATION connections=$CONNECTIONS threads=$THREADS" >> "$RESULTS/latest.txt"
echo "" >> "$RESULTS/latest.txt"

# --- WASM binary size ---
WASM_SIZE=$(ls -lh "$ROOT/build/go.wasm" 2>/dev/null | awk '{print $5}')
echo "WASM binary size: ${WASM_SIZE:-not built}" | tee -a "$RESULTS/latest.txt"
echo "" | tee -a "$RESULTS/latest.txt"

# --- Native Go ---
echo "Starting native Go server..."
cd "$ROOT/bench/native"
go build -o "$ROOT/build/bench-native" .
"$ROOT/build/bench-native" &
NATIVE_PID=$!
wait_for_server $NATIVE_PORT "native Go"

echo "" | tee -a "$RESULTS/latest.txt"
echo "=== NATIVE GO (port $NATIVE_PORT) ===" | tee -a "$RESULTS/latest.txt"
run_wrk "http://localhost:$NATIVE_PORT/" "GET /"
run_wrk "http://localhost:$NATIVE_PORT/json" "GET /json"

kill "$NATIVE_PID" 2>/dev/null; wait "$NATIVE_PID" 2>/dev/null || true
NATIVE_PID=""

# --- GoMode (wrangler dev) ---
echo "Starting GoMode (wrangler dev)..."
cd "$ROOT/worker"
npx wrangler dev --port $GOMODE_PORT &
WRANGLER_PID=$!
wait_for_server $GOMODE_PORT "GoMode (wrangler)"

echo "" | tee -a "$RESULTS/latest.txt"
echo "=== GOMODE / TINYGO WASM (port $GOMODE_PORT) ===" | tee -a "$RESULTS/latest.txt"
run_wrk "http://localhost:$GOMODE_PORT/" "GET /"
run_wrk "http://localhost:$GOMODE_PORT/json" "GET /json"

kill "$WRANGLER_PID" 2>/dev/null; wait "$WRANGLER_PID" 2>/dev/null || true
WRANGLER_PID=""

echo "============================================"
echo " Results saved to bench/results/latest.txt"
echo "============================================"
