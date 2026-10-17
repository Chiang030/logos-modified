import { marked } from "marked";

export function renderMarkdown(source: string): string {
  const rendered = marked.parse(source, { async: false, breaks: true, gfm: true }) as string;
  return sanitizeMarkdown(convertTables(rendered));
}

function convertTables(html: string): string {
  return html
    .replace(/<table[^>]*>/gi, '<div class="md-table">')
    .replace(/<\/table>/gi, "</div>")
    .replace(/<thead[^>]*>/gi, '<div class="md-table-head">')
    .replace(/<\/thead>/gi, "</div>")
    .replace(/<tbody[^>]*>/gi, '<div class="md-table-body">')
    .replace(/<\/tbody>/gi, "</div>")
    .replace(/<tr[^>]*>/gi, '<div class="md-table-row">')
    .replace(/<\/tr>/gi, "</div>")
    .replace(/<th[^>]*>/gi, '<span class="md-table-cell md-table-header">')
    .replace(/<\/th>/gi, "</span>")
    .replace(/<td[^>]*>/gi, '<span class="md-table-cell">')
    .replace(/<\/td>/gi, "</span>");
}

function sanitizeMarkdown(html: string): string {
  const withoutDangerousBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  const withSafeUrls = withoutDangerousBlocks.replace(
    /\s+(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (_attribute, name: string, rawValue: string) => {
      const value = stripQuotes(rawValue);
      return isSafeUrl(value) ? ` ${name.toLowerCase()}="${escapeAttribute(value)}"` : "";
    },
  );

  const allowedTags = new Set([
    "a", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "hr", "img", "li", "ol", "p", "pre", "span", "strong", "ul",
  ]);
  return withSafeUrls.replace(/<\/?([a-z][\w-]*)(\s[^<>]*?)?\/?\s*>/gi, (tag, name: string, attributes = "") => {
    const normalizedName = name.toLowerCase();
    if (!allowedTags.has(normalizedName)) return "";
    if (tag.startsWith("</")) return `</${normalizedName}>`;
    return `<${normalizedName}${sanitizeAttributes(normalizedName, attributes)}>`;
  });
}

function sanitizeAttributes(tagName: string, source: string): string {
  const allowed = tagName === "a"
    ? new Set(["class", "href", "rel", "target", "title"])
    : tagName === "img"
      ? new Set(["alt", "class", "src", "title"])
      : new Set(["class"]);
  let result = "";
  const attributes = /([:\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  for (const match of source.matchAll(attributes)) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) continue;
    const rawValue = match[2];
    const value = stripQuotes(rawValue);
    if ((name === "href" || name === "src") && !isSafeUrl(value)) continue;
    result += ` ${name}="${escapeAttribute(value)}"`;
  }
  return result;
}

function isSafeUrl(value: string): boolean {
  const normalized = decodeEntities(value).replace(/[\u0000-\u0020]/g, "").toLowerCase();
  return !/^(?:javascript|vbscript|data):/.test(normalized);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([\da-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&colon;/gi, ":");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripQuotes(value: string): string {
  return (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;
}
