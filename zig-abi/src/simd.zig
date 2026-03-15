//! WASM SIMD batch operations for columnar f64/i32 processing.
//!
//! Uses Zig's @Vector types which compile to WASM SIMD v128 instructions.
//! All functions operate on contiguous arrays in WASM linear memory.

const std = @import("std");

const VEC_F64_LEN = 2; // v128 holds 2 x f64
const VEC_I32_LEN = 4; // v128 holds 4 x i32

/// Sum all elements of an f64 slice using SIMD.
pub fn sumF64(data: []const f64) f64 {
    const len = data.len;
    if (len == 0) return 0;

    var acc: @Vector(VEC_F64_LEN, f64) = @splat(0);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const vecs: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data.ptr));
    for (0..chunks) |i| {
        acc += vecs[i];
    }

    var total: f64 = @reduce(.Add, acc);
    for (data[chunks * VEC_F64_LEN ..][0..remainder]) |v| {
        total += v;
    }
    return total;
}

/// Sum all elements of an i32 slice using SIMD. Returns i64 to avoid overflow.
pub fn sumI32(data: []const i32) i64 {
    const len = data.len;
    if (len == 0) return 0;

    var total: i64 = 0;
    const chunks = len / VEC_I32_LEN;
    const remainder = len % VEC_I32_LEN;

    const vecs: [*]const @Vector(VEC_I32_LEN, i32) = @alignCast(@ptrCast(data.ptr));
    for (0..chunks) |i| {
        const chunk = vecs[i];
        // Widen to i64 pairs and accumulate to avoid i32 overflow
        const lo: @Vector(2, i64) = .{ chunk[0], chunk[1] };
        const hi: @Vector(2, i64) = .{ chunk[2], chunk[3] };
        total += @reduce(.Add, lo) + @reduce(.Add, hi);
    }

    for (data[chunks * VEC_I32_LEN ..][0..remainder]) |v| {
        total += v;
    }
    return total;
}

/// Multiply each element by a scalar, in-place.
pub fn scaleF64(data: []f64, scalar: f64) void {
    const len = data.len;
    if (len == 0) return;

    const s: @Vector(VEC_F64_LEN, f64) = @splat(scalar);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const vecs: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data.ptr));
    for (0..chunks) |i| {
        vecs[i] *= s;
    }

    for (data[chunks * VEC_F64_LEN ..][0..remainder]) |*v| {
        v.* *= scalar;
    }
}

/// Element-wise addition: dst[i] = a[i] + b[i].
pub fn addF64(dst: []f64, a: []const f64, b: []const f64) void {
    const len = @min(dst.len, @min(a.len, b.len));
    if (len == 0) return;

    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const d: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(dst.ptr));
    const va: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(a.ptr));
    const vb: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(b.ptr));
    for (0..chunks) |i| {
        d[i] = va[i] + vb[i];
    }

    for (0..remainder) |i| {
        const idx = chunks * VEC_F64_LEN + i;
        dst[idx] = a[idx] + b[idx];
    }
}

/// Find min and max of an f64 slice.
/// Uses @select instead of @min/@max to avoid fmin/fmax libcall dependency.
pub fn minmaxF64(data: []const f64) struct { min: f64, max: f64 } {
    if (data.len == 0) return .{ .min = 0, .max = 0 };

    var min_val: f64 = data[0];
    var max_val: f64 = data[0];

    if (data.len >= VEC_F64_LEN) {
        var min_acc: @Vector(VEC_F64_LEN, f64) = @splat(data[0]);
        var max_acc: @Vector(VEC_F64_LEN, f64) = @splat(data[0]);

        const chunks = data.len / VEC_F64_LEN;
        const vecs: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data.ptr));

        for (0..chunks) |i| {
            const v = vecs[i];
            const lt = v < min_acc;
            const gt = v > max_acc;
            min_acc = @select(f64, lt, v, min_acc);
            max_acc = @select(f64, gt, v, max_acc);
        }

        // Reduce vectors to scalars
        inline for (0..VEC_F64_LEN) |lane| {
            if (min_acc[lane] < min_val) min_val = min_acc[lane];
            if (max_acc[lane] > max_val) max_val = max_acc[lane];
        }

        for (data[chunks * VEC_F64_LEN ..]) |v| {
            if (v < min_val) min_val = v;
            if (v > max_val) max_val = v;
        }
    } else {
        for (data[1..]) |v| {
            if (v < min_val) min_val = v;
            if (v > max_val) max_val = v;
        }
    }

    return .{ .min = min_val, .max = max_val };
}

