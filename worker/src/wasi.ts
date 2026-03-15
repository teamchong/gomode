/**
 * GoMode WASI — R2-backed virtual filesystem for Go on WebAssembly.
 *
 * Architecture:
 *   R2 (FS_BUCKET)      — persistent file storage (cold tier, ~10-50ms)
 *   DO SQLite            — file index: path, size, mode, mtime, is_dir (warm tier, <1ms)
 *   In-memory Map        — active VFS during WASM execution (hot tier, <1μs)
 *
 * Lifecycle:
 *   1. On DO init: load file index from SQLite, pre-load file contents from R2
 *   2. During WASM execution: WASI syscalls read/write in-memory maps (synchronous)
 *   3. After handler completes: flush dirty files to R2, update SQLite index
 *
 * Preopen directories:
 *   fd 3 = /tmp   (writable, in-memory only — not persisted to R2)
 *   fd 4 = /data  (writable, persisted to R2)
 *
 * Go's os.Open, os.Create, os.ReadFile, os.MkdirAll, os.TempDir, io/ioutil,
 * and all stdlib filesystem operations work through these WASI syscalls.
 */

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

// WASI error codes
const ESUCCESS = 0;
const EBADF = 8;
const EEXIST = 20;
const EINVAL = 28;
const ENOENT = 44;
const ENOSYS = 52;
const ENOTEMPTY = 55;

interface OpenFile {
  path: string;
  data: Uint8Array;
  offset: number;
  isDir: boolean;
  writable: boolean;
}

/** Files that were written during WASM execution, pending R2 flush. */
interface DirtyFile {
  path: string;
  data: Uint8Array;
}

/**
 * R2-backed filesystem state. Created once per DO lifetime.
 * Worker mode creates a fresh instance per request (no R2, /tmp only).
 */
export class WasiFs {
  /** In-memory file contents: normalized path → data */
  readonly files = new Map<string, Uint8Array>();
  /** Directory index: normalized path → child names */
  readonly dirChildren = new Map<string, string[]>();
  /** Files written during this request, to be flushed to R2 */
  readonly dirty = new Map<string, DirtyFile>();
  /** Files deleted during this request, to be removed from R2 */
  readonly deleted = new Set<string>();

  constructor() {
    // /tmp always exists (in-memory only, not persisted)
    this.dirChildren.set("tmp", []);
    // /data always exists (R2-backed)
    this.dirChildren.set("data", []);
  }

  /** Register a file in the directory index. */
  registerFile(path: string): void {
    const parts = path.split("/");
    const dir = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1];
    this.ensureDir(dir);
    const list = this.dirChildren.get(dir)!;
    if (!list.includes(name)) list.push(name);
  }

  /** Ensure a directory and all parents exist in the index. */
  ensureDir(path: string): void {
    if (!path || this.dirChildren.has(path)) return;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.dirChildren.has(dir)) {
        this.dirChildren.set(dir, []);
        const parent = parts.slice(0, i - 1).join("/");
        if (!this.dirChildren.has(parent)) this.dirChildren.set(parent, []);
        const parentList = this.dirChildren.get(parent)!;
        const name = parts[i - 1];
        if (!parentList.includes(name)) parentList.push(name);
      }
    }
  }

  /** Remove a child entry from its parent directory listing. */
  removeFromParent(fullPath: string): void {
    const parts = fullPath.split("/");
    const name = parts.pop()!;
    const parent = parts.join("/");
    const siblings = this.dirChildren.get(parent);
    if (siblings) {
      const idx = siblings.indexOf(name);
      if (idx !== -1) siblings.splice(idx, 1);
    }
  }

  /** Check if path is a directory. */
  isDir(path: string): boolean {
    return this.dirChildren.has(path);
  }

  /** Check if a file exists (not directory). */
  fileExists(path: string): boolean {
    return this.files.has(path);
  }

  /** Mark a /data file as dirty (needs R2 flush). /tmp files are never dirty. */
  markDirty(path: string, data: Uint8Array): void {
    if (path.startsWith("data/")) {
      this.dirty.set(path, { path, data });
    }
  }

  /** Mark a /data file as deleted (needs R2 delete). */
  markDeleted(path: string): void {
    if (path.startsWith("data/")) {
      this.deleted.add(path);
      this.dirty.delete(path);
    }
  }
}

