/**
 * Two-phase fetch test suite.
 *
 * Proves Go code can call http.Get() transparently via the two-phase
 * fetch protocol. The /fetch endpoint in hello-worker calls http.Get(url)
 * from Go — WASM returns a "pending" signal, JS does the actual fetch,
 * then replays the handler with the result.
 */

import { describe, it, expect } from "vitest";

const BASE = "http://localhost:8787";

describe("outbound http.Get (two-phase fetch)", () => {
  it("fetches a local URL and returns status + content length", async () => {
    const resp = await fetch(`${BASE}/fetch?url=${encodeURIComponent(`${BASE}/json`)}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe(200);
    expect(data.content_length).toBeGreaterThan(0);
  }, 10000);

  it("fetches an external URL", async () => {
    const resp = await fetch(`${BASE}/fetch?url=https://httpbin.org/get`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe(200);
    expect(data.content_length).toBeGreaterThan(0);
  }, 10000);

  it("uses default URL when none provided", async () => {
    const resp = await fetch(`${BASE}/fetch`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    // Default URL is https://example.com — may fail in local dev
    // but should return a valid response (either 200 or error status)
    expect(data.status).toBeGreaterThan(0);
  }, 10000);
});
