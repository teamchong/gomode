package main

import (
	"gomode"
	"unsafe"
)

// ============================================================================
// zerobuf layout constants (matches zerobuf spec)
// ============================================================================
//
// Tagged value slot = 16 bytes:
//   [tag:u8] [pad:3] [payloadA:u32] [payloadB:f64/i64]
//
// Tags: 0=null, 1=bool, 2=i32, 3=f64, 4=string, 5=array, 6=object, 7=bigint, 8=bytes
//
// String header: [byteLen:u32] [utf8 bytes...]
//
// Schema fields: field[i] is at base + i*16

const (
	tagI32    = 2
	tagString = 4

	valueSlot    = 16
	stringHeader = 4
)

const respSize = 3 * valueSlot // 48 bytes

var respBase uintptr
var respStrings [][]byte

func readZBString(slotAddr uintptr) string {
	headerPtr := uintptr(*(*uint32)(unsafe.Pointer(slotAddr + 4)))
	byteLen := *(*uint32)(unsafe.Pointer(headerPtr))
	if byteLen == 0 {
		return ""
	}
	bytes := unsafe.Slice((*byte)(unsafe.Pointer(headerPtr+stringHeader)), int(byteLen))
	return string(bytes)
}

func writeZBString(slotAddr uintptr, s string) {
	buf := make([]byte, stringHeader+len(s))
	*(*uint32)(unsafe.Pointer(&buf[0])) = uint32(len(s))
	copy(buf[stringHeader:], s)
	respStrings = append(respStrings, buf)

	*(*uint8)(unsafe.Pointer(slotAddr)) = tagString
	*(*uint32)(unsafe.Pointer(slotAddr + 4)) = uint32(uintptr(unsafe.Pointer(&buf[0])))
}

func writeZBI32(slotAddr uintptr, val int32) {
	*(*uint8)(unsafe.Pointer(slotAddr)) = tagI32
	*(*int32)(unsafe.Pointer(slotAddr + 4)) = val
}

func writeResponse(status int32, contentType string, body string) uint32 {
	resp := make([]byte, respSize)
	respStrings = respStrings[:0]
	respBase = uintptr(unsafe.Pointer(&resp[0]))

	writeZBI32(respBase+0*valueSlot, status)
	writeZBString(respBase+1*valueSlot, contentType)
	writeZBString(respBase+2*valueSlot, body)

	return uint32(respBase)
}

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
	reqAddr := uintptr(reqBase)

	method := readZBString(reqAddr + 0*valueSlot)
	path := readZBString(reqAddr + 1*valueSlot)

	switch path {
	case "/":
		return writeResponse(200, "text/plain", "Hello from GoMode!")

	case "/json":
		return writeResponse(200, "application/json",
			`{"message":"Hello from GoMode!","method":"`+method+`","path":"`+path+`"}`)

	case "/simd":
		return handleSimd()

	default:
		return writeResponse(404, "text/plain", "not found: "+path)
	}
}

func handleSimd() uint32 {
	// 8 f64 values in Go memory — Zig reads these directly via shared WASM memory
	data := []float64{1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0}
	ptr := uint32(uintptr(unsafe.Pointer(&data[0])))
	count := uint32(len(data))

	sum := gomode.ZigSimdSumF64(ptr, count)

	// Dot product with itself
	dot := gomode.ZigSimdDotF64(ptr, ptr, count)

	// Scale by 2.0 (in-place)
	gomode.ZigSimdScaleF64(ptr, count, 2.0)
	scaledSum := gomode.ZigSimdSumF64(ptr, count)

	// Min/max
	var minmax [2]float64
	outPtr := uint32(uintptr(unsafe.Pointer(&minmax[0])))
	gomode.ZigSimdMinmaxF64(ptr, count, outPtr)

	return writeResponse(200, "application/json",
		`{"sum":`+formatFloat(sum)+
			`,"dot":`+formatFloat(dot)+
			`,"scaled_sum":`+formatFloat(scaledSum)+
			`,"min":`+formatFloat(minmax[0])+
			`,"max":`+formatFloat(minmax[1])+`}`)
}

func formatFloat(f float64) string {
	if f == 0 {
		return "0"
	}
	neg := false
	if f < 0 {
		neg = true
		f = -f
	}
	whole := int64(f)
	frac := int64((f - float64(whole)) * 100)

	s := itoa(whole)
	if frac > 0 {
		s += "." + itoa(frac)
	}
	if neg {
		s = "-" + s
	}
	return s
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func main() {}
