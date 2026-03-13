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

  it("returns 404 on unknown path", async () => {
    const resp = await fetch("http://localhost:8787/unknown");
    expect(resp.status).toBe(404);
    const text = await resp.text();
    expect(text).toContain("not found");
  });
});
