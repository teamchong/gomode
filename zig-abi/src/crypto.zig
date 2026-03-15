//! Zig crypto operations for GoMode.
//! HMAC-SHA256 implementation using Zig's stdlib.

const std = @import("std");
const HmacSha256 = std.crypto.auth.hmac.sha2.HmacSha256;

/// Compute HMAC-SHA256(key, message) -> 32-byte digest.
/// Caller provides output buffer (must be >= 32 bytes).
pub fn hmacSha256(key: []const u8, message: []const u8, out: []u8) void {
    var mac: [HmacSha256.mac_length]u8 = undefined;
    HmacSha256.create(&mac, message, key);
    @memcpy(out[0..32], &mac);
}