/// Element-wise subtraction: dst[i] = a[i] - b[i].
pub fn subF64(dst: []f64, a: []const f64, b: []const f64) void {
    const len = @min(dst.len, @min(a.len, b.len));
    if (len == 0) return;

    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const d: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(dst.ptr));
    const va: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(a.ptr));
    const vb: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(b.ptr));
    for (0..chunks) |i| {
        d[i] = va[i] - vb[i];
    }

    for (0..remainder) |i| {
        const idx = chunks * VEC_F64_LEN + i;
        dst[idx] = a[idx] - b[idx];
    }
}

/// Element-wise multiplication: dst[i] = a[i] * b[i].
pub fn mulF64(dst: []f64, a: []const f64, b: []const f64) void {
    const len = @min(dst.len, @min(a.len, b.len));
    if (len == 0) return;

    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const d: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(dst.ptr));
    const va: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(a.ptr));
    const vb: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(b.ptr));
    for (0..chunks) |i| {
        d[i] = va[i] * vb[i];
    }

    for (0..remainder) |i| {
        const idx = chunks * VEC_F64_LEN + i;
        dst[idx] = a[idx] * b[idx];
    }
}

/// Clamp each element to [lo, hi] range, in-place.
pub fn clampF64(data: []f64, lo: f64, hi: f64) void {
    const len = data.len;
    if (len == 0) return;

    const lo_v: @Vector(VEC_F64_LEN, f64) = @splat(lo);
    const hi_v: @Vector(VEC_F64_LEN, f64) = @splat(hi);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const vecs: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data.ptr));
    for (0..chunks) |i| {
        var v = vecs[i];
        const lt = v < lo_v;
        const gt = v > hi_v;
        v = @select(f64, lt, lo_v, v);
        v = @select(f64, gt, hi_v, v);
        vecs[i] = v;
    }

    for (data[chunks * VEC_F64_LEN ..][0..remainder]) |*v| {
        if (v.* < lo) v.* = lo;
        if (v.* > hi) v.* = hi;
    }
}

/// Affine transform: data[i] = a * data[i] + b, in-place.
pub fn mapLinearF64(data: []f64, a: f64, b: f64) void {
    const len = data.len;
    if (len == 0) return;

    const a_v: @Vector(VEC_F64_LEN, f64) = @splat(a);
    const b_v: @Vector(VEC_F64_LEN, f64) = @splat(b);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const vecs: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data.ptr));
    for (0..chunks) |i| {
        vecs[i] = vecs[i] * a_v + b_v;
    }

    for (data[chunks * VEC_F64_LEN ..][0..remainder]) |*v| {
        v.* = a * v.* + b;
    }
}

/// Dot product of two f64 slices.
pub fn dotF64(a: []const f64, b: []const f64) f64 {
    const len = @min(a.len, b.len);
    if (len == 0) return 0;

    var acc: @Vector(VEC_F64_LEN, f64) = @splat(0);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const va: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(a.ptr));
    const vb: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(b.ptr));
    for (0..chunks) |i| {
        acc += va[i] * vb[i];
    }

    var total: f64 = @reduce(.Add, acc);
    for (0..remainder) |i| {
        const idx = chunks * VEC_F64_LEN + i;
        total += a[idx] * b[idx];
    }
    return total;
}
