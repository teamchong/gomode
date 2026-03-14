//! GoMode Zig ABI — Zero-runtime-overhead exports for JS.
//!
//! This module provides the ABI surface that the CF Worker calls.
//! All complex logic runs in WASM, host provides only raw I/O.
//!
//! Memory model:
//! - JS reads/writes directly to wasm.memory (zero copy)
//! - zerobuf tagged values in linear memory for Proxy access
//! - SIMD batch operations for columnar f64/i32 processing
//! - Result format: [len:u32][data...], returns 0 on error
//!
//! Design:
//! 1. Minimal host imports (raw I/O only)
//! 2. All parsing/validation in WASM
//! 3. Pointer-based interface, no serialization
//! 4. Length-prefixed results for easy JS consumption

const std = @import("std");
pub const host = @import("host.zig");
pub const simd = @import("simd.zig");

const wasm_allocator = std.heap.wasm_allocator;

// ============================================================================
// Memory Management
// ============================================================================

/// Allocate memory in WASM linear memory.
/// JS calls this to write data into WASM without copy.
export fn zig_alloc(len: u32) u32 {
    const slice = wasm_allocator.alloc(u8, len) catch return 0;
    return @intFromPtr(slice.ptr);
}

/// Free memory previously allocated.
export fn zig_free(ptr: u32, len: u32) void {
    if (ptr == 0) return;
    const slice = @as([*]u8, @ptrFromInt(ptr))[0..len];
    wasm_allocator.free(slice);
}

/// Free a result buffer (reads length from 4-byte prefix).
export fn zig_free_result(ptr: u32) void {
    if (ptr == 0) return;
    const len_bytes = @as([*]const u8, @ptrFromInt(ptr))[0..4];
    const data_len = std.mem.readInt(u32, len_bytes, .little);
    const total = 4 + data_len;
    const slice = @as([*]u8, @ptrFromInt(ptr))[0..total];
    wasm_allocator.free(slice);
}

/// Get length of a result buffer.
export fn zig_result_len(ptr: u32) u32 {
    if (ptr == 0) return 0;
    const len_bytes = @as([*]const u8, @ptrFromInt(ptr))[0..4];
    return std.mem.readInt(u32, len_bytes, .little);
}

/// Get data pointer of a result buffer (skips 4-byte length prefix).
export fn zig_result_data(ptr: u32) u32 {
    if (ptr == 0) return 0;
    return ptr + 4;
}

/// Allocate a result buffer: [len:u32][data...]
pub fn allocResult(data: []const u8) u32 {
    const buf = wasm_allocator.alloc(u8, 4 + data.len) catch return 0;
    std.mem.writeInt(u32, buf[0..4], @intCast(data.len), .little);
    @memcpy(buf[4..], data);
    return @intFromPtr(buf.ptr);
}

// ============================================================================
// SIMD Batch Operations — columnar f64/i32 processing
// ============================================================================

/// Sum a contiguous f64 array using SIMD. Returns the sum.
/// ptr: pointer to f64[] in WASM memory, count: number of elements.
export fn zig_simd_sum_f64(ptr: u32, count: u32) f64 {
    if (ptr == 0 or count == 0) return 0;
    const data = @as([*]const f64, @alignCast(@ptrFromInt(ptr)))[0..count];
    return simd.sumF64(data);
}

/// Sum a contiguous i32 array using SIMD. Returns the sum as i64.
export fn zig_simd_sum_i32(ptr: u32, count: u32) i64 {
    if (ptr == 0 or count == 0) return 0;
    const data = @as([*]const i32, @alignCast(@ptrFromInt(ptr)))[0..count];
    return simd.sumI32(data);
}

/// Multiply each element of an f64 array by a scalar, in-place. SIMD-accelerated.
export fn zig_simd_scale_f64(ptr: u32, count: u32, scalar: f64) void {
    if (ptr == 0 or count == 0) return;
    const data = @as([*]f64, @alignCast(@ptrFromInt(ptr)))[0..count];
    simd.scaleF64(data, scalar);
}

/// Element-wise add two f64 arrays, result written to dst. SIMD-accelerated.
/// dst, src_a, src_b: pointers to f64[] in WASM memory.
export fn zig_simd_add_f64(dst_ptr: u32, a_ptr: u32, b_ptr: u32, count: u32) void {
    if (dst_ptr == 0 or a_ptr == 0 or b_ptr == 0 or count == 0) return;
    const dst = @as([*]f64, @alignCast(@ptrFromInt(dst_ptr)))[0..count];
    const a = @as([*]const f64, @alignCast(@ptrFromInt(a_ptr)))[0..count];
    const b = @as([*]const f64, @alignCast(@ptrFromInt(b_ptr)))[0..count];
    simd.addF64(dst, a, b);
}

/// Find min and max of an f64 array. Returns [min, max] packed as two f64.
/// out_ptr: pointer to f64[2] where [min, max] will be written.
export fn zig_simd_minmax_f64(ptr: u32, count: u32, out_ptr: u32) void {
    if (ptr == 0 or count == 0 or out_ptr == 0) return;
    const data = @as([*]const f64, @alignCast(@ptrFromInt(ptr)))[0..count];
    const out = @as([*]f64, @alignCast(@ptrFromInt(out_ptr)))[0..2];
    const result = simd.minmaxF64(data);
    out[0] = result.min;
    out[1] = result.max;
}

