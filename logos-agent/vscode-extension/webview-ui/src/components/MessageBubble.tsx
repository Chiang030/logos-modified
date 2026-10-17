import type { ReactElement } from "react";
import { marked } from "marked";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  status: "streaming" | "complete" | "error";
}

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props): ReactElement {
  return (
    <article className={`message message-${message.role} message-${message.status}`}>
      <div className="message-label">{labelForRole(message.role)}</div>
      <div className="message-content">
        {message.text ? <div dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(marked.parse(message.text, { async: false }) as string) }} /> : (message.status === "streaming" ? <span className="typing">▋</span> : null)}
      </div>
    </article>
  );
}

function sanitizeMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "");
}

function labelForRole(role: ChatMessage["role"]): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "LOGOS";
    case "tool":
      return "Tool";
    default:
      return "System";
  }
}