/**
 * Pre-load files from R2 into the in-memory VFS.
 * Called once on DO init. Populates both files map and directory index.
 */
export async function preloadFromR2(
  fs: WasiFs,
  bucket: R2Bucket,
  workspace: string,
  sql: { exec: (query: string, ...params: unknown[]) => { toArray: () => Record<string, unknown>[] } }
): Promise<void> {
  // Load file index from SQLite
  const rows = sql.exec(
    "SELECT path, size, is_dir FROM files"
  ).toArray();

  for (const row of rows) {
    const path = row.path as string;
    const isDir = (row.is_dir as number) === 1;

    if (isDir) {
      fs.ensureDir(path);
    } else {
      // Load file content from R2
      const key = `${workspace}/${path}`;
      const obj = await bucket.get(key);
      if (obj) {
        const data = new Uint8Array(await obj.arrayBuffer());
        fs.files.set(path, data);
        fs.registerFile(path);
      }
    }
  }
}

/**
 * Flush dirty files to R2 and update SQLite index.
 * Called after each handler invocation completes.
 */
export async function flushToR2(
  fs: WasiFs,
  bucket: R2Bucket,
  workspace: string,
  sql: { exec: (query: string, ...params: unknown[]) => { toArray: () => Record<string, unknown>[] } }
): Promise<void> {
  const now = Date.now();

  // Flush written files
  for (const [path, dirty] of fs.dirty) {
    const key = `${workspace}/${path}`;
    await bucket.put(key, dirty.data);
    sql.exec(
      `INSERT OR REPLACE INTO files (path, r2_key, size, mode, mtime, is_dir)
       VALUES (?, ?, ?, ?, ?, 0)`,
      path, key, dirty.data.byteLength, 0o644, now
    );
  }
  fs.dirty.clear();

  // Delete removed files
  for (const path of fs.deleted) {
    const key = `${workspace}/${path}`;
    await bucket.delete(key);
    sql.exec("DELETE FROM files WHERE path = ?", path);
  }
  fs.deleted.clear();

  // Persist directory entries
  for (const [dirPath] of fs.dirChildren) {
    if (dirPath.startsWith("data/") || dirPath === "data") {
      sql.exec(
        `INSERT OR IGNORE INTO files (path, r2_key, size, mode, mtime, is_dir)
         VALUES (?, '', 0, ?, ?, 1)`,
        dirPath, 0o755, now
      );
    }
  }
}

/**
 * Initialize SQLite schema for the filesystem index.
 * Called once on DO creation.
 */
export function initSchema(
  sql: { exec: (query: string, ...params: unknown[]) => { toArray: () => Record<string, unknown>[] } }
): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      r2_key TEXT NOT NULL,
      size INTEGER NOT NULL,
      mode INTEGER NOT NULL DEFAULT 420,
      mtime INTEGER NOT NULL,
      is_dir INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/**
 * Build WASI imports backed by the given WasiFs instance.
 * All filesystem syscalls operate on the in-memory VFS synchronously.
 */
