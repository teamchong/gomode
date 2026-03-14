//go:build gc.custom

// Provides TinyGo's custom GC interface, routing all allocations to
// the Zig bump allocator. Used with: -gc=custom -tags=custommalloc
//
// TinyGo's gc_custom.go declares these 7 functions as extern.
// We provide them via //go:linkname, calling Zig's malloc via CGo.

package gomode

/*
#include "zig_abi.h"
*/
import "C"
import (
	"runtime"
	"unsafe"
)

//go:linkname initHeap runtime.initHeap
func initHeap() {
	// Zig bump allocator self-initializes on first malloc call
}

//go:linkname alloc runtime.alloc
func alloc(size uintptr, layout unsafe.Pointer) unsafe.Pointer {
	_ = layout
	if size == 0 {
		return nil
	}
	ptr := C.malloc(C.size_t(size))
	if ptr == nil {
		return nil
	}
	return unsafe.Pointer(ptr)
}

//go:linkname free runtime.free
func free(ptr unsafe.Pointer) {
	C.free(ptr)
}

//go:linkname markRoots runtime.markRoots
func markRoots(start, end uintptr) {
	// No GC — bump allocator, no roots to mark
}

//go:linkname markStack runtime.markStack
func markStack()

//go:linkname GC runtime.GC
func GC() {
	// No-op for bump allocator
}

//go:linkname SetFinalizer runtime.SetFinalizer
func SetFinalizer(obj interface{}, finalizer interface{}) {
	// No-op — bump allocator has no finalizer support
}

//go:linkname ReadMemStats runtime.ReadMemStats
func ReadMemStats(ms *runtime.MemStats) {
	ms.HeapInuse = uint64(C.zig_heap_used())
	ms.HeapSys = uint64(C.zig_heap_capacity())
	ms.TotalAlloc = uint64(C.zig_heap_used())
	ms.Sys = uint64(C.zig_heap_capacity())
}
