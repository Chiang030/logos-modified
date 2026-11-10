/** Generate a UUID on both HTTPS and private HTTP origins without weakening randomness. */
export function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function copyWithoutClipboardApi(text: string): Promise<void> {
  const previous = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(input);
  try {
    input.focus(); input.select();
    if (!document.execCommand("copy")) throw new Error("浏览器未允许复制，请手动选择文本复制");
  } finally {
    input.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

/** Supply the shared extension UI's copy action on private HTTP deployments. */
export function installClipboardFallback(): void {
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copyWithoutClipboardApi } });
  }
}
