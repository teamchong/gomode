#ifndef ZIG_ABI_H
#define ZIG_ABI_H

#include <stdint.h>
#include <stddef.h>

// Bump allocator (replaces libc malloc with -tags=custommalloc)
void* malloc(size_t size);
void free(void* ptr);
void* calloc(size_t nmemb, size_t size);
void* realloc(void* ptr, size_t size);

// Memory management
uint32_t zig_alloc(uint32_t len);
void zig_free(uint32_t ptr, uint32_t len);
void zig_free_result(uint32_t ptr);
uint32_t zig_result_len(uint32_t ptr);
uint32_t zig_result_data(uint32_t ptr);

// Heap control
void zig_heap_reset(void);
uint32_t zig_heap_used(void);
uint32_t zig_heap_capacity(void);

// SIMD batch operations
double zig_simd_sum_f64(uint32_t ptr, uint32_t count);
int64_t zig_simd_sum_i32(uint32_t ptr, uint32_t count);
void zig_simd_scale_f64(uint32_t ptr, uint32_t count, double scalar);
void zig_simd_add_f64(uint32_t dst, uint32_t a, uint32_t b, uint32_t count);
void zig_simd_minmax_f64(uint32_t ptr, uint32_t count, uint32_t out);
double zig_simd_dot_f64(uint32_t a, uint32_t b, uint32_t count);
void zig_simd_sub_f64(uint32_t dst, uint32_t a, uint32_t b, uint32_t count);
void zig_simd_mul_f64(uint32_t dst, uint32_t a, uint32_t b, uint32_t count);
void zig_simd_clamp_f64(uint32_t ptr, uint32_t count, double lo, double hi);
void zig_simd_map_linear_f64(uint32_t ptr, uint32_t count, double a, double b);

#endif
