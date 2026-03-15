//! Zig crypto operations for GoMode.
//! HMAC-SHA256, SHA-512, AES-256-GCM using Zig's stdlib.

const std = @import("std");
const HmacSha256 = std.crypto.auth.hmac.sha2.HmacSha256;
const Sha512 = std.crypto.hash.sha2.Sha512;
const Aes256Gcm = std.crypto.aead.aes_gcm.Aes256Gcm;

/// Compute HMAC-SHA256(key, message) -> 32-byte digest.
/// Caller provides output buffer (must be >= 32 bytes).
pub fn hmacSha256(key: []const u8, message: []const u8, out: []u8) void {
    var mac: [HmacSha256.mac_length]u8 = undefined;
    HmacSha256.create(&mac, message, key);
    @memcpy(out[0..32], &mac);
}

/// Compute SHA-512(data) -> 64-byte hash.
/// Caller provides output buffer (must be >= 64 bytes).
pub fn sha512(data: []const u8, out: []u8) void {
    var hash: [Sha512.digest_length]u8 = undefined;
    Sha512.hash(data, &hash, .{});
    @memcpy(out[0..64], &hash);
}

/// AES-256-GCM encrypt.
/// key: 32 bytes, nonce: 12 bytes, plaintext: arbitrary length.
/// Output: ciphertext (same length as plaintext) + 16-byte auth tag appended.
/// out buffer must be >= plaintext.len + 16.
/// Returns 0 on success, 1 on error.
pub fn aes256GcmEncrypt(
    key: *const [32]u8,
    nonce: *const [12]u8,
    plaintext: []const u8,
    aad: []const u8,
    out: []u8,
) u8 {
    if (out.len < plaintext.len + 16) return 1;
    var tag: [Aes256Gcm.tag_length]u8 = undefined;
    Aes256Gcm.encrypt(out[0..plaintext.len], &tag, plaintext, aad, nonce.*, key.*);
    @memcpy(out[plaintext.len..][0..16], &tag);
    return 0;
}

/// AES-256-GCM decrypt.
/// key: 32 bytes, nonce: 12 bytes, ciphertext: includes 16-byte tag at end.
/// out buffer must be >= ciphertext.len - 16.
/// Returns 0 on success, 1 on auth failure.
pub fn aes256GcmDecrypt(
    key: *const [32]u8,
    nonce: *const [12]u8,
    ciphertext: []const u8,
    aad: []const u8,
    out: []u8,
) u8 {
    if (ciphertext.len < 16) return 1;
    const ct_len = ciphertext.len - 16;
    if (out.len < ct_len) return 1;
    const tag = ciphertext[ct_len..][0..16];
    Aes256Gcm.decrypt(out[0..ct_len], ciphertext[0..ct_len], tag.*, aad, nonce.*, key.*) catch return 1;
    return 0;
}
