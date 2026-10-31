import type { ReactElement } from "react";
import { renderMarkdown } from "../markdown";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  status: "streaming" | "complete" | "error";
}

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props): ReactElement | null {
  // System prompts are runtime plumbing, and an assistant message with no
  // text is hidden after a tool-only turn is detected by the timeline logic.
  // During normal streaming, the empty assistant bubble is intentional and
  // carries the live cursor.
  if (message.role === "system") return null;
  if (message.role === "assistant" && message.text.trim().length === 0 && message.status !== "streaming") return null;

  return (
    <article className={`message message-${message.role} message-${message.status}`}>
      <div className="message-label">{labelForRole(message.role)}</div>
      <div className="message-content">
        {message.text ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} /> : (message.role === "assistant" && message.status === "streaming" ? <span className="typing">▋</span> : null)}
      </div>
    </article>
  );
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
