/**
 * Build Go + Zig into a single WASM binary.
 * Output: build/go.wasm → worker/src/go.wasm
 *
 * TinyGo compiles Go to wasm32-wasi. Zig .o is linked in via -extldflags.
 * Go calls Zig functions via CGo — direct internal calls, zero overhead.
 *
 * The build patches TinyGo's cached GOROOT to replace net/http with GoMode's
 * implementation. Users write standard Go with `import "net/http"` and
 * it compiles without changes.
 *
 * Requires: build/zig-abi.o (run npm run build:zig first)
 *
 * Usage:
 *   npx tsx scripts/build-tinygo.ts [path/to/main.go]
 *
 * If no path given, builds examples/hello-worker.
 */

import { spawnSync, execSync } from "child_process";
import { mkdirSync, existsSync, copyFileSync, cpSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const buildDir = join(root, "build");
const zigObj = join(buildDir, "zig-abi.o");
const overlayDir = join(root, "overlay");

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

// ============================================================================
// Patch TinyGo's cached GOROOT to replace net/http with GoMode's version.
// TinyGo creates a cached GOROOT by merging Go stdlib with its own overrides.
// We replace net/http in that cache with our implementation so users can
// write `import "net/http"` and it just works.
// ============================================================================

console.log("[build-tinygo] Patching TinyGo cached GOROOT with GoMode net/http...");

// Force TinyGo to create/update its cached GOROOT
spawnSync("tinygo", ["info", "-target", "wasip1"], {
  stdio: "ignore",
});

// Find the cached GOROOT
const infoResult = spawnSync("tinygo", ["info", "-target", "wasip1"], {
  encoding: "utf-8",
});
const gorootMatch = infoResult.stdout.match(/cached GOROOT:\s+(\S+)/);
if (!gorootMatch) {
  console.error("[build-tinygo] Could not find TinyGo cached GOROOT");
  process.exit(1);
}
const cachedGoroot = gorootMatch[1];

// Replace net/http with our overlay
const cachedHttp = join(cachedGoroot, "src", "net", "http");
rmSync(cachedHttp, { recursive: true, force: true });
cpSync(join(overlayDir, "net", "http"), cachedHttp, { recursive: true });

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
    `-ldflags=-extldflags='${zigObj} --export=malloc'`,
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
