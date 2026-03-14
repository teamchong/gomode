package main

import (
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
	tagNull   = 0
	tagI32    = 2
	tagString = 4

	valueSlot    = 16
	stringHeader = 4
)

// ============================================================================
// Request schema: [method, path] — JS writes, Go reads
// ============================================================================
// Field 0: method (string) at reqBase + 0*16
// Field 1: path   (string) at reqBase + 1*16

// ============================================================================
// Response schema: [status, contentType, body] — Go writes, JS reads
// ============================================================================
// Field 0: status      (i32)    at respBase + 0*16
// Field 1: contentType (string) at respBase + 1*16
// Field 2: body        (string) at respBase + 2*16

const respSize = 3 * valueSlot // 48 bytes

// Response buffer in WASM memory — Go writes response here
var respBase uintptr

// String storage — keep references alive for GC
var respStrings [][]byte

// readZBString reads a zerobuf string from a tagged value slot.
// The slot has tag=4 at offset+0, string header ptr at offset+4.
func readZBString(slotAddr uintptr) string {
	headerPtr := uintptr(*(*uint32)(unsafe.Pointer(slotAddr + 4)))
	byteLen := *(*uint32)(unsafe.Pointer(headerPtr))
	if byteLen == 0 {
		return ""
	}
	bytes := unsafe.Slice((*byte)(unsafe.Pointer(headerPtr+stringHeader)), int(byteLen))
	return string(bytes)
}

// writeZBString writes a string as a zerobuf tagged value at slotAddr.
// Allocates a string header + data in Go memory.
func writeZBString(slotAddr uintptr, s string) {
	// Allocate [byteLen:u32][utf8 bytes...]
	buf := make([]byte, stringHeader+len(s))
	*(*uint32)(unsafe.Pointer(&buf[0])) = uint32(len(s))
	copy(buf[stringHeader:], s)
	respStrings = append(respStrings, buf) // keep alive

	// Write tag=4 (string) and header pointer
	*(*uint8)(unsafe.Pointer(slotAddr)) = tagString
	*(*uint32)(unsafe.Pointer(slotAddr + 4)) = uint32(uintptr(unsafe.Pointer(&buf[0])))
}

// writeZBI32 writes an i32 as a zerobuf tagged value at slotAddr.
func writeZBI32(slotAddr uintptr, val int32) {
	*(*uint8)(unsafe.Pointer(slotAddr)) = tagI32
	*(*int32)(unsafe.Pointer(slotAddr + 4)) = val
}

//export handle_zerobuf
func handleZerobuf(reqBase uint32) uint32 {
	reqAddr := uintptr(reqBase)

	// Read request fields from zerobuf schema layout
	method := readZBString(reqAddr + 0*valueSlot)
	path := readZBString(reqAddr + 1*valueSlot)

	// Allocate response buffer (3 tagged value slots = 48 bytes)
	resp := make([]byte, respSize)
	respStrings = respStrings[:0] // reset string refs
	respBase = uintptr(unsafe.Pointer(&resp[0]))

	// Route and write response
	switch path {
	case "/":
		writeZBI32(respBase+0*valueSlot, 200)
		writeZBString(respBase+1*valueSlot, "text/plain")
		writeZBString(respBase+2*valueSlot, "Hello from GoMode!")
	case "/json":
		writeZBI32(respBase+0*valueSlot, 200)
		writeZBString(respBase+1*valueSlot, "application/json")
		writeZBString(respBase+2*valueSlot, `{"message":"Hello from GoMode!","method":"`+method+`","path":"`+path+`"}`)
	default:
		writeZBI32(respBase+0*valueSlot, 404)
		writeZBString(respBase+1*valueSlot, "text/plain")
		writeZBString(respBase+2*valueSlot, "not found: "+path)
	}

	return uint32(respBase)
}

func main() {}
