//! Bump allocator replacing TinyGo's malloc/free (nottinygc-style).
//!
//! Used with `-gc=custom -tags=custommalloc`:
//!   - `-gc=custom` makes TinyGo's runtime.alloc/free extern (we provide via Go //go:linkname)
//!   - `-tags=custommalloc` disables TinyGo's default malloc/free exports
//!   - This file exports malloc/free/calloc/realloc to fill the gap
//!
//! Single bump allocator for ALL memory (Go heap + Zig ABI allocations).
//! zig_heap_reset() reclaims everything — call between requests in DO mode.
//!
//! Layout:
//!   [stack | data segments | bump heap →→→ ]
//!   heap_base starts after current WASM memory pages.
//!   Each allocation bumps the pointer forward, aligned to 16 bytes.

const std = @import("std");

const ALIGN = 16;

var heap_base: usize = 0;
var heap_ptr: usize = 0;
var heap_end: usize = 0;

fn initHeap() void {
    const pages = @wasmMemorySize(0);
    heap_base = pages * 65536;
    const grow_pages: usize = 16;
    const result = @wasmMemoryGrow(0, grow_pages);
    if (result == std.math.maxInt(usize)) {
        heap_end = heap_base;
    } else {
        heap_end = heap_base + grow_pages * 65536;
    }
    heap_ptr = heap_base;
}

fn ensureCapacity(size: usize) bool {
    if (heap_ptr + size <= heap_end) return true;

    const needed = heap_ptr + size - heap_end;
    const pages_needed = (needed + 65535) / 65536;
    const grow_pages = if (pages_needed < 16) 16 else pages_needed;
    const result = @wasmMemoryGrow(0, grow_pages);
    if (result == std.math.maxInt(usize)) return false;
    heap_end += grow_pages * 65536;
    return true;
}

fn alignUp(addr: usize, alignment: usize) usize {
    return (addr + alignment - 1) & ~(alignment - 1);
}

// ============================================================================
// C ABI exports — replaces TinyGo's malloc/free (disabled by custommalloc tag)
// ============================================================================

pub export fn malloc(size: usize) ?[*]u8 {
    if (heap_base == 0) initHeap();
    if (size == 0) return null;

    const aligned_size = alignUp(size, ALIGN);
    if (!ensureCapacity(aligned_size)) return null;

    const ptr = heap_ptr;
    heap_ptr += aligned_size;
    return @ptrFromInt(ptr);
}

pub export fn free(_ptr: ?[*]u8) void {
    _ = _ptr;
}

pub export fn calloc(nmemb: usize, size: usize) ?[*]u8 {
    const total = nmemb * size;
    const ptr = malloc(total) orelse return null;
    const slice = ptr[0..total];
    @memset(slice, 0);
    return ptr;
}

pub export fn realloc(old_ptr: ?[*]u8, new_size: usize) ?[*]u8 {
    if (new_size == 0) {
        free(old_ptr);
        return null;
    }
    const new_ptr = malloc(new_size) orelse return null;
    if (old_ptr) |old| {
        const src: [*]const u8 = old;
        const dst: [*]u8 = new_ptr;
        @memcpy(dst[0..new_size], src[0..new_size]);
    }
    return new_ptr;
}

// ============================================================================
// Internal API — called by main.zig (zig_alloc, allocResult, etc.)
// ============================================================================

pub fn alloc(size: usize) ?[*]u8 {
    return malloc(size);
}

pub fn dealloc(ptr: ?[*]u8) void {
    free(ptr);
}

// ============================================================================
// Heap control — exported for per-request cleanup
// ============================================================================

/// Reset the bump allocator. ALL previous allocations (Go + Zig) become invalid.
/// Call between requests in DO mode to prevent unbounded memory growth.
pub export fn zig_heap_reset() void {
    heap_ptr = heap_base;
}

/// Get current heap usage in bytes.
pub export fn zig_heap_used() u32 {
    if (heap_base == 0) return 0;
    return @intCast(heap_ptr - heap_base);
}

/// Get total heap capacity in bytes.
pub export fn zig_heap_capacity() u32 {
    if (heap_base == 0) return 0;
    return @intCast(heap_end - heap_base);
}
