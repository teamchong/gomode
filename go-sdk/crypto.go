package gomode

import (
	"encoding/hex"
	"errors"
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

// SHA512 computes SHA-512(data) using Zig's stdlib crypto.
// Returns a 64-byte digest.
func SHA512(data []byte) [64]byte {
	var out [64]byte
	if len(data) == 0 {
		// SHA-512 of empty string is a known constant
		ZigSha512(0, 0, uint32(uintptr(unsafe.Pointer(&out[0]))))
		return out
	}
	dataPtr := uint32(uintptr(unsafe.Pointer(&data[0])))
	outPtr := uint32(uintptr(unsafe.Pointer(&out[0])))
	ZigSha512(dataPtr, uint32(len(data)), outPtr)
	return out
}

// SHA512Hex computes SHA-512 and returns the hex-encoded string.
func SHA512Hex(data []byte) string {
	digest := SHA512(data)
	return hex.EncodeToString(digest[:])
}

// Aes256GcmEncrypt encrypts plaintext with AES-256-GCM.
// key must be 32 bytes, nonce must be 12 bytes.
// Returns ciphertext with 16-byte auth tag appended.
func Aes256GcmEncrypt(key [32]byte, nonce [12]byte, plaintext, aad []byte) ([]byte, error) {
	out := make([]byte, len(plaintext)+16)
	keyPtr := uint32(uintptr(unsafe.Pointer(&key[0])))
	noncePtr := uint32(uintptr(unsafe.Pointer(&nonce[0])))

	var ptPtr, aadPtr uint32
	if len(plaintext) > 0 {
		ptPtr = uint32(uintptr(unsafe.Pointer(&plaintext[0])))
	}
	if len(aad) > 0 {
		aadPtr = uint32(uintptr(unsafe.Pointer(&aad[0])))
	}
	outPtr := uint32(uintptr(unsafe.Pointer(&out[0])))

	rc := ZigAes256GcmEncrypt(keyPtr, noncePtr, ptPtr, uint32(len(plaintext)), aadPtr, uint32(len(aad)), outPtr)
	if rc != 0 {
		return nil, errors.New("aes256gcm: encrypt failed")
	}
	return out, nil
}

// Aes256GcmDecrypt decrypts ciphertext with AES-256-GCM.
// key must be 32 bytes, nonce must be 12 bytes.
// ciphertext must include the 16-byte auth tag at the end.
// Returns plaintext on success, error on auth failure.
func Aes256GcmDecrypt(key [32]byte, nonce [12]byte, ciphertext, aad []byte) ([]byte, error) {
	if len(ciphertext) < 16 {
		return nil, errors.New("aes256gcm: ciphertext too short")
	}
	ptLen := len(ciphertext) - 16
	out := make([]byte, ptLen)

	keyPtr := uint32(uintptr(unsafe.Pointer(&key[0])))
	noncePtr := uint32(uintptr(unsafe.Pointer(&nonce[0])))
	ctPtr := uint32(uintptr(unsafe.Pointer(&ciphertext[0])))

	var aadPtr uint32
	if len(aad) > 0 {
		aadPtr = uint32(uintptr(unsafe.Pointer(&aad[0])))
	}

	var outPtr uint32
	if ptLen > 0 {
		outPtr = uint32(uintptr(unsafe.Pointer(&out[0])))
	}

	rc := ZigAes256GcmDecrypt(keyPtr, noncePtr, ctPtr, uint32(len(ciphertext)), aadPtr, uint32(len(aad)), outPtr)
	if rc != 0 {
		return nil, errors.New("aes256gcm: authentication failed")
	}
	return out, nil
}
