/**
 * Build user Go code with TinyGo targeting wasm32-wasi.
 * Output: build/go.wasm
 *
 * TinyGo compiles Go to wasm32-wasi with minimal runtime overhead.
 * The resulting .wasm is linked with the Zig ABI object to produce
 * a single go.wasm that has both Go logic and Zig ABI exports.
 *
 * Usage:
 *   npx tsx scripts/build-tinygo.ts [path/to/main.go]
 *
 * If no path given, builds examples/hello-worker/main.go.
 */

import { spawnSync } from "child_process";
import { mkdirSync, existsSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const buildDir = join(root, "build");

mkdirSync(buildDir, { recursive: true });

const userPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, "examples", "hello-worker");

if (!existsSync(userPath)) {
  console.error(`[build-tinygo] Path not found: ${userPath}`);
  process.exit(1);
}

console.log(`[build-tinygo] Compiling ${userPath} with TinyGo...`);

const result = spawnSync(
  "tinygo",
  [
    "build",
    "-target",
    "wasip1",
    "-o",
    join(buildDir, "go.wasm"),
    "-scheduler=none",
    "-gc=leaking",
    ".",
  ],
  { cwd: userPath, stdio: "inherit", env: { ...process.env } }
);

if (result.status !== 0) {
  console.error("[build-tinygo] Failed with exit code:", result.status);
  console.error(
    "[build-tinygo] Is TinyGo installed? Install: brew install tinygo"
  );
  process.exit(1);
}

// Copy to worker
const workerWasm = join(root, "worker", "src", "go.wasm");
copyFileSync(join(buildDir, "go.wasm"), workerWasm);
console.log("[build-tinygo] Output:", workerWasm);
