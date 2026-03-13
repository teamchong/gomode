/**
 * GoMode Worker — Routes requests to GoDO (Durable Object).
 *
 * Architecture (mirrors pymode):
 *   CF Request → Worker serializes to JSON
 *     → GoDO.fetch() → instantiates go.wasm (TinyGo + Zig ABI)
 *       → WASM reads request from stdin JSON
 *       → Go handler processes, uses Zig ABI for host imports
 *       → WASM writes response to stdout JSON
 *     → Worker deserializes → CF Response
 */

export { GoDO } from "./go-do";

interface Env {
  GO_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.GO_DO.idFromName("singleton");
    const durable = env.GO_DO.get(id);
    return durable.fetch(request);
  },
};
