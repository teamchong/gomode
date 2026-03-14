/**
 * Build Zig ABI to a relocatable .o for linking into go.wasm.
 * Output: build/zig-abi.o
 *
 * TinyGo links this .o via -extldflags into a single WASM binary.
 * Go calls Zig functions via CGo — direct wasm call instructions.
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

console.log("[build-zig-abi] Compiling Zig to wasm32-wasi relocatable object...");

const result = spawnSync(
  "zig",
  [
    "build-obj",
    join(zigSrc, "main.zig"),
    "-target",
    "wasm32-wasi",
    "-mcpu=generic+simd128",
    "-O",
    "ReleaseSmall",
    "-femit-bin=" + join(buildDir, "zig-abi.o"),
  ],
  { cwd: root, stdio: "inherit" }
);

if (result.status !== 0) {
  console.error("[build-zig-abi] Failed with exit code:", result.status);
  process.exit(1);
}

console.log("[build-zig-abi] Output:", join(buildDir, "zig-abi.o"));
