// Package gomode provides the Go SDK for writing Cloudflare Workers in Go.
//
// Zig ABI functions are linked directly into the same WASM binary via CGo.
// Go and Zig share the same linear memory — Go passes raw pointers to Zig
// functions, zero copy, zero overhead (direct wasm call instruction).
package gomode

/*
#include "zig_abi.h"
*/
import "C"

// --- Heap Control ---

func ZigHeapReset() {
	C.zig_heap_reset()
}

func ZigHeapUsed() uint32 {
	return uint32(C.zig_heap_used())
}

func ZigHeapCapacity() uint32 {
	return uint32(C.zig_heap_capacity())
}

// --- Memory Management ---

func ZigAlloc(len uint32) uint32 {
	return uint32(C.zig_alloc(C.uint32_t(len)))
}

func ZigFree(ptr uint32, len uint32) {
	C.zig_free(C.uint32_t(ptr), C.uint32_t(len))
}

func ZigFreeResult(ptr uint32) {
	C.zig_free_result(C.uint32_t(ptr))
}

func ZigResultLen(ptr uint32) uint32 {
	return uint32(C.zig_result_len(C.uint32_t(ptr)))
}

func ZigResultData(ptr uint32) uint32 {
	return uint32(C.zig_result_data(C.uint32_t(ptr)))
}

// --- SIMD Batch Operations ---

func ZigSimdSumF64(ptr uint32, count uint32) float64 {
	return float64(C.zig_simd_sum_f64(C.uint32_t(ptr), C.uint32_t(count)))
}

func ZigSimdSumI32(ptr uint32, count uint32) int64 {
	return int64(C.zig_simd_sum_i32(C.uint32_t(ptr), C.uint32_t(count)))
}

func ZigSimdScaleF64(ptr uint32, count uint32, scalar float64) {
	C.zig_simd_scale_f64(C.uint32_t(ptr), C.uint32_t(count), C.double(scalar))
}

func ZigSimdAddF64(dstPtr uint32, aPtr uint32, bPtr uint32, count uint32) {
	C.zig_simd_add_f64(C.uint32_t(dstPtr), C.uint32_t(aPtr), C.uint32_t(bPtr), C.uint32_t(count))
}

func ZigSimdMinmaxF64(ptr uint32, count uint32, outPtr uint32) {
	C.zig_simd_minmax_f64(C.uint32_t(ptr), C.uint32_t(count), C.uint32_t(outPtr))
}

func ZigSimdDotF64(aPtr uint32, bPtr uint32, count uint32) float64 {
	return float64(C.zig_simd_dot_f64(C.uint32_t(aPtr), C.uint32_t(bPtr), C.uint32_t(count)))
}
