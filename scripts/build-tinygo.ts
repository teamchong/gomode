/**
 * Build Go + Zig into a single WASM binary.
 * Output: build/go.wasm → worker/src/go.wasm
 *
 * TinyGo compiles Go to wasm32-wasi. Zig .o is linked in via -extldflags.
 * Go calls Zig functions via CGo — direct internal calls, zero overhead.
 *
 * Requires: build/zig-abi.o (run npm run build:zig first)
 *
 * Usage:
 *   npx tsx scripts/build-tinygo.ts [path/to/main.go]
 *
 * If no path given, builds examples/hello-worker.
 */

import { spawnSync } from "child_process";
import { mkdirSync, existsSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const buildDir = join(root, "build");
const zigObj = join(buildDir, "zig-abi.o");

mkdirSync(buildDir, { recursive: true });

if (!existsSync(zigObj)) {
  console.error(`[build-tinygo] Zig object not found: ${zigObj}`);
  console.error("[build-tinygo] Run 'npm run build:zig' first.");
  process.exit(1);
}

const userPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, "examples", "hello-worker");

if (!existsSync(userPath)) {
  console.error(`[build-tinygo] Path not found: ${userPath}`);
  process.exit(1);
}

console.log(`[build-tinygo] Compiling ${userPath} with TinyGo + Zig...`);

const result = spawnSync(
  "tinygo",
  [
    "build",
    "-target",
    "wasip1",
    "-o",
    join(buildDir, "go.wasm"),
    "-scheduler=none",
    "-gc=custom",
    "-tags=custommalloc",
    `-ldflags=-extldflags='${zigObj}'`,
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

const workerWasm = join(root, "worker", "src", "go.wasm");
copyFileSync(join(buildDir, "go.wasm"), workerWasm);
console.log("[build-tinygo] Output:", workerWasm);
