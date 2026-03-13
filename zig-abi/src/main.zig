//! GoMode Zig ABI — Zero-runtime-overhead exports for JS.
//!
//! This module provides the ABI surface that the CF Worker calls.
//! All complex logic runs in WASM, host provides only raw I/O.
//!
//! Memory model:
//! - JS reads/writes directly to wasm.memory (zero copy)
//! - Columnar data laid out in linear memory for Proxy access
//! - Result format: [len:u32][data...], returns 0 on error
//!
//! Design:
//! 1. Minimal host imports (raw I/O only)
//! 2. All parsing/validation in WASM
//! 3. Pointer-based interface, no serialization
//! 4. Length-prefixed results for easy JS consumption

const std = @import("std");
pub const host = @import("host.zig");
pub const columnar = @import("columnar.zig");

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
// Columnar Table ABI
// ============================================================================

/// Create a new columnar table.
/// Returns table handle (pointer), 0 on error.
export fn zig_table_create(n_cols: u32) u32 {
    return columnar.tableCreate(n_cols);
}

/// Add a column to a table.
/// col_type: 0=i32, 1=i64, 2=f32, 3=f64, 4=bytes (varlen)
export fn zig_table_add_column(table: u32, name_ptr: u32, name_len: u32, col_type: u32) i32 {
    return columnar.tableAddColumn(table, name_ptr, name_len, col_type);
}

/// Reserve rows in the table (pre-allocates column buffers).
export fn zig_table_reserve(table: u32, n_rows: u32) i32 {
    return columnar.tableReserve(table, n_rows);
}

/// Push an i32 value to a column.
export fn zig_table_push_i32(table: u32, col_idx: u32, value: i32) i32 {
    return columnar.tablePushI32(table, col_idx, value);
}

/// Push an f64 value to a column.
export fn zig_table_push_f64(table: u32, col_idx: u32, value: f64) i32 {
    return columnar.tablePushF64(table, col_idx, value);
}

/// Push bytes (string) to a varlen column.
export fn zig_table_push_bytes(table: u32, col_idx: u32, data_ptr: u32, data_len: u32) i32 {
    return columnar.tablePushBytes(table, col_idx, data_ptr, data_len);
}

/// Get column data pointer (for JS Proxy direct read).
/// Returns pointer to raw column data in linear memory.
export fn zig_table_column_ptr(table: u32, col_idx: u32) u32 {
    return columnar.tableColumnPtr(table, col_idx);
}

/// Get column offset array pointer (for varlen columns).
export fn zig_table_column_offsets(table: u32, col_idx: u32) u32 {
    return columnar.tableColumnOffsets(table, col_idx);
}

/// Get number of rows in table.
export fn zig_table_row_count(table: u32) u32 {
    return columnar.tableRowCount(table);
}

/// Free a table and all its column data.
export fn zig_table_free(table: u32) void {
    columnar.tableFree(table);
}

// ============================================================================
// Host Import Forwarding (Go code calls these via Zig)
// ============================================================================

/// HTTP fetch via raw sockets — all HTTP formatting/parsing in WASM.
/// Parses URL, opens socket via host, sends HTTP/1.1 request, reads response.
/// method: 0=GET, 1=POST, 2=PUT, 3=DELETE, 4=PATCH, 5=HEAD
/// Returns result pointer [len:u32][response_body...], 0 on error.
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

    // Parse URL: skip "http://" or "https://"
    var hostname_start: usize = 0;
    var port: u16 = 80;
    if (std.mem.startsWith(u8, url, "https://")) {
        hostname_start = 8;
        port = 443;
    } else if (std.mem.startsWith(u8, url, "http://")) {
        hostname_start = 7;
    } else {
        return 0; // unsupported scheme
    }

    // Find end of hostname (: or / or end)
    var hostname_end = hostname_start;
    var path_start: usize = url.len;
    while (hostname_end < url.len) : (hostname_end += 1) {
        if (url[hostname_end] == ':') {
            // Parse port
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

    // Connect
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

    // Build HTTP/1.1 request
    var req_buf = std.ArrayListUnmanaged(u8){};
    defer req_buf.deinit(wasm_allocator);

    req_buf.appendSlice(wasm_allocator, method_str) catch return 0;
    req_buf.appendSlice(wasm_allocator, " ") catch return 0;
    req_buf.appendSlice(wasm_allocator, path) catch return 0;
    req_buf.appendSlice(wasm_allocator, " HTTP/1.1\r\nHost: ") catch return 0;
    req_buf.appendSlice(wasm_allocator, hostname) catch return 0;
    req_buf.appendSlice(wasm_allocator, "\r\nConnection: close\r\n") catch return 0;

    // Append custom headers
    const headers = if (headers_len > 0) ptrToSlice(headers_ptr, headers_len) else null;
    if (headers) |h| {
        req_buf.appendSlice(wasm_allocator, h) catch return 0;
    }

    // Content-Length for body
    const body = if (body_len > 0) ptrToSlice(body_ptr, body_len) else null;
    if (body) |b| {
        var cl_buf: [32]u8 = undefined;
        const cl_str = std.fmt.bufPrint(&cl_buf, "Content-Length: {d}\r\n", .{b.len}) catch return 0;
        req_buf.appendSlice(wasm_allocator, cl_str) catch return 0;
    }

    req_buf.appendSlice(wasm_allocator, "\r\n") catch return 0;

    // Send request line + headers
    var sent: usize = 0;
    while (sent < req_buf.items.len) {
        const n = host.netSend(fd, req_buf.items[sent..]);
        if (n <= 0) {
            host.netClose(fd);
            return 0;
        }
        sent += @intCast(n);
    }

    // Send body
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

    // Read response
    var resp_buf = std.ArrayListUnmanaged(u8){};
    defer resp_buf.deinit(wasm_allocator);

    var read_tmp: [4096]u8 = undefined;
    while (true) {
        const n = host.netRecv(fd, &read_tmp);
        if (n <= 0) break;
        resp_buf.appendSlice(wasm_allocator, read_tmp[0..@intCast(n)]) catch break;
    }
    host.netClose(fd);

    // Find body after \r\n\r\n
    const resp = resp_buf.items;
    if (std.mem.indexOf(u8, resp, "\r\n\r\n")) |header_end| {
        const body_start = header_end + 4;
        return allocResult(resp[body_start..]);
    }

    // No header separator found — return entire response
    return allocResult(resp);
}

/// Get environment variable via host import.
/// Returns result pointer [len:u32][value...], 0 if not found.
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
