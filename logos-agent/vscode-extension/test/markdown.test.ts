import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../webview-ui/src/markdown";

describe("renderMarkdown", () => {
  it("renders common markdown without introducing table elements", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst value = 1;\n```");

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain('class="md-table"');
    expect(html).not.toContain("<table");
    expect(html).toContain("const value = 1;");
  });

  it("removes scripts, event handlers, and dangerous links", () => {
    const html = renderMarkdown('[safe](https://example.com) [bad](javascript:alert(1)) <img src="x" onerror="alert(1)"><script>alert(1)</script>');

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toMatch(/javascript|onerror|<script|alert\(1\)/i);
  });

  it("turns plain HTTP URLs in model and tool output into clickable links", () => {
    const html = renderMarkdown("参考 https://example.com/docs 和 [API 文档](https://example.com/api)。");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="https://example.com/api"');
  });
});
