import type { ReactElement } from "react";
import type { ToolCallView } from "../protocol";

interface Props {
  tool: ToolCallView;
}

export function ToolCallCard({ tool }: Props): ReactElement {
  const output = formatValue(tool.output);
  return (
    <details className={`tool-card tool-${tool.status}`} open={tool.status === "error"}>
      <summary>
        <span className="tool-dot" aria-hidden="true" />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-status">{tool.status}</span>
        {tool.durationMs !== undefined ? <span className="tool-duration">{tool.durationMs} ms</span> : null}
      </summary>
      <div className="tool-body">
        {tool.args !== undefined ? <pre>{formatValue(tool.args)}</pre> : null}
        {output ? <pre>{output}</pre> : <span className="muted">Waiting for output…</span>}
      </div>
    </details>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
