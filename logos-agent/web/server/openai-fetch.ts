import { createRequire } from "node:module";

interface Transport {
  fetch(input: string | URL, init: RequestInit & { dispatcher: object }): Promise<Response>;
  ProxyAgent: new (url: string) => object;
}
let cached: { url: string; transport: Transport; dispatcher: object } | undefined;
/** Use the deployment's explicit OpenAI egress proxy, retaining normal TLS verification. */
export function openAiFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = process.env.LOGOS_WEB_OPENAI_PROXY;
  if (!url) return globalThis.fetch(input, init);
  if (!cached || cached.url !== url) {
    const transport = createRequire(new URL("../../pi-domain/package.json", import.meta.url))("undici") as Transport;
    cached = { url, transport, dispatcher: new transport.ProxyAgent(url) };
  }
  return cached.transport.fetch(input, { ...init, dispatcher: cached.dispatcher });
}
// Injected only into the bundled, trusted extension OAuth adapter.
export { openAiFetch as fetch };
