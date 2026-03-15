/**
 * net/http conformance test suite.
 *
 * Proves GoMode's net/http overlay matches standard Go behavior:
 * routing, headers, cookies, forms, redirects, status codes, BasicAuth.
 */

import { describe, it, expect } from "vitest";

const BASE = "http://localhost:8787";

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

  // ---- SIMD ----

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
