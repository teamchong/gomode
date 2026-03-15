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

func ZigSimdSubF64(dstPtr uint32, aPtr uint32, bPtr uint32, count uint32) {
	C.zig_simd_sub_f64(C.uint32_t(dstPtr), C.uint32_t(aPtr), C.uint32_t(bPtr), C.uint32_t(count))
}

func ZigSimdMulF64(dstPtr uint32, aPtr uint32, bPtr uint32, count uint32) {
	C.zig_simd_mul_f64(C.uint32_t(dstPtr), C.uint32_t(aPtr), C.uint32_t(bPtr), C.uint32_t(count))
}

func ZigSimdClampF64(ptr uint32, count uint32, lo float64, hi float64) {
	C.zig_simd_clamp_f64(C.uint32_t(ptr), C.uint32_t(count), C.double(lo), C.double(hi))
}

func ZigSimdMapLinearF64(ptr uint32, count uint32, a float64, b float64) {
	C.zig_simd_map_linear_f64(C.uint32_t(ptr), C.uint32_t(count), C.double(a), C.double(b))
}

// --- Crypto Operations ---

func ZigHmacSha256(keyPtr uint32, keyLen uint32, msgPtr uint32, msgLen uint32, outPtr uint32) {
	C.zig_hmac_sha256(C.uint32_t(keyPtr), C.uint32_t(keyLen), C.uint32_t(msgPtr), C.uint32_t(msgLen), C.uint32_t(outPtr))
}

func ZigSha512(dataPtr uint32, dataLen uint32, outPtr uint32) {
	C.zig_sha512(C.uint32_t(dataPtr), C.uint32_t(dataLen), C.uint32_t(outPtr))
}

func ZigAes256GcmEncrypt(keyPtr uint32, noncePtr uint32, ptPtr uint32, ptLen uint32, aadPtr uint32, aadLen uint32, outPtr uint32) uint32 {
	return uint32(C.zig_aes256gcm_encrypt(C.uint32_t(keyPtr), C.uint32_t(noncePtr), C.uint32_t(ptPtr), C.uint32_t(ptLen), C.uint32_t(aadPtr), C.uint32_t(aadLen), C.uint32_t(outPtr)))
}

func ZigAes256GcmDecrypt(keyPtr uint32, noncePtr uint32, ctPtr uint32, ctLen uint32, aadPtr uint32, aadLen uint32, outPtr uint32) uint32 {
	return uint32(C.zig_aes256gcm_decrypt(C.uint32_t(keyPtr), C.uint32_t(noncePtr), C.uint32_t(ctPtr), C.uint32_t(ctLen), C.uint32_t(aadPtr), C.uint32_t(aadLen), C.uint32_t(outPtr)))
}
