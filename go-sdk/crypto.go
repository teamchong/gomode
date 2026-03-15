package gomode

import (
	"encoding/hex"
	"unsafe"
)

// HmacSHA256 computes HMAC-SHA256(key, message) using Zig's stdlib crypto.
// Returns a 32-byte digest.
func HmacSHA256(key, message []byte) [32]byte {
	var out [32]byte
	if len(key) == 0 || len(message) == 0 {
		return out
	}
	keyPtr := uint32(uintptr(unsafe.Pointer(&key[0])))
	msgPtr := uint32(uintptr(unsafe.Pointer(&message[0])))
	outPtr := uint32(uintptr(unsafe.Pointer(&out[0])))
	ZigHmacSha256(keyPtr, uint32(len(key)), msgPtr, uint32(len(message)), outPtr)
	return out
}

// HmacSHA256Hex computes HMAC-SHA256 and returns the hex-encoded string.
func HmacSHA256Hex(key, message []byte) string {
	digest := HmacSHA256(key, message)
	return hex.EncodeToString(digest[:])
}
