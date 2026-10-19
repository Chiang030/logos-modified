const SECRET = /authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|signature/i;
const OMIT = /^(thinkingSignature|data)$/i;

function redact(text) {
  return text.replace(/\b(?:sk|pk)-[\w-]{8,}/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;&]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}

/** Walk only a bounded prefix: never stringify the original payload or invoke getters. */
export function snapshot(value, maxBytes = 32768) {
  const seen = new WeakSet();
  let remaining = maxBytes, nodes = 512, truncated = false;
  const cut = () => { truncated = true; return "[TRUNCATED]"; };
  const visit = (item, depth) => {
    if (--nodes < 0 || remaining < 32 || depth > 8) return cut();
    remaining -= 16;
    if (typeof item === "string") {
      const bounded = item.slice(0, Math.min(remaining, 8192));
      const clean = redact(bounded);
      const bytes = Buffer.from(clean);
      const text = bytes.subarray(0, remaining).toString("utf8");
      remaining -= Buffer.byteLength(text);
      if (bounded.length < item.length || bytes.length > Buffer.byteLength(text)) truncated = true;
      return text;
    }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item !== "object") return undefined;
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    const array = Array.isArray(item);
    const result = array ? [] : {};
    let count = 0;
    // Indexed iteration avoids enumerating every key of a very long transcript.
    const keys = array ? Array.from({ length: Math.min(item.length, 64) }, (_, i) => String(i)) : null;
    if (array && item.length > 64) truncated = true;
    function* objectKeys() { for (const key in item) yield key; }
    for (const key of keys ?? objectKeys()) {
      if (!Object.hasOwn(item, key)) continue;
      if (++count > 64 || remaining < 32 || nodes <= 0) { truncated = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const safeKey = key.slice(0, 100);
      if (SECRET.test(safeKey)) { result[safeKey] = "[REDACTED]"; continue; }
      if (safeKey === "thinking" && Object.getOwnPropertyDescriptor(item, "redacted")?.value === true) continue;
      if (OMIT.test(safeKey) && (safeKey !== "data" || Object.getOwnPropertyDescriptor(item, "type")?.value === "image")) continue;
      if (["__proto__", "constructor", "prototype"].includes(safeKey)) continue;
      remaining -= Buffer.byteLength(safeKey);
      result[safeKey] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const data = visit(value, 0);
  // Escaping can expand JSON. This serializes only the already bounded copy.
  if (Buffer.byteLength(JSON.stringify(data) ?? "") > maxBytes) return { data: "[TRUNCATED]", truncated: true };
  return { data, truncated };
}