/// Dot product of two f64 arrays. SIMD-accelerated.
export fn zig_simd_dot_f64(a_ptr: u32, b_ptr: u32, count: u32) f64 {
    if (a_ptr == 0 or b_ptr == 0 or count == 0) return 0;
    const a = @as([*]const f64, @alignCast(@ptrFromInt(a_ptr)))[0..count];
    const b = @as([*]const f64, @alignCast(@ptrFromInt(b_ptr)))[0..count];
    return simd.dotF64(a, b);
}

// ============================================================================
// Host Import Forwarding (Go code calls these via Zig)
// ============================================================================

/// HTTP fetch via raw sockets — all HTTP formatting/parsing in WASM.
export fn zig_http_fetch(
    url_ptr: u32,
    url_len: u32,
    method: u32,
    headers_ptr: u32,
    headers_len: u32,
    body_ptr: u32,
    body_len: u32,
) u32 {
    const url = ptrToSlice(url_ptr, url_len) orelse return 0;

    var hostname_start: usize = 0;
    var port: u16 = 80;
    if (std.mem.startsWith(u8, url, "https://")) {
        hostname_start = 8;
        port = 443;
    } else if (std.mem.startsWith(u8, url, "http://")) {
        hostname_start = 7;
    } else {
        return 0;
    }

    var hostname_end = hostname_start;
    var path_start: usize = url.len;
    while (hostname_end < url.len) : (hostname_end += 1) {
        if (url[hostname_end] == ':') {
            const port_start = hostname_end + 1;
            var port_end = port_start;
            while (port_end < url.len and url[port_end] != '/') : (port_end += 1) {}
            port = std.fmt.parseInt(u16, url[port_start..port_end], 10) catch return 0;
            path_start = port_end;
            break;
        } else if (url[hostname_end] == '/') {
            path_start = hostname_end;
            break;
        }
    }

    const hostname = url[hostname_start..hostname_end];
    const path = if (path_start < url.len) url[path_start..] else "/";

    const fd = host.netConnect(hostname, port);
    if (fd < 0) return 0;

    const method_str: []const u8 = switch (method) {
        0 => "GET",
        1 => "POST",
        2 => "PUT",
        3 => "DELETE",
        4 => "PATCH",
        5 => "HEAD",
        else => "GET",
    };

    var req_buf = std.ArrayListUnmanaged(u8){};
    defer req_buf.deinit(wasm_allocator);

    req_buf.appendSlice(wasm_allocator, method_str) catch return 0;
    req_buf.appendSlice(wasm_allocator, " ") catch return 0;
    req_buf.appendSlice(wasm_allocator, path) catch return 0;
    req_buf.appendSlice(wasm_allocator, " HTTP/1.1\r\nHost: ") catch return 0;
    req_buf.appendSlice(wasm_allocator, hostname) catch return 0;
    req_buf.appendSlice(wasm_allocator, "\r\nConnection: close\r\n") catch return 0;

    const headers = if (headers_len > 0) ptrToSlice(headers_ptr, headers_len) else null;
    if (headers) |h| {
        req_buf.appendSlice(wasm_allocator, h) catch return 0;
    }

    const body = if (body_len > 0) ptrToSlice(body_ptr, body_len) else null;
    if (body) |b| {
        var cl_buf: [32]u8 = undefined;
        const cl_str = std.fmt.bufPrint(&cl_buf, "Content-Length: {d}\r\n", .{b.len}) catch return 0;
        req_buf.appendSlice(wasm_allocator, cl_str) catch return 0;
    }

    req_buf.appendSlice(wasm_allocator, "\r\n") catch return 0;

    var sent: usize = 0;
    while (sent < req_buf.items.len) {
        const n = host.netSend(fd, req_buf.items[sent..]);
        if (n <= 0) {
            host.netClose(fd);
            return 0;
        }
        sent += @intCast(n);
    }

    if (body) |b| {
        sent = 0;
        while (sent < b.len) {
            const n = host.netSend(fd, b[sent..]);
            if (n <= 0) {
                host.netClose(fd);
                return 0;
            }
            sent += @intCast(n);
        }
    }

    var resp_buf = std.ArrayListUnmanaged(u8){};
    defer resp_buf.deinit(wasm_allocator);

    var read_tmp: [4096]u8 = undefined;
    while (true) {
        const n = host.netRecv(fd, &read_tmp);
        if (n <= 0) break;
        resp_buf.appendSlice(wasm_allocator, read_tmp[0..@intCast(n)]) catch break;
    }
    host.netClose(fd);

    const resp = resp_buf.items;
    if (std.mem.indexOf(u8, resp, "\r\n\r\n")) |header_end| {
        const body_start = header_end + 4;
        return allocResult(resp[body_start..]);
    }

    return allocResult(resp);
}

/// Get environment variable via host import.
export fn zig_env_get(name_ptr: u32, name_len: u32) u32 {
    const name = ptrToSlice(name_ptr, name_len) orelse return 0;
    var buf: [8192]u8 = undefined;
    const len = host.kvGet(name, &buf);
    if (len < 0) return 0;
    return allocResult(buf[0..@intCast(len)]);
}

// ============================================================================
// Helpers
// ============================================================================

fn ptrToSlice(ptr: u32, len: u32) ?[]const u8 {
    if (ptr == 0 and len > 0) return null;
    if (len == 0) return &[_]u8{};
    return @as([*]const u8, @ptrFromInt(ptr))[0..len];
}
