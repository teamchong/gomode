/**
 * net/http conformance test suite.
 *
 * Proves GoMode's net/http overlay matches standard Go behavior:
 * routing, headers, cookies, forms, redirects, status codes, BasicAuth.
 */

import { describe, it, expect } from "vitest";

const BASE = "http://localhost:8787";

describe("Columnar SIMD analytics", () => {
  it("computes per-column stats via SIMD", async () => {
    const res = await fetch(`${BASE}/columnar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: { x: [1, 2, 3, 4, 5] } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const s = data.stats.x;
    expect(s.count).toBe(5);
    expect(s.sum).toBe(15);
    expect(s.mean).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.variance).toBe(2);
    expect(s.stddev).toBeCloseTo(1.4142, 3);
  });

  it("computes Pearson correlation between two columns", async () => {
    const res = await fetch(`${BASE}/columnar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: { a: [1, 2, 3, 4, 5], b: [2, 4, 6, 8, 10] } }),
    });
    const data = await res.json();
    // a and b are perfectly correlated (b = 2a)
    // Go map iteration is non-deterministic, so key could be a_b or b_a
    const corr = data.correlations.a_b ?? data.correlations.b_a;
    expect(corr).toBeCloseTo(1.0, 5);
  });

  it("handles single-column dataset (no correlations)", async () => {
    const res = await fetch(`${BASE}/columnar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: { values: [10, 20, 30] } }),
    });
    const data = await res.json();
    expect(data.stats.values.sum).toBe(60);
    expect(data.correlations).toBeUndefined();
  });

  it("rejects non-POST", async () => {
    const res = await fetch(`${BASE}/columnar`);
    expect(res.status).toBe(405);
  });
});

describe("Zig SIMD extended operations", () => {
  it("SubF64 — element-wise subtraction", async () => {
    const res = await fetch(`${BASE}/simd-ext`);
    const data = await res.json();
    expect(data.sub).toEqual([9, 18, 27, 36, 45]);
  });

  it("MulF64 — element-wise multiplication", async () => {
    const res = await fetch(`${BASE}/simd-ext`);
    const data = await res.json();
    expect(data.mul).toEqual([10, 40, 90, 160, 250]);
  });

  it("ClampF64 — clamp to [0, 40]", async () => {
    const res = await fetch(`${BASE}/simd-ext`);
    const data = await res.json();
    expect(data.clamp).toEqual([0, 0, 15, 40, 40]);
  });

  it("MapLinearF64 — affine transform y = 2x + 10", async () => {
    const res = await fetch(`${BASE}/simd-ext`);
    const data = await res.json();
    expect(data.map_linear).toEqual([12, 14, 16, 18, 20]);
  });
});

describe("net/http conformance", () => {
  // ---- Routing ----

  describe("routing", () => {
    it("matches exact paths", async () => {
      const resp = await fetch(`${BASE}/json`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.path).toBe("/json");
    });

    it("unregistered paths fall through to / handler (Go stdlib behavior)", async () => {
      const resp = await fetch(`${BASE}/nonexistent`);
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("Hello from GoMode!");
    });

    it("handles root path", async () => {
      const resp = await fetch(`${BASE}/`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("Hello from GoMode!");
    });
  });

  // ---- Query string + FormValue ----

  describe("query params & FormValue", () => {
    it("parses query string via FormValue", async () => {
      const resp = await fetch(`${BASE}/sha256?input=world`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.input).toBe("world");
    });

    it("handles URL-encoded query values", async () => {
      const resp = await fetch(`${BASE}/upper?text=hello+world`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("HELLO WORLD");
    });

    it("handles percent-encoded query values", async () => {
      const resp = await fetch(`${BASE}/upper?text=hello%20world`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("HELLO WORLD");
    });

    it("merges query and POST form values", async () => {
      const resp = await fetch(`${BASE}/echo?q=search&name=queryname`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "name=postname&age=30",
      });
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.method).toBe("POST");
      expect(data.query).toBe("search");
      expect(data.age).toBe("30");
      // POST body name should be in Form (POST values come after query in Form)
      expect(data.name).toBeTruthy();
    });

    it("PostFormValue only returns POST body values", async () => {
      const resp = await fetch(`${BASE}/echo?age=fromquery`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "age=frompost",
      });
      const data = await resp.json();
      // PostFormValue("age") should return the POST body value
      expect(data.age).toBe("frompost");
    });
  });

  // ---- Request Headers ----

  describe("request headers", () => {
    it("reads custom headers", async () => {
      const resp = await fetch(`${BASE}/headers`, {
        headers: { "X-Custom": "test-value" },
      });
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data["x-custom"]).toBe("test-value");
    });

    it("reads User-Agent header", async () => {
      const resp = await fetch(`${BASE}/headers`, {
        headers: { "User-Agent": "GoMode-Test/1.0" },
      });
      const data = await resp.json();
      expect(data["user-agent"]).toBe("GoMode-Test/1.0");
    });

    it("reads Host header", async () => {
      const resp = await fetch(`${BASE}/headers`);
      const data = await resp.json();
      expect(data.host).toContain("localhost");
    });
  });

  // ---- Cookies ----

  describe("cookies", () => {
    it("sets cookies via SetCookie", async () => {
      const resp = await fetch(`${BASE}/set-cookie`);
      expect(resp.status).toBe(200);
      const setCookie = resp.headers.get("set-cookie");
      expect(setCookie).toContain("session=abc123");
      expect(setCookie).toContain("Path=/");
    });

    it("reads cookies from request", async () => {
      const resp = await fetch(`${BASE}/read-cookie`, {
        headers: { Cookie: "session=xyz789; other=val" },
      });
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.name).toBe("session");
      expect(data.value).toBe("xyz789");
    });

    it("returns error when cookie not found", async () => {
      const resp = await fetch(`${BASE}/read-cookie`);
      expect(resp.status).toBe(400);
      expect(await resp.text()).toContain("no cookie");
    });
  });

  // ---- Status codes ----

  describe("status codes", () => {
    for (const [code, text] of [
      [200, "OK"],
      [201, "Created"],
      [204, "No Content"],
      [400, "Bad Request"],
      [401, "Unauthorized"],
      [403, "Forbidden"],
      [404, "Not Found"],
      [500, "Internal Server Error"],
    ] as [number, string][]) {
      it(`returns ${code} ${text}`, async () => {
        const resp = await fetch(`${BASE}/status?code=${code}`);
        expect(resp.status).toBe(code);
        // 204 has no body per HTTP spec
        if (code !== 204) {
          const body = await resp.text();
          expect(body).toContain(String(code));
        }
      });
    }
  });

  // ---- Redirect ----

  describe("redirect", () => {
    it("returns 302 with Location header", async () => {
      const resp = await fetch(`${BASE}/redirect`, { redirect: "manual" });
      expect(resp.status).toBe(302);
      expect(resp.headers.get("location")).toBe("/json");
    });
  });

  // ---- BasicAuth ----

  describe("BasicAuth", () => {
    it("parses Authorization header", async () => {
      const creds = btoa("admin:secret");
      const resp = await fetch(`${BASE}/basicauth`, {
        headers: { Authorization: `Basic ${creds}` },
      });
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.user).toBe("admin");
      expect(data.pass).toBe("secret");
    });

    it("returns 401 without Authorization", async () => {
      const resp = await fetch(`${BASE}/basicauth`);
      expect(resp.status).toBe(401);
    });
  });

  // ---- JSON encoding ----

  describe("JSON encoding", () => {
    it("returns valid JSON with correct Content-Type", async () => {
      const resp = await fetch(`${BASE}/json`);
      expect(resp.headers.get("content-type")).toContain("application/json");
      const data = await resp.json();
      expect(data.message).toBe("Hello from GoMode!");
    });
  });

  // ---- Crypto ----

  describe("crypto/sha256", () => {
    it("computes correct SHA-256 hash", async () => {
      const resp = await fetch(`${BASE}/sha256?input=test`);
      const data = await resp.json();
      expect(data.sha256).toBe(
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      );
    });
  });

  // ---- HMAC ----

  describe("Zig HMAC-SHA256", () => {
    it("computes correct HMAC-SHA256", async () => {
      const resp = await fetch(`${BASE}/hmac?key=secret&msg=hello`);
      const data = await resp.json();
      expect(data.key).toBe("secret");
      expect(data.msg).toBe("hello");
      // Known HMAC-SHA256("secret", "hello") value
      expect(data.hmac).toBe(
        "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b"
      );
    });
  });

  // ---- SIMD ----

  describe("Zig SHA-512", () => {
    it("computes correct SHA-512 hash", async () => {
      const resp = await fetch(`${BASE}/sha512?input=test`);
      const data = await resp.json();
      expect(data.sha512).toBe(
        "ee26b0dd4af7e749aa1a8ee3c10ae9923f618980772e473f8819a5d4940e0db27ac185f8a0e1d5f84f88bc887fd67b143732c304cc5fa9ad8e6f57f50028a8ff"
      );
    });
  });

  describe("Zig AES-256-GCM", () => {
    it("encrypts and decrypts round-trip", async () => {
      const resp = await fetch(`${BASE}/aes?text=secret+data`);
      const data = await resp.json();
      expect(data.round_trip_ok).toBe(true);
      expect(data.decrypted).toBe("secret data");
      expect(data.ciphertext_len).toBe(11 + 16); // plaintext + 16-byte tag
      expect(data.tag_size).toBe(16);
    });
  });

  describe("Zig SIMD operations", () => {
    it("computes correct sum, dot product, scale, minmax", async () => {
      const resp = await fetch(`${BASE}/simd`);
      const data = await resp.json();
      expect(data.sum).toBe(36);
      expect(data.dot).toBe(204);
      expect(data.scaled_sum).toBe(72);
      expect(data.min).toBe(2);
      expect(data.max).toBe(16);
    });
  });
});

describe("KV bindings (gomode.KV*)", () => {
  it("KVPut + KVGet round-trip", async () => {
    const putRes = await fetch(`${BASE}/kv/put?key=test-rt&value=round-trip`);
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${BASE}/kv/get?key=test-rt`);
    expect(getRes.status).toBe(200);
    const data = await getRes.json();
    expect(data.found).toBe(true);
    expect(data.value).toBe("round-trip");
  });

  it("KVGet returns found=false for missing keys", async () => {
    const res = await fetch(`${BASE}/kv/get?key=nonexistent-key-xyz`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.found).toBe(false);
    expect(data.value).toBe("");
  });

  it("KVDelete removes a key", async () => {
    await fetch(`${BASE}/kv/put?key=to-delete&value=bye`);
    const delRes = await fetch(`${BASE}/kv/delete?key=to-delete`);
    expect(delRes.status).toBe(200);

    const getRes = await fetch(`${BASE}/kv/get?key=to-delete`);
    const data = await getRes.json();
    expect(data.found).toBe(false);
  });

  it("KVList returns keys with prefix", async () => {
    await fetch(`${BASE}/kv/put?key=list-a&value=1`);
    await fetch(`${BASE}/kv/put?key=list-b&value=2`);

    const res = await fetch(`${BASE}/kv/list?prefix=list-`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.keys).toContain("list-a");
    expect(data.keys).toContain("list-b");
  });
});