export function buildWasiImports(
  getMemory: () => WebAssembly.Memory,
  wasiFs: WasiFs,
  label?: string
): Record<string, WebAssembly.ImportValue> {
  const FD_STDIN = 0;
  const FD_STDOUT = 1;
  const FD_STDERR = 2;
  const FD_TMP_PREOPEN = 3;
  const FD_DATA_PREOPEN = 4;

  const tmpPreopenBytes = _encoder.encode("/tmp");
  const dataPreopenBytes = _encoder.encode("/data");

  const preopenPaths: Record<number, { bytes: Uint8Array }> = {
    [FD_TMP_PREOPEN]: { bytes: tmpPreopenBytes },
    [FD_DATA_PREOPEN]: { bytes: dataPreopenBytes },
  };

  const openFiles = new Map<number, OpenFile>();
  let nextFd = FD_DATA_PREOPEN + 1;

  const logPrefix = label ? `[gomode:${label}:stderr]` : "[gomode:stderr]";

  function view(): DataView { return new DataView(getMemory().buffer); }
  function u8(): Uint8Array { return new Uint8Array(getMemory().buffer); }

  function normalizePath(p: string): string {
    const parts = p.split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part !== "." && part !== "") resolved.push(part);
    }
    return resolved.join("/");
  }

  function resolvePath(dirFd: number, relPath: string): string | null {
    if (dirFd === FD_TMP_PREOPEN) return normalizePath("tmp/" + relPath);
    if (dirFd === FD_DATA_PREOPEN) return normalizePath("data/" + relPath);
    const dir = openFiles.get(dirFd);
    if (!dir) return null;
    if (dir.path === "") return normalizePath(relPath);
    return normalizePath(dir.path + "/" + relPath);
  }

  return {
    args_get: () => ESUCCESS,

    args_sizes_get: (argc: number, argvBufSize: number) => {
      const v = view();
      v.setUint32(argc, 0, true);
      v.setUint32(argvBufSize, 0, true);
      return ESUCCESS;
    },

    environ_get: () => ESUCCESS,

    environ_sizes_get: (count: number, size: number) => {
      const v = view();
      v.setUint32(count, 0, true);
      v.setUint32(size, 0, true);
      return ESUCCESS;
    },

    clock_time_get: (_id: number, _precision: bigint, out: number) => {
      view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
      return ESUCCESS;
    },

    fd_write: (fd: number, iovsPtr: number, iovsLen: number, retPtr: number) => {
      const v = view();
      const m = u8();
      let written = 0;

      if (fd === FD_STDOUT || fd === FD_STDERR) {
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovsPtr + i * 8, true);
          const len = v.getUint32(iovsPtr + i * 8 + 4, true);
          if (fd === FD_STDERR) {
            console.log(logPrefix, _decoder.decode(new Uint8Array(getMemory().buffer, ptr, len)));
          }
          written += len;
        }
        v.setUint32(retPtr, written, true);
        return ESUCCESS;
      }

      const file = openFiles.get(fd);
      if (!file || !file.writable) return EBADF;

      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovsPtr + i * 8, true);
        const len = v.getUint32(iovsPtr + i * 8 + 4, true);
        const chunk = m.slice(ptr, ptr + len);

        const needed = file.offset + chunk.length;
        if (needed > file.data.length) {
          const grown = new Uint8Array(needed);
          grown.set(file.data);
          file.data = grown;
        }
        file.data.set(chunk, file.offset);
        file.offset += chunk.length;
        written += chunk.length;
      }

      // Update in-memory VFS and mark dirty
      wasiFs.files.set(file.path, file.data);
      wasiFs.markDirty(file.path, file.data);
      v.setUint32(retPtr, written, true);
      return ESUCCESS;
    },

    fd_read: (fd: number, iovsPtr: number, iovsLen: number, retPtr: number) => {
      if (fd === FD_STDIN) {
        view().setUint32(retPtr, 0, true);
        return ESUCCESS;
      }
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      const v = view();
      const m = u8();
      let totalRead = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovsPtr + i * 8, true);
        const len = v.getUint32(iovsPtr + i * 8 + 4, true);
        const remaining = file.data.length - file.offset;
        const toRead = Math.min(len, remaining);
        if (toRead > 0) {
          m.set(file.data.subarray(file.offset, file.offset + toRead), ptr);
          file.offset += toRead;
          totalRead += toRead;
        }
        if (toRead < len) break;
      }
      v.setUint32(retPtr, totalRead, true);
      return ESUCCESS;
    },

    fd_seek: (fd: number, offset: bigint, whence: number, retPtr: number) => {
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      const off = Number(offset);
      let newOffset: number;
      if (whence === 0) newOffset = off;
      else if (whence === 1) newOffset = file.offset + off;
      else if (whence === 2) newOffset = file.data.length + off;
      else return EINVAL;
      if (newOffset < 0) return EINVAL;
      file.offset = newOffset;
      view().setBigUint64(retPtr, BigInt(file.offset), true);
      return ESUCCESS;
    },

    fd_close: (fd: number) => {
      if (fd <= FD_DATA_PREOPEN) return ESUCCESS;
      openFiles.delete(fd);
      return ESUCCESS;
    },

    fd_fdstat_get: (fd: number, retPtr: number) => {
      const v = view();
      const m = u8();
      m.fill(0, retPtr, retPtr + 24);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr, 2); // CHARACTER_DEVICE
        v.setBigUint64(retPtr + 8, BigInt(0x1FF), true);
        v.setBigUint64(retPtr + 16, BigInt(0x1FF), true);
        return ESUCCESS;
      }
      if (fd === FD_TMP_PREOPEN || fd === FD_DATA_PREOPEN) {
        v.setUint8(retPtr, 3); // DIRECTORY
        v.setBigUint64(retPtr + 8, BigInt(0x1FFFFFF), true);
        v.setBigUint64(retPtr + 16, BigInt(0x1FFFFFF), true);
        return ESUCCESS;
      }
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      v.setUint8(retPtr, file.isDir ? 3 : 4); // DIRECTORY or REGULAR_FILE
      v.setBigUint64(retPtr + 8, BigInt(0x1FFFFFF), true);
      v.setBigUint64(retPtr + 16, BigInt(0x1FFFFFF), true);
      return ESUCCESS;
    },

    fd_fdstat_set_flags: () => ESUCCESS,

    fd_prestat_get: (fd: number, retPtr: number) => {
      const preopen = preopenPaths[fd];
      if (preopen) {
        const v = view();
        v.setUint8(retPtr, 0); // PREOPENTYPE_DIR
        v.setUint32(retPtr + 4, preopen.bytes.length, true);
        return ESUCCESS;
      }
      return EBADF;
    },

    fd_prestat_dir_name: (fd: number, pathPtr: number, pathLen: number) => {
      const preopen = preopenPaths[fd];
      if (preopen) {
        u8().set(preopen.bytes.subarray(0, pathLen), pathPtr);
        return ESUCCESS;
      }
      return EBADF;
    },

    path_open: (
      dirFd: number, _dirflags: number,
      pathPtr: number, pathLen: number,
      oflags: number, _fsRightsBase: bigint, _fsRightsInheriting: bigint,
      _fdflags: number, retPtr: number
    ) => {
      const pathStr = _decoder.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;

      const OFLAGS_CREAT = 1;
      const OFLAGS_EXCL = 4;
      const OFLAGS_TRUNC = 8;

      if (oflags & OFLAGS_CREAT) {
        if ((oflags & OFLAGS_EXCL) && wasiFs.fileExists(fullPath)) return EEXIST;
        const fd = nextFd++;
        if (!wasiFs.files.has(fullPath) || (oflags & OFLAGS_TRUNC)) {
          wasiFs.files.set(fullPath, new Uint8Array(0));
        }
        wasiFs.registerFile(fullPath);
        openFiles.set(fd, {
          path: fullPath,
          data: wasiFs.files.get(fullPath)!,
          offset: 0,
          isDir: false,
          writable: true,
        });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }

      const data = wasiFs.files.get(fullPath);
      if (data) {
        const fd = nextFd++;
        openFiles.set(fd, { path: fullPath, data, offset: 0, isDir: false, writable: true });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }
      if (wasiFs.isDir(fullPath)) {
        const fd = nextFd++;
        openFiles.set(fd, { path: fullPath, data: new Uint8Array(0), offset: 0, isDir: true, writable: false });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }
      return ENOENT;
    },

    path_filestat_get: (
      dirFd: number, _flags: number,
      pathPtr: number, pathLen: number, retPtr: number
    ) => {
      const pathStr = _decoder.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;

      const data = wasiFs.files.get(fullPath);
      const isDirPath = wasiFs.isDir(fullPath);
      if (!data && !isDirPath) return ENOENT;

      const v = view();
      const m = u8();
      m.fill(0, retPtr, retPtr + 64);
      v.setUint8(retPtr + 16, isDirPath && !data ? 3 : 4);
      v.setBigUint64(retPtr + 24, BigInt(1), true);
      v.setBigUint64(retPtr + 32, BigInt(data ? data.length : 0), true);
      return ESUCCESS;
    },

    fd_filestat_get: (fd: number, retPtr: number) => {
      const m = u8();
      const v = view();
      m.fill(0, retPtr, retPtr + 64);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr + 16, 2); // CHARACTER_DEVICE
        v.setBigUint64(retPtr + 24, BigInt(1), true);
        return ESUCCESS;
      }
      if (fd === FD_TMP_PREOPEN || fd === FD_DATA_PREOPEN) {
        v.setUint8(retPtr + 16, 3); // DIRECTORY
        v.setBigUint64(retPtr + 24, BigInt(1), true);
        return ESUCCESS;
      }
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      v.setUint8(retPtr + 16, file.isDir ? 3 : 4);
      v.setBigUint64(retPtr + 24, BigInt(1), true);
      v.setBigUint64(retPtr + 32, BigInt(file.data.length), true);
      return ESUCCESS;
    },

    fd_readdir: (
      fd: number, bufPtr: number, bufLen: number,
      cookie: bigint, retPtr: number
    ) => {
      let dirPath: string;
      if (fd === FD_TMP_PREOPEN) dirPath = "tmp";
      else if (fd === FD_DATA_PREOPEN) dirPath = "data";
      else {
        const file = openFiles.get(fd);
        if (!file) return EBADF;
        dirPath = file.path;
      }
      const entries = wasiFs.dirChildren.get(dirPath) || [];
      const v = view();
      const m = u8();

      let offset = 0;
      const startIdx = Number(cookie);
      for (let i = startIdx; i < entries.length; i++) {
        const name = entries[i];
        const nameBytes = _encoder.encode(name);
        const entrySize = 24 + nameBytes.length;
        if (offset + entrySize > bufLen) break;

        const base = bufPtr + offset;
        v.setBigUint64(base, BigInt(i + 1), true);       // d_next
        v.setBigUint64(base + 8, BigInt(0), true);        // d_ino
        v.setUint32(base + 16, nameBytes.length, true);   // d_namlen
        const childPath = dirPath ? `${dirPath}/${name}` : name;
        v.setUint8(base + 20, wasiFs.isDir(childPath) ? 3 : 4); // d_type
        m.set(nameBytes, base + 24);
        offset += entrySize;
      }

      v.setUint32(retPtr, offset, true);
      return ESUCCESS;
    },

    path_create_directory: (dirFd: number, pathPtr: number, pathLen: number) => {
      const pathStr = _decoder.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;
      if (wasiFs.dirChildren.has(fullPath)) return EEXIST;
      wasiFs.ensureDir(fullPath);
      return ESUCCESS;
    },

    path_remove_directory: (dirFd: number, pathPtr: number, pathLen: number) => {
      const pathStr = _decoder.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;
      if (!wasiFs.dirChildren.has(fullPath)) return ENOENT;
      const children = wasiFs.dirChildren.get(fullPath)!;
      if (children.length > 0) return ENOTEMPTY;
      wasiFs.dirChildren.delete(fullPath);
      wasiFs.removeFromParent(fullPath);
      return ESUCCESS;
    },

    path_unlink_file: (dirFd: number, pathPtr: number, pathLen: number) => {
      const pathStr = _decoder.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;
      if (!wasiFs.files.has(fullPath)) return ENOENT;
      wasiFs.files.delete(fullPath);
      wasiFs.removeFromParent(fullPath);
      wasiFs.markDeleted(fullPath);
      return ESUCCESS;
    },

    path_rename: (
      oldDirFd: number, oldPathPtr: number, oldPathLen: number,
      newDirFd: number, newPathPtr: number, newPathLen: number
    ) => {
      const m = u8();
      const oldPathStr = _decoder.decode(m.subarray(oldPathPtr, oldPathPtr + oldPathLen));
      const newPathStr = _decoder.decode(m.subarray(newPathPtr, newPathPtr + newPathLen));
      const oldPath = resolvePath(oldDirFd, oldPathStr);
      const newPath = resolvePath(newDirFd, newPathStr);
      if (oldPath === null || newPath === null) return EBADF;

      const data = wasiFs.files.get(oldPath);
      if (!data) return ENOENT;

      wasiFs.files.set(newPath, data);
      wasiFs.registerFile(newPath);
      wasiFs.markDirty(newPath, data);

      wasiFs.files.delete(oldPath);
      wasiFs.removeFromParent(oldPath);
      wasiFs.markDeleted(oldPath);
      return ESUCCESS;
    },

    poll_oneoff: (_in: number, _out: number, _nsubs: number, nevents: number) => {
      view().setUint32(nevents, 0, true);
      return ESUCCESS;
    },

    proc_exit: (code: number) => {
      throw new Error(`exit code: ${code}`);
    },

    random_get: (ptr: number, len: number) => {
      crypto.getRandomValues(new Uint8Array(getMemory().buffer, ptr, len));
      return ESUCCESS;
    },

    sched_yield: () => ESUCCESS,
  };
}
