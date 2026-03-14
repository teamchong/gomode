/**
 * Basic smoke test — verifies the hello-worker example
 * compiles to WASM and runs correctly via the GoDO pipeline.
 *
 * Requires: tinygo installed, go.wasm built and copied to worker/src/
 * Run: npm test
 */

import { describe, it, expect } from "vitest";

describe("hello-worker", () => {
  it("returns hello message on GET /", async () => {
    const resp = await fetch("http://localhost:8787/");
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("Hello from GoMode!");
  });

  it("returns JSON on GET /json", async () => {
    const resp = await fetch("http://localhost:8787/json");
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.message).toBe("Hello from GoMode!");
    expect(data.method).toBe("GET");
  });

  it("unknown path falls through to / handler (Go stdlib behavior)", async () => {
    const resp = await fetch("http://localhost:8787/unknown");
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("Hello from GoMode!");
  });

  it("returns SHA-256 hash on GET /sha256", async () => {
    const resp = await fetch("http://localhost:8787/sha256?input=hello");
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.input).toBe("hello");
    expect(data.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("returns uppercase on GET /upper", async () => {
    const resp = await fetch("http://localhost:8787/upper?text=hello+gomode");
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toBe("HELLO GOMODE");
  });

  it("returns SIMD results on GET /simd", async () => {
    const resp = await fetch("http://localhost:8787/simd");
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.sum).toBe(36);
    expect(data.dot).toBe(204);
    expect(data.scaled_sum).toBe(72);
  });
});
