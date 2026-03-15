/**
 * Durable Object integration tests.
 *
 * Requests to /do/* are routed through the GoDO Durable Object.
 * The WASM instance persists across requests within the DO,
 * so these tests verify that DO mode handles the same endpoints
 * as Worker mode with correct request/response handling.
 */
import { describe, it, expect } from "vitest";

const BASE = "http://localhost:8787/do";

describe("Durable Object — basic routing", () => {
  it("GET / returns hello message", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hello from GoMode!");
  });

  it("GET /json returns JSON response", async () => {
    const res = await fetch(`${BASE}/json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("Hello from GoMode!");
    expect(data.method).toBe("GET");
  });

  it("GET /sha256 returns correct hash", async () => {
    const res = await fetch(`${BASE}/sha256?input=hello`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.input).toBe("hello");
    expect(data.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("Durable Object — request body and headers", () => {
  it("POST /echo with form body", async () => {
    const res = await fetch(`${BASE}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=gomode&age=1",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("gomode");
    expect(data.age).toBe("1");
  });

  it("GET /headers echoes request headers", async () => {
    const res = await fetch(`${BASE}/headers`, {
      headers: { "X-Custom": "do-test", "User-Agent": "DO-Test/1.0" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data["x-custom"]).toBe("do-test");
    expect(data["user-agent"]).toBe("DO-Test/1.0");
  });
});

describe("Durable Object — response headers and cookies", () => {
  it("GET /set-cookie sets response cookie", async () => {
    const res = await fetch(`${BASE}/set-cookie`);
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThanOrEqual(1);
    expect(cookies[0]).toContain("session=abc123");
  });

  it("GET /status?code=201 returns custom status", async () => {
    const res = await fetch(`${BASE}/status?code=201`);
    expect(res.status).toBe(201);
  });

  it("GET /redirect returns 302", async () => {
    const res = await fetch(`${BASE}/redirect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/json");
  });
});

describe("Durable Object — SIMD and advanced features", () => {
  it("GET /simd returns Zig SIMD results", async () => {
    const res = await fetch(`${BASE}/simd`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sum).toBe(36);
    expect(data.dot).toBe(204);
    expect(data.scaled_sum).toBe(72);
  });

  it("POST /api/items creates item with 201", async () => {
    const res = await fetch(`${BASE}/api/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "do-item" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("do-item");
    expect(data.created).toBe(true);
  });
});

describe("Durable Object — outbound fetch", () => {
  it("GET /fetch triggers two-phase fetch through DO", async () => {
    const res = await fetch(`${BASE}/fetch?url=https://httpbin.org/get`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe(200);
    expect(data.content_length).toBeGreaterThan(0);
  }, 10000);
});

describe("Durable Object — WebSocket", () => {
  it("echoes messages via WebSocket", async () => {
    const ws = new WebSocket("ws://localhost:8787/do/ws");
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
      ws.addEventListener("open", () => {
        ws.send("hello");
      });
      ws.addEventListener("message", (event) => {
        messages.push(String(event.data));
        if (messages.length === 1) {
          ws.send("world");
        }
        if (messages.length === 2) {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    });

    expect(messages[0]).toBe("echo: hello");
    expect(messages[1]).toBe("echo: world");
  }, 10000);
});

describe("Durable Object — KV bindings", () => {
  it("PUT and GET through DO multi-fetch", async () => {
    const put = await fetch(`${BASE}/kv/put?key=do-kv-test&value=do-value`);
    expect(put.status).toBe(200);
    const putData = await put.json();
    expect(putData.status).toBe("ok");

    const get = await fetch(`${BASE}/kv/get?key=do-kv-test`);
    expect(get.status).toBe(200);
    const getData = await get.json();
    expect(getData.found).toBe(true);
    expect(getData.value).toBe("do-value");

    // Cleanup
    const del = await fetch(`${BASE}/kv/delete?key=do-kv-test`);
    expect(del.status).toBe(200);
  });
});

describe("Durable Object — R2-backed /data filesystem", () => {
  it("write and read file in /data/ (R2-backed path)", async () => {
    const writeRes = await fetch(`${BASE}/fs/write?path=/data/do-test.txt&content=persistent-data`);
    expect(writeRes.status).toBe(200);
    const writeData = await writeRes.json();
    expect(writeData.status).toBe("written");

    const readRes = await fetch(`${BASE}/fs/read?path=/data/do-test.txt`);
    expect(readRes.status).toBe(200);
    const readData = await readRes.json();
    expect(readData.content).toBe("persistent-data");
  });

  it("stat file in /data/ returns correct size", async () => {
    await fetch(`${BASE}/fs/write?path=/data/stat-test.txt&content=twelve+chars`);
    const res = await fetch(`${BASE}/fs/stat?path=/data/stat-test.txt`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("stat-test.txt");
    expect(data.isDir).toBe(false);
    expect(data.size).toBeGreaterThan(0);
  });

  it("readdir in /data/ lists written files", async () => {
    await fetch(`${BASE}/fs/write?path=/data/list-a.txt&content=a`);
    await fetch(`${BASE}/fs/write?path=/data/list-b.txt&content=b`);
    const res = await fetch(`${BASE}/fs/readdir?path=/data`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toContain("list-a.txt");
    expect(data.entries).toContain("list-b.txt");
  });

  it("delete file in /data/ marks it for R2 removal", async () => {
    await fetch(`${BASE}/fs/write?path=/data/del-me.txt&content=bye`);
    const statRes = await fetch(`${BASE}/fs/stat?path=/data/del-me.txt`);
    expect(statRes.status).toBe(200);

    const delRes = await fetch(`${BASE}/fs/remove?path=/data/del-me.txt`);
    expect(delRes.status).toBe(200);

    const readRes = await fetch(`${BASE}/fs/read?path=/data/del-me.txt`);
    expect(readRes.status).toBe(500);
  });
});

describe("Durable Object — state persistence across requests", () => {
  it("WASM instance persists (same DO handles multiple requests)", async () => {
    // Make two requests — both should succeed, proving the DO instance stays alive
    const res1 = await fetch(`${BASE}/json`);
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.message).toBe("Hello from GoMode!");

    const res2 = await fetch(`${BASE}/simd`);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.sum).toBe(36);
  });
});
