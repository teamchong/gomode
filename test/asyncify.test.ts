/**
 * Outbound fetch test suite — single and multi-fetch.
 *
 * Proves Go code can call http.Get() transparently via the multi-fetch
 * two-phase protocol. Each http.Get() triggers one JS round-trip.
 * Results are cached by URL so multiple fetches work across replays.
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
    expect(data.status).toBeGreaterThan(0);
  }, 10000);
});

describe("multi-fetch (multiple http.Get in one handler)", () => {
  it("fetches two different URLs in one handler", async () => {
    const url1 = encodeURIComponent("https://httpbin.org/get");
    const url2 = encodeURIComponent("https://httpbin.org/headers");
    const resp = await fetch(`${BASE}/multi-fetch?url1=${url1}&url2=${url2}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.fetch1_status).toBe(200);
    expect(data.fetch1_length).toBeGreaterThan(0);
    expect(data.fetch2_status).toBe(200);
    expect(data.fetch2_length).toBeGreaterThan(0);
  }, 15000);

  it("fetches two different external endpoints", async () => {
    const url1 = encodeURIComponent("https://httpbin.org/status/200");
    const url2 = encodeURIComponent("https://httpbin.org/status/201");
    const resp = await fetch(`${BASE}/multi-fetch?url1=${url1}&url2=${url2}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.fetch1_status).toBe(200);
    expect(data.fetch2_status).toBe(201);
  }, 15000);

  it("handles same URL fetched twice (cache hit)", async () => {
    const url = encodeURIComponent("https://httpbin.org/get");
    const resp = await fetch(`${BASE}/multi-fetch?url1=${url}&url2=${url}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.fetch1_status).toBe(200);
    expect(data.fetch2_status).toBe(200);
  }, 10000);
});
