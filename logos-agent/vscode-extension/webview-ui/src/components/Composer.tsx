import { useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";

interface Props {
  busy: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  onRetry: () => void;
  canRetry: boolean;
}

export function Composer({ busy, onSend, onAbort, onRetry, canRetry }: Props): ReactElement {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setHistory((current) => [text, ...current.filter((item) => item !== text)].slice(0, 50));
    setHistoryIndex(-1);
    setValue("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "ArrowUp" && !event.shiftKey && history.length > 0 && event.currentTarget.selectionStart === 0) {
      const next = Math.min(historyIndex + 1, history.length - 1);
      if (historyIndex >= 0 || value.trim() === "") { event.preventDefault(); setHistoryIndex(next); setValue(history[next]); }
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && historyIndex >= 0 && event.currentTarget.selectionEnd === event.currentTarget.value.length) {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setValue(next < 0 ? "" : history[next]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      <form className="composer" onSubmit={submit}>
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask LOGOS to work on this workspace…"
          aria-label="Message LOGOS"
          rows={3}
          disabled={busy}
        />
        <div className="composer-actions">
          <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
          {busy ? (
            <button type="button" className="secondary" onClick={onAbort}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!value.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
      {canRetry && !busy ? (
        <button type="button" className="retry" onClick={onRetry}>
          Retry last message
        </button>
      ) : null}
    </div>
  );
}
