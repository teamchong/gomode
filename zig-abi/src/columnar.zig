//! Columnar data format for zero-copy data exchange.
//!
//! Layout in WASM linear memory (Arrow-like):
//! - Fixed-width columns: contiguous arrays (i32[], f64[], etc.)
//! - Variable-width columns: offset array + data buffer
//!
//! JS uses Proxy objects that read directly from these column pointers
//! via DataView on wasm.memory — no deserialization needed.
//!
//! Example: a table with columns [id: i32, name: bytes, score: f64]
//!   id column:    [1, 2, 3, 4]           ← i32[] at some ptr
//!   name offsets: [0, 5, 8, 14]          ← u32[] offsets
//!   name data:    "AliceBobCharlie..."    ← u8[] buffer
//!   score column: [9.5, 8.2, 7.1, 9.9]  ← f64[] at some ptr
//!
//! JS Proxy reads row 2: { id: view.getInt32(id_ptr + 2*4), ... }

const std = @import("std");

const wasm_allocator = std.heap.wasm_allocator;

pub const ColType = enum(u32) {
    i32 = 0,
    i64 = 1,
    f32 = 2,
    f64 = 3,
    bytes = 4, // variable-length
};

const Column = struct {
    name: []const u8,
    col_type: ColType,
    // Fixed-width data buffer
    data: []u8,
    capacity: u32,
    len: u32,
    // Variable-length: offset array
    offsets: []u32,
    offsets_capacity: u32,
    offsets_len: u32,
    // Variable-length: data buffer
    vardata: []u8,
    vardata_capacity: u32,
    vardata_len: u32,
};

const Table = struct {
    columns: []Column,
    n_cols: u32,
    n_rows: u32,
};

// Simple table registry (handles)
var tables: [64]?*Table = [_]?*Table{null} ** 64;
var next_table: u32 = 0;

fn getTable(handle: u32) ?*Table {
    if (handle == 0 or handle > 64) return null;
    return tables[handle - 1];
}

pub fn tableCreate(n_cols: u32) u32 {
    const table = wasm_allocator.create(Table) catch return 0;
    table.* = Table{
        .columns = wasm_allocator.alloc(Column, n_cols) catch {
            wasm_allocator.destroy(table);
            return 0;
        },
        .n_cols = n_cols,
        .n_rows = 0,
    };
    for (table.columns) |*col| {
        col.* = Column{
            .name = &[_]u8{},
            .col_type = .i32,
            .data = &[_]u8{},
            .capacity = 0,
            .len = 0,
            .offsets = &[_]u32{},
            .offsets_capacity = 0,
            .offsets_len = 0,
            .vardata = &[_]u8{},
            .vardata_capacity = 0,
            .vardata_len = 0,
        };
    }

    const handle = next_table;
    next_table = (next_table + 1) % 64;
    if (tables[handle]) |old| {
        freeTableInner(old);
    }
    tables[handle] = table;
    return handle + 1;
}

pub fn tableAddColumn(table_handle: u32, name_ptr: u32, name_len: u32, col_type: u32) i32 {
    const table = getTable(table_handle) orelse return -1;

    // Find first uninitialized column
    for (table.columns) |*col| {
        if (col.name.len == 0) {
            const name = wasm_allocator.alloc(u8, name_len) catch return -1;
            if (name_ptr != 0 and name_len > 0) {
                const src = @as([*]const u8, @ptrFromInt(name_ptr))[0..name_len];
                @memcpy(name, src);
            }
            col.name = name;
            col.col_type = @enumFromInt(col_type);
            return 0;
        }
    }
    return -1; // all columns used
}

pub fn tableReserve(table_handle: u32, n_rows: u32) i32 {
    const table = getTable(table_handle) orelse return -1;

    for (table.columns) |*col| {
        if (col.name.len == 0) continue;
        const elem_size: u32 = switch (col.col_type) {
            .i32, .f32 => 4,
            .i64, .f64 => 8,
            .bytes => 4, // offsets are u32
        };
        const needed = n_rows * elem_size;
        if (col.capacity < needed) {
            const new_data = wasm_allocator.alloc(u8, needed) catch return -1;
            if (col.data.len > 0) {
                @memcpy(new_data[0..col.data.len], col.data);
                wasm_allocator.free(col.data);
            }
            col.data = new_data;
            col.capacity = needed;
        }
        if (col.col_type == .bytes and col.offsets_capacity < n_rows + 1) {
            const new_offsets = wasm_allocator.alloc(u32, n_rows + 1) catch return -1;
            if (col.offsets.len > 0) {
                @memcpy(new_offsets[0..col.offsets.len], col.offsets);
                wasm_allocator.free(col.offsets);
            }
            col.offsets = new_offsets;
            col.offsets_capacity = n_rows + 1;
        }
    }
    return 0;
}

