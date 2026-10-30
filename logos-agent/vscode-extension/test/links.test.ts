import { describe, expect, it } from "vitest";
import { resolveMessageLink } from "../src/links";
import { redactDiagnostic } from "../src/diagnostics";

describe("message links", () => {
  it("opens Windows paths, encoded names, file URIs and line numbers", () => {
    expect(resolveMessageLink("D:/项目/My%20Report.md:12", "D:/work")).toEqual({ kind: "file", path: "D:/项目/My Report.md", line: 12 });
    expect(resolveMessageLink("docs/report.md#L9", process.cwd())).toMatchObject({ kind: "file", line: 9 });
    expect(resolveMessageLink("https://example.org/a?q=2", "")).toEqual({ kind: "external", url: "https://example.org/a?q=2" });
  });
  it.each(["command:workbench.action.closeWindow", "javascript:alert(1)", "data:text/html,evil", "vscode://anything", "https://user:password@example.org"])("rejects unsafe link %s", (url) => {
    expect(() => resolveMessageLink(url, process.cwd())).toThrow();
  });
  it("redacts diagnostic credentials", () => {
    const text = redactDiagnostic('Authorization: Bearer secret-token {"api_key":"secret-key"} https://user:pass@host/');
    expect(text).not.toContain("secret-token"); expect(text).not.toContain("secret-key"); expect(text).not.toContain("user:pass");
  });
});
