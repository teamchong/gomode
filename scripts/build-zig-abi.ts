/**
 * Build the Zig ABI layer to wasm32-wasi.
 * Output: build/zig-abi.wasm
 *
 * This is the Zig component that provides:
 * - Memory management (zig_alloc, zig_free, zig_free_result)
 * - Columnar table ABI (zig_table_*)
 * - HTTP fetch (zig_http_fetch)
 * - Host import forwarding
 */

import { spawnSync } from "child_process";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const buildDir = join(root, "build");
const zigSrc = join(root, "zig-abi", "src");

mkdirSync(buildDir, { recursive: true });

console.log("[build-zig-abi] Compiling Zig ABI to wasm32-wasi...");

const result = spawnSync(
  "zig",
  [
    "build-exe",
    join(zigSrc, "main.zig"),
    "-target",
    "wasm32-wasi",
    "-O",
    "ReleaseSmall",
    "--name",
    "zig-abi",
    "-femit-bin=" + join(buildDir, "zig-abi.wasm"),
  ],
  { cwd: root, stdio: "inherit" }
);

if (result.status !== 0) {
  console.error("[build-zig-abi] Failed with exit code:", result.status);
  process.exit(1);
}

console.log("[build-zig-abi] Output:", join(buildDir, "zig-abi.wasm"));
