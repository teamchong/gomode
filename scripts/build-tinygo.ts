/**
 * Build Go + Zig into a single WASM binary.
 * Output: build/go.wasm → worker/src/go.wasm
 *
 * TinyGo compiles Go to wasm32-wasi. Zig .o is linked in via -extldflags.
 * Go calls Zig functions via CGo — direct internal calls, zero overhead.
 *
 * The build patches TinyGo's TINYGOROOT/src/net/http/ with GoMode's overlay,
 * then restores it after build. This ensures `import "net/http"` compiles to
 * GoMode's implementation. Users write standard Go — no code changes needed.
 *
 * Requires: build/zig-abi.o (run npm run build:zig first)
 *
 * Usage:
 *   npx tsx scripts/build-tinygo.ts [path/to/main.go]
 *
 * If no path given, builds examples/hello-worker.
 */

import { spawnSync } from "child_process";
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
// Patch TinyGo's src/net/http with GoMode's overlay.
//
// TinyGo resolves packages from TINYGOROOT/src/ (its own overrides) before
// the Go stdlib. We replace src/net/http/ with our implementation so users
// write `import "net/http"` and it compiles to GoMode's zerobuf-backed version.
//
// The original files are backed up and restored after build.
// ============================================================================

const tinygoRoot = spawnSync("tinygo", ["env", "TINYGOROOT"], {
  encoding: "utf-8",
}).stdout.trim();

if (!tinygoRoot || !existsSync(tinygoRoot)) {
  console.error("[build-tinygo] Could not find TINYGOROOT");
  process.exit(1);
}

const tinygoHttp = join(tinygoRoot, "src", "net", "http");
const backupHttp = join(buildDir, "tinygo-http-backup");

console.log("[build-tinygo] Patching TinyGo net/http with GoMode overlay...");

// Backup original TinyGo net/http
rmSync(backupHttp, { recursive: true, force: true });
cpSync(tinygoHttp, backupHttp, { recursive: true });

// Replace with our overlay
rmSync(tinygoHttp, { recursive: true, force: true });
cpSync(join(overlayDir, "net", "http"), tinygoHttp, { recursive: true });

// Also patch the cached GOROOT (TinyGo merges sources there)
spawnSync("tinygo", ["info", "-target", "wasip1"], { stdio: "ignore" });
const infoResult = spawnSync("tinygo", ["info", "-target", "wasip1"], {
  encoding: "utf-8",
});
const gorootMatch = infoResult.stdout.match(/cached GOROOT:\s+(\S+)/);
if (gorootMatch) {
  const cachedHttp = join(gorootMatch[1], "src", "net", "http");
  rmSync(cachedHttp, { recursive: true, force: true });
  cpSync(join(overlayDir, "net", "http"), cachedHttp, { recursive: true });
}

function restoreTinyGo() {
  rmSync(tinygoHttp, { recursive: true, force: true });
  cpSync(backupHttp, tinygoHttp, { recursive: true });
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
    `-ldflags=-extldflags='${zigObj} --export=malloc'`,
    ".",
  ],
  { cwd: userPath, stdio: "inherit", env: { ...process.env } }
);

// Restore TinyGo's original net/http
restoreTinyGo();

if (result.status !== 0) {
  console.error("[build-tinygo] Failed with exit code:", result.status);
  console.error(
    "[build-tinygo] Is TinyGo installed? Install: brew install tinygo"
  );
  process.exit(1);
}

// ============================================================================
// Asyncify — transform WASM binary so Go can call async JS functions
// (http.Get, http.Post, etc. suspend WASM, JS does await fetch(), resumes)
// ============================================================================

const rawWasm = join(buildDir, "go.wasm");
const asyncWasm = join(buildDir, "go-async.wasm");

console.log("[build-tinygo] Running wasm-opt --asyncify...");

const optResult = spawnSync(
  "wasm-opt",
  [
    rawWasm,
    "--asyncify",
    "--pass-arg=asyncify-imports@env.__gomode_fetch",
    "-o",
    asyncWasm,
  ],
  { stdio: "inherit" }
);

if (optResult.status !== 0) {
  console.error("[build-tinygo] wasm-opt --asyncify failed");
  console.error(
    "[build-tinygo] Is wasm-opt installed? Install: brew install binaryen"
  );
  process.exit(1);
}

const workerWasm = join(root, "worker", "src", "go.wasm");
copyFileSync(asyncWasm, workerWasm);
console.log("[build-tinygo] Output:", workerWasm);
