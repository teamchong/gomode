//! Host imports — minimal raw I/O surface.
//! Design: host provides ONLY raw I/O, all parsing in WASM.
//! Same philosophy as edgebox: ~12 host functions total.

// --- Networking (raw sockets) ---
extern "gomode_host" fn host_net_connect(host_ptr: [*]const u8, host_len: u32, port: u16) i32;
extern "gomode_host" fn host_net_send(fd: i32, ptr: [*]const u8, len: u32) i32;
extern "gomode_host" fn host_net_recv(fd: i32, ptr: [*]u8, len: u32) i32;
extern "gomode_host" fn host_net_close(fd: i32) void;

// --- Randomness ---
extern "gomode_host" fn host_random_get(ptr: [*]u8, len: u32) void;

// --- Time ---
extern "gomode_host" fn host_time_now() i64;

// --- Console ---
extern "gomode_host" fn host_console_log(ptr: [*]const u8, len: u32) void;

// --- KV Storage (CF Workers KV) ---
extern "gomode_host" fn host_kv_get(key_ptr: [*]const u8, key_len: u32, buf_ptr: [*]u8, buf_len: u32) i32;
extern "gomode_host" fn host_kv_put(key_ptr: [*]const u8, key_len: u32, val_ptr: [*]const u8, val_len: u32) i32;

// --- Public wrappers ---

pub fn netConnect(hostname: []const u8, port: u16) i32 {
    return host_net_connect(hostname.ptr, @intCast(hostname.len), port);
}

pub fn netSend(fd: i32, data: []const u8) i32 {
    return host_net_send(fd, data.ptr, @intCast(data.len));
}

pub fn netRecv(fd: i32, buf: []u8) i32 {
    return host_net_recv(fd, buf.ptr, @intCast(buf.len));
}

pub fn netClose(fd: i32) void {
    host_net_close(fd);
}

pub fn randomGet(buf: []u8) void {
    host_random_get(buf.ptr, @intCast(buf.len));
}

pub fn timeNow() i64 {
    return host_time_now();
}

pub fn consoleLog(msg: []const u8) void {
    host_console_log(msg.ptr, @intCast(msg.len));
}

pub fn kvGet(key: []const u8, buf: []u8) i32 {
    return host_kv_get(key.ptr, @intCast(key.len), buf.ptr, @intCast(buf.len));
}

pub fn kvPut(key: []const u8, value: []const u8) i32 {
    return host_kv_put(key.ptr, @intCast(key.len), value.ptr, @intCast(value.len));
}
