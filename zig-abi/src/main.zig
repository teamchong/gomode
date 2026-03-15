//! GoMode Zig ABI — Zero-runtime-overhead exports for JS + Go.
//!
//! Memory management + SIMD batch operations.
//! Compiled with -mcpu=generic+simd128.
//!
//! Includes bump allocator that replaces TinyGo's malloc/free.

const std = @import("std");
pub const simd = @import("simd.zig");
pub const bump = @import("allocator.zig");

// Force allocator exports (malloc, free, calloc, realloc, zig_heap_*)
// to be included in the .o file. Without this, Zig's lazy compilation
// skips allocator.zig's export fns since nothing in main.zig calls them.
comptime {
    _ = &bump;
}

// ============================================================================
// Memory Management — uses bump allocator
// ============================================================================

export fn zig_alloc(len: u32) u32 {
    const ptr = bump.alloc(len) orelse return 0;
    return @intFromPtr(ptr);
}

export fn zig_free(ptr: u32, len: u32) void {
    _ = len;
    if (ptr == 0) return;
    bump.dealloc(@ptrFromInt(ptr));
}

export fn zig_free_result(ptr: u32) void {
    if (ptr == 0) return;
    bump.dealloc(@ptrFromInt(ptr));
}

export fn zig_result_len(ptr: u32) u32 {
    if (ptr == 0) return 0;
    const len_bytes = @as([*]const u8, @ptrFromInt(ptr))[0..4];
    return std.mem.readInt(u32, len_bytes, .little);
}

export fn zig_result_data(ptr: u32) u32 {
    if (ptr == 0) return 0;
    return ptr + 4;
}

pub fn allocResult(data: []const u8) u32 {
    const total = 4 + data.len;
    const buf_ptr = bump.alloc(total) orelse return 0;
    const buf = buf_ptr[0..total];
    std.mem.writeInt(u32, buf[0..4], @intCast(data.len), .little);
    @memcpy(buf[4..], data);
    return @intFromPtr(buf_ptr);
}

// ============================================================================
// SIMD Batch Operations
// ============================================================================

fn ptrToF64Slice(ptr: u32, count: u32) []const f64 {
    return @as([*]const f64, @ptrCast(@alignCast(@as([*]u8, @ptrFromInt(ptr)))))[0..count];
}

fn ptrToF64SliceMut(ptr: u32, count: u32) []f64 {
    return @as([*]f64, @ptrCast(@alignCast(@as([*]u8, @ptrFromInt(ptr)))))[0..count];
}

fn ptrToI32Slice(ptr: u32, count: u32) []const i32 {
    return @as([*]const i32, @ptrCast(@alignCast(@as([*]u8, @ptrFromInt(ptr)))))[0..count];
}

export fn zig_simd_sum_f64(ptr: u32, count: u32) f64 {
    if (ptr == 0 or count == 0) return 0;
    return simd.sumF64(ptrToF64Slice(ptr, count));
}

export fn zig_simd_sum_i32(ptr: u32, count: u32) i64 {
    if (ptr == 0 or count == 0) return 0;
    return simd.sumI32(ptrToI32Slice(ptr, count));
}

export fn zig_simd_scale_f64(ptr: u32, count: u32, scalar: f64) void {
    if (ptr == 0 or count == 0) return;
    simd.scaleF64(ptrToF64SliceMut(ptr, count), scalar);
}

export fn zig_simd_add_f64(dst_ptr: u32, a_ptr: u32, b_ptr: u32, count: u32) void {
    if (dst_ptr == 0 or a_ptr == 0 or b_ptr == 0 or count == 0) return;
    simd.addF64(ptrToF64SliceMut(dst_ptr, count), ptrToF64Slice(a_ptr, count), ptrToF64Slice(b_ptr, count));
}

export fn zig_simd_minmax_f64(ptr: u32, count: u32, out_ptr: u32) void {
    if (ptr == 0 or count == 0 or out_ptr == 0) return;
    const out = ptrToF64SliceMut(out_ptr, 2);
    const result = simd.minmaxF64(ptrToF64Slice(ptr, count));
    out[0] = result.min;
    out[1] = result.max;
}

export fn zig_simd_dot_f64(a_ptr: u32, b_ptr: u32, count: u32) f64 {
    if (a_ptr == 0 or b_ptr == 0 or count == 0) return 0;
    return simd.dotF64(ptrToF64Slice(a_ptr, count), ptrToF64Slice(b_ptr, count));
}

export fn zig_simd_sub_f64(dst_ptr: u32, a_ptr: u32, b_ptr: u32, count: u32) void {
    if (dst_ptr == 0 or a_ptr == 0 or b_ptr == 0 or count == 0) return;
    simd.subF64(ptrToF64SliceMut(dst_ptr, count), ptrToF64Slice(a_ptr, count), ptrToF64Slice(b_ptr, count));
}

export fn zig_simd_mul_f64(dst_ptr: u32, a_ptr: u32, b_ptr: u32, count: u32) void {
    if (dst_ptr == 0 or a_ptr == 0 or b_ptr == 0 or count == 0) return;
    simd.mulF64(ptrToF64SliceMut(dst_ptr, count), ptrToF64Slice(a_ptr, count), ptrToF64Slice(b_ptr, count));
}

export fn zig_simd_clamp_f64(ptr: u32, count: u32, lo: f64, hi: f64) void {
    if (ptr == 0 or count == 0) return;
    simd.clampF64(ptrToF64SliceMut(ptr, count), lo, hi);
}

export fn zig_simd_map_linear_f64(ptr: u32, count: u32, a: f64, b: f64) void {
    if (ptr == 0 or count == 0) return;
    simd.mapLinearF64(ptrToF64SliceMut(ptr, count), a, b);
}