describe("SSE / http.Flusher", () => {
  it("serves server-sent events with correct content-type", async () => {
    const resp = await fetch(`${BASE}/sse`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    expect(resp.headers.get("cache-control")).toBe("no-cache");
    const body = await resp.text();
    expect(body).toContain("event: message");
    expect(body).toContain('data: {"count":0}');
    expect(body).toContain('data: {"count":1}');
    expect(body).toContain('data: {"count":2}');
    expect(body).toContain("event: done");
    expect(body).toContain('data: {"total":3}');
  });
});

describe("http.ServeFile / FileServer", () => {
  it("ServeFile serves a file with correct content-type", async () => {
    // Write a file first
    await fetch(`${BASE}/fs/write?path=/tmp/serve-test.html&content=%3Cp%3Ehi%3C/p%3E`);
    const resp = await fetch(`${BASE}/serve/serve-test.html`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    expect(await resp.text()).toBe("<p>hi</p>");
  });

  it("ServeFile returns 404 for missing files", async () => {
    const resp = await fetch(`${BASE}/serve/does-not-exist.txt`);
    expect(resp.status).toBe(404);
  });

  it("ServeFile detects CSS content type", async () => {
    await fetch(`${BASE}/fs/write?path=/tmp/test.css&content=body%7B%7D`);
    const resp = await fetch(`${BASE}/serve/test.css`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/css");
  });

  it("FileServer serves files via http.StripPrefix", async () => {
    await fetch(`${BASE}/fs/write?path=/tmp/fileserver.json&content=%7B%22ok%22:true%7D`);
    const resp = await fetch(`${BASE}/files/fileserver.json`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
    const data = await resp.json();
    expect(data.ok).toBe(true);
  });
});

describe("WASI filesystem (os.* operations)", () => {
  it("os.WriteFile + os.ReadFile round-trip", async () => {
    // Write
    const writeRes = await fetch(`${BASE}/fs/write?path=/tmp/hello.txt&content=hello+wasi`);
    expect(writeRes.status).toBe(200);
    const writeData = await writeRes.json();
    expect(writeData.status).toBe("written");
    expect(writeData.size).toBe("10");

    // Read back
    const readRes = await fetch(`${BASE}/fs/read?path=/tmp/hello.txt`);
    expect(readRes.status).toBe(200);
    const readData = await readRes.json();
    expect(readData.content).toBe("hello wasi");
    expect(readData.size).toBe("10");
  });

  it("os.Stat returns file metadata", async () => {
    await fetch(`${BASE}/fs/write?path=/tmp/stat-test.txt&content=abc`);
    const res = await fetch(`${BASE}/fs/stat?path=/tmp/stat-test.txt`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("stat-test.txt");
    expect(data.size).toBe(3);
    expect(data.isDir).toBe(false);
  });

  it("os.Stat returns directory metadata", async () => {
    const res = await fetch(`${BASE}/fs/stat?path=/tmp`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isDir).toBe(true);
  });

  it("os.MkdirAll creates nested directories", async () => {
    const res = await fetch(`${BASE}/fs/mkdir?path=/tmp/a/b/c`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("created");

    // Verify directory exists
    const statRes = await fetch(`${BASE}/fs/stat?path=/tmp/a/b/c`);
    expect(statRes.status).toBe(200);
    const stat = await statRes.json();
    expect(stat.isDir).toBe(true);
  });

  it("os.ReadDir lists directory contents", async () => {
    await fetch(`${BASE}/fs/mkdir?path=/tmp/listdir`);
    await fetch(`${BASE}/fs/write?path=/tmp/listdir/file1.txt&content=one`);
    await fetch(`${BASE}/fs/write?path=/tmp/listdir/file2.txt&content=two`);
    await fetch(`${BASE}/fs/mkdir?path=/tmp/listdir/sub`);

    const res = await fetch(`${BASE}/fs/readdir?path=/tmp/listdir`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toContain("file1.txt");
    expect(data.entries).toContain("file2.txt");
    expect(data.entries).toContain("sub/");
  });

  it("os.Remove deletes a file", async () => {
    await fetch(`${BASE}/fs/write?path=/tmp/delete-me.txt&content=bye`);

    // Verify it exists
    const statRes = await fetch(`${BASE}/fs/stat?path=/tmp/delete-me.txt`);
    expect(statRes.status).toBe(200);

    // Delete it
    const delRes = await fetch(`${BASE}/fs/remove?path=/tmp/delete-me.txt`);
    expect(delRes.status).toBe(200);

    // Verify it's gone
    const readRes = await fetch(`${BASE}/fs/read?path=/tmp/delete-me.txt`);
    expect(readRes.status).toBe(500);
  });

  it("reading non-existent file returns error", async () => {
    const res = await fetch(`${BASE}/fs/read?path=/tmp/does-not-exist.txt`);
    expect(res.status).toBe(500);
  });
});