pub fn tablePushI32(table_handle: u32, col_idx: u32, value: i32) i32 {
    const table = getTable(table_handle) orelse return -1;
    if (col_idx >= table.n_cols) return -1;
    const col = &table.columns[col_idx];
    const offset = col.len * 4;
    if (offset + 4 > col.capacity) {
        // Grow
        const new_cap = @max(col.capacity * 2, 64);
        const new_data = wasm_allocator.alloc(u8, new_cap) catch return -1;
        if (col.data.len > 0) {
            @memcpy(new_data[0..@min(col.data.len, new_cap)], col.data[0..@min(col.data.len, new_cap)]);
            wasm_allocator.free(col.data);
        }
        col.data = new_data;
        col.capacity = new_cap;
    }
    std.mem.writeInt(i32, col.data[offset..][0..4], value, .little);
    col.len += 1;
    table.n_rows = @max(table.n_rows, col.len);
    return 0;
}

pub fn tablePushF64(table_handle: u32, col_idx: u32, value: f64) i32 {
    const table = getTable(table_handle) orelse return -1;
    if (col_idx >= table.n_cols) return -1;
    const col = &table.columns[col_idx];
    const offset = col.len * 8;
    if (offset + 8 > col.capacity) {
        const new_cap = @max(col.capacity * 2, 128);
        const new_data = wasm_allocator.alloc(u8, new_cap) catch return -1;
        if (col.data.len > 0) {
            @memcpy(new_data[0..@min(col.data.len, new_cap)], col.data[0..@min(col.data.len, new_cap)]);
            wasm_allocator.free(col.data);
        }
        col.data = new_data;
        col.capacity = new_cap;
    }
    std.mem.writeInt(u64, col.data[offset..][0..8], @bitCast(value), .little);
    col.len += 1;
    table.n_rows = @max(table.n_rows, col.len);
    return 0;
}

pub fn tablePushBytes(table_handle: u32, col_idx: u32, data_ptr: u32, data_len: u32) i32 {
    const table = getTable(table_handle) orelse return -1;
    if (col_idx >= table.n_cols) return -1;
    const col = &table.columns[col_idx];

    // Record offset
    if (col.offsets_len + 1 >= col.offsets_capacity) {
        const new_cap = @max(col.offsets_capacity * 2, 32);
        const new_offsets = wasm_allocator.alloc(u32, new_cap) catch return -1;
        if (col.offsets.len > 0) {
            @memcpy(new_offsets[0..col.offsets.len], col.offsets);
            wasm_allocator.free(col.offsets);
        }
        col.offsets = new_offsets;
        col.offsets_capacity = new_cap;
    }
    col.offsets[col.offsets_len] = col.vardata_len;
    col.offsets_len += 1;

    // Append data
    if (col.vardata_len + data_len > col.vardata_capacity) {
        const new_cap = @max(col.vardata_capacity * 2, col.vardata_len + data_len + 256);
        const new_vardata = wasm_allocator.alloc(u8, new_cap) catch return -1;
        if (col.vardata.len > 0) {
            @memcpy(new_vardata[0..col.vardata.len], col.vardata);
            wasm_allocator.free(col.vardata);
        }
        col.vardata = new_vardata;
        col.vardata_capacity = new_cap;
    }
    if (data_ptr != 0 and data_len > 0) {
        const src = @as([*]const u8, @ptrFromInt(data_ptr))[0..data_len];
        @memcpy(col.vardata[col.vardata_len .. col.vardata_len + data_len], src);
    }
    col.vardata_len += data_len;

    // End offset
    col.offsets[col.offsets_len] = col.vardata_len;

    col.len += 1;
    table.n_rows = @max(table.n_rows, col.len);
    return 0;
}

pub fn tableColumnPtr(table_handle: u32, col_idx: u32) u32 {
    const table = getTable(table_handle) orelse return 0;
    if (col_idx >= table.n_cols) return 0;
    const col = &table.columns[col_idx];
    if (col.col_type == .bytes) {
        return @intFromPtr(col.vardata.ptr);
    }
    return @intFromPtr(col.data.ptr);
}

pub fn tableColumnOffsets(table_handle: u32, col_idx: u32) u32 {
    const table = getTable(table_handle) orelse return 0;
    if (col_idx >= table.n_cols) return 0;
    const col = &table.columns[col_idx];
    if (col.col_type != .bytes) return 0;
    return @intFromPtr(col.offsets.ptr);
}

pub fn tableRowCount(table_handle: u32) u32 {
    const table = getTable(table_handle) orelse return 0;
    return table.n_rows;
}

fn freeTableInner(table: *Table) void {
    for (table.columns) |*col| {
        if (col.name.len > 0) wasm_allocator.free(col.name);
        if (col.data.len > 0) wasm_allocator.free(col.data);
        if (col.offsets.len > 0) wasm_allocator.free(col.offsets);
        if (col.vardata.len > 0) wasm_allocator.free(col.vardata);
    }
    wasm_allocator.free(table.columns);
    wasm_allocator.destroy(table);
}

pub fn tableFree(table_handle: u32) void {
    if (table_handle == 0 or table_handle > 64) return;
    if (tables[table_handle - 1]) |table| {
        freeTableInner(table);
        tables[table_handle - 1] = null;
    }
}
