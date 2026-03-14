package gomode

import "unsafe"

// SumF64 returns the sum of a float64 slice using WASM SIMD.
func SumF64(data []float64) float64 {
	if len(data) == 0 {
		return 0
	}
	ptr := uint32(uintptr(unsafe.Pointer(&data[0])))
	return ZigSimdSumF64(ptr, uint32(len(data)))
}

// SumI32 returns the sum of an int32 slice using WASM SIMD.
func SumI32(data []int32) int64 {
	if len(data) == 0 {
		return 0
	}
	ptr := uint32(uintptr(unsafe.Pointer(&data[0])))
	return ZigSimdSumI32(ptr, uint32(len(data)))
}

// DotF64 returns the dot product of two float64 slices using WASM SIMD.
func DotF64(a, b []float64) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	aPtr := uint32(uintptr(unsafe.Pointer(&a[0])))
	bPtr := uint32(uintptr(unsafe.Pointer(&b[0])))
	return ZigSimdDotF64(aPtr, bPtr, uint32(len(a)))
}

// ScaleF64 multiplies every element of a float64 slice by a scalar (in-place) using WASM SIMD.
func ScaleF64(data []float64, scalar float64) {
	if len(data) == 0 {
		return
	}
	ptr := uint32(uintptr(unsafe.Pointer(&data[0])))
	ZigSimdScaleF64(ptr, uint32(len(data)), scalar)
}

// AddF64 adds two float64 slices element-wise into dst using WASM SIMD.
func AddF64(dst, a, b []float64) {
	if len(a) == 0 || len(b) == 0 {
		return
	}
	dstPtr := uint32(uintptr(unsafe.Pointer(&dst[0])))
	aPtr := uint32(uintptr(unsafe.Pointer(&a[0])))
	bPtr := uint32(uintptr(unsafe.Pointer(&b[0])))
	ZigSimdAddF64(dstPtr, aPtr, bPtr, uint32(len(a)))
}

// MinMaxF64 returns the min and max of a float64 slice in one pass using WASM SIMD.
func MinMaxF64(data []float64) (min, max float64) {
	if len(data) == 0 {
		return 0, 0
	}
	var result [2]float64
	ptr := uint32(uintptr(unsafe.Pointer(&data[0])))
	outPtr := uint32(uintptr(unsafe.Pointer(&result[0])))
	ZigSimdMinmaxF64(ptr, uint32(len(data)), outPtr)
	return result[0], result[1]
}
