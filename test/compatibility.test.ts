/**
 * Real-world Go compatibility tests.
 *
 * Proves that standard Go net/http patterns work on GoMode with zero code changes:
 * - Middleware chaining (func(http.Handler) http.Handler)
 * - Handler struct (implements http.Handler interface)
 * - Method-based routing (GET/POST/DELETE switch)
 * - Content negotiation (Accept header)
 * - Multiple cookies with attributes
 * - http.StripPrefix
 * - http.MaxBytesReader
 * - Multiple w.Write calls
 * - Request reflection (URL, proto, headers)
 */
import { describe, it, expect } from "vitest";

const BASE = "http://localhost:8787";

describe("Middleware chaining", () => {
  it("adds CORS headers via middleware wrapping handler struct", async () => {
    const res = await fetch(`${BASE}/api/info`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    const data = await res.json();
    expect(data.version).toBe("1.0.0");
    expect(data.runtime).toBe("gomode");
  });

  it("handles OPTIONS preflight via middleware", async () => {
    const res = await fetch(`${BASE}/api/info`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, Authorization");
  });
});

describe("Handler struct (http.Handler interface)", () => {
  it("serves response from struct implementing ServeHTTP", async () => {
    const res = await fetch(`${BASE}/api/info`);
    const data = await res.json();
    expect(data.version).toBe("1.0.0");
    expect(data.runtime).toBe("gomode");
  });
});

describe("Method-based routing", () => {
  it("GET returns item list", async () => {
    const res = await fetch(`${BASE}/api/items`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.items[0].name).toBe("alpha");
    expect(data.items[1].name).toBe("beta");
  });

  it("POST creates item with 201 status", async () => {
    const res = await fetch(`${BASE}/api/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gamma" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("gamma");
    expect(data.created).toBe(true);
  });

  it("POST with missing name returns 422", async () => {
    const res = await fetch(`${BASE}/api/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("POST with invalid JSON returns 400", async () => {
    const res = await fetch(`${BASE}/api/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("DELETE returns 204 no content", async () => {
    const res = await fetch(`${BASE}/api/items`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("PATCH returns 405 method not allowed", async () => {
    const res = await fetch(`${BASE}/api/items`, { method: "PATCH" });
    expect(res.status).toBe(405);
  });
});

describe("http.StripPrefix", () => {
  it("strips /static prefix from path", async () => {
    const res = await fetch(`${BASE}/static/css/main.css`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stripped_path).toBe("/css/main.css");
  });

  it("strips prefix leaving root path", async () => {
    const res = await fetch(`${BASE}/static/`);
    const data = await res.json();
    expect(data.stripped_path).toBe("/");
  });
});

describe("Content negotiation", () => {
  it("returns JSON by default", async () => {
    const res = await fetch(`${BASE}/negotiate`);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  it("returns plain text when Accept: text/plain", async () => {
    const res = await fetch(`${BASE}/negotiate`, {
      headers: { Accept: "text/plain" },
    });
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("version=1.0.0");
  });

  it("returns HTML when Accept: text/html", async () => {
    const res = await fetch(`${BASE}/negotiate`, {
      headers: { Accept: "text/html" },
    });
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>");
  });
});

describe("Multiple cookies with attributes", () => {
  it("sets multiple cookies with secure attributes", async () => {
    const res = await fetch(`${BASE}/multi-cookie`);
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThanOrEqual(2);

    const sidCookie = cookies.find((c: string) => c.startsWith("sid="));
    expect(sidCookie).toBeDefined();
    expect(sidCookie).toContain("HttpOnly");
    expect(sidCookie).toContain("Secure");
    expect(sidCookie).toContain("SameSite=Strict");

    const themeCookie = cookies.find((c: string) => c.startsWith("theme="));
    expect(themeCookie).toBeDefined();
    expect(themeCookie).toContain("theme=dark");
    expect(themeCookie).toContain("Max-Age=86400");
  });
});

describe("http.MaxBytesReader", () => {
  it("accepts body within limit", async () => {
    const res = await fetch(`${BASE}/limited`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "short" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toBe("short");
  });

  it("rejects body exceeding limit", async () => {
    const res = await fetch(`${BASE}/limited`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(200) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("Multiple w.Write calls", () => {
  it("concatenates multiple writes into single response", async () => {
    const res = await fetch(`${BASE}/chunked-write`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("line1\nline2\nline3\n");
  });
});

describe("Large / streaming responses", () => {
  it("returns 32KB response (exceeds old 16KB limit)", async () => {
    const res = await fetch(`${BASE}/large?size=32768`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-body-size")).toBe("32768");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(32768);
    // Verify content pattern
    const bytes = new Uint8Array(buf);
    expect(bytes[0]).toBe(65); // 'A'
    expect(bytes[25]).toBe(90); // 'Z'
    expect(bytes[26]).toBe(65); // wraps back to 'A'
  });

  it("returns 128KB response", async () => {
    const res = await fetch(`${BASE}/large?size=131072`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(131072);
  });

  it("returns 512KB response", async () => {
    const res = await fetch(`${BASE}/large?size=524288`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(524288);
  });

  it("returns default 32KB when no size param", async () => {
    const res = await fetch(`${BASE}/large`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(32768);
  });
});

describe("Request reflection", () => {
  it("reflects all request properties", async () => {
    const res = await fetch(`${BASE}/reflect?foo=bar&baz=1`, {
      headers: {
        "User-Agent": "GoMode-Test/1.0",
        Referer: "https://example.com",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.method).toBe("GET");
    expect(data.path).toBe("/reflect");
    expect(data.raw_query).toBe("foo=bar&baz=1");
    expect(data.proto).toBe("HTTP/1.1");
    expect(data.proto_at_1_1).toBe(true);
    expect(data.request_uri).toBe("/reflect?foo=bar&baz=1");
    expect(data.user_agent).toBe("GoMode-Test/1.0");
    expect(data.referer).toBe("https://example.com");
  });

  it("reflects POST with content length", async () => {
    const body = JSON.stringify({ test: true });
    const res = await fetch(`${BASE}/reflect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = await res.json();
    expect(data.method).toBe("POST");
    expect(data.content_len).toBe(body.length);
  });
});

describe("Panic recovery", () => {
  it("returns 500 with panic message instead of crashing", async () => {
    const res = await fetch(`${BASE}/panic`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("panic:");
  });

  it("still serves normal requests after a panic", async () => {
    // First trigger a panic
    await fetch(`${BASE}/panic`);
    // Then verify the server still works
    const res = await fetch(`${BASE}/json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("Hello from GoMode!");
  });
});
