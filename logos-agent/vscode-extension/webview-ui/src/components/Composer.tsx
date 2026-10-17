import { useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import { ArrowUp, BrainCircuit, CheckCircle2, ChevronDown, Cpu } from "lucide-react";
import type { ContextUsage, ModelOption } from "../protocol";

interface Props {
  busy: boolean;
  models: ModelOption[];
  activeModel?: ModelOption;
  thinkingLevel?: string;
  thinkingLevels: string[];
  contextUsage?: ContextUsage;
  onSelectModel: (model: ModelOption) => void;
  onSelectThinking: (level: string) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  value?: string;
  onValueChange?: (value: string) => void;
}

export function Composer({
  busy,
  models,
  activeModel,
  thinkingLevel,
  thinkingLevels,
  contextUsage,
  onSelectModel,
  onSelectThinking,
  onSend,
  onAbort,
  value: controlledValue,
  onValueChange,
}: Props): ReactElement {
  const [internalValue, setInternalValue] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const value = controlledValue ?? internalValue;
  const setValue = (next: string): void => { onValueChange?.(next); if (!onValueChange) setInternalValue(next); };
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const contextPercent = contextUsage?.percent == null ? undefined : Math.max(0, Math.min(100, contextUsage.percent));
  const modelLabel = activeModel?.name || activeModel?.id || "Model unavailable";
  const thinkingLabel = thinkingLevel ? formatThinkingLevel(thinkingLevel) : "Thinking unavailable";

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
          placeholder="Type /simulate or design query..."
          aria-label="Message LOGOS"
          rows={2}
          disabled={busy}
        />
        <div className="composer-actions">
          <div className="composer-meta">
            <div className="model-picker">
              <button type="button" className="model-chip" title={activeModel ? `${activeModel.provider}/${activeModel.id}` : "No model available"} onClick={() => { setModelOpen((open) => !open); setThinkingOpen(false); }} disabled={busy || models.length === 0}>
                <Cpu size={13} /> <span>{modelLabel}</span><ChevronDown size={12} />
              </button>
              {modelOpen ? <div className="model-menu" role="menu">
                {models.map((model) => {
                  const key = `${model.provider}/${model.id}`;
                  const selected = model.provider === activeModel?.provider && model.id === activeModel?.id;
                  return <button type="button" key={key} className={selected ? "selected" : ""} onClick={() => { onSelectModel(model); setModelOpen(false); }}><span>{model.name || model.id}</span>{selected ? <CheckCircle2 size={12} /> : null}</button>;
                })}
              </div> : null}
            </div>
            <div className="thinking-picker">
              <button type="button" className="thinking-chip" title="Thinking strength" onClick={() => { setThinkingOpen((open) => !open); setModelOpen(false); }} disabled={busy || thinkingLevels.length === 0}>
                <BrainCircuit size={13} /> <span>{thinkingLabel}</span><ChevronDown size={12} />
              </button>
              {thinkingOpen ? <div className="model-menu thinking-menu" role="menu">
                {thinkingLevels.map((level) => <button type="button" key={level} className={level === thinkingLevel ? "selected" : ""} onClick={() => { onSelectThinking(level); setThinkingOpen(false); }}><span>{formatThinkingLevel(level)}</span>{level === thinkingLevel ? <CheckCircle2 size={12} /> : null}</button>)}
              </div> : null}
            </div>
            <span className="context-chip" title={contextTitle(contextUsage)} aria-label={`Context usage ${contextPercent == null ? "unknown" : `${Math.round(contextPercent)} percent`}`}>
              <span>Context:</span> <strong>{contextPercent == null ? "—" : `${Math.round(contextPercent)}%`}</strong>
              <span className="context-meter" aria-hidden="true"><span style={{ width: `${contextPercent ?? 0}%` }} /></span>
            </span>
            <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
          </div>
          {busy ? (
            <button type="button" className="secondary send-button" onClick={onAbort} aria-label="Stop">
              ■
            </button>
          ) : (
            <button type="submit" className="primary send-button" disabled={!value.trim()} aria-label="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function formatThinkingLevel(level: string): string {
  return level.length > 0 ? level[0].toUpperCase() + level.slice(1) : level;
}

function contextTitle(contextUsage?: ContextUsage): string {
  if (!contextUsage || contextUsage.percent == null) return "Context usage is not available yet";
  const tokens = contextUsage.tokens == null ? "unknown" : contextUsage.tokens.toLocaleString();
  return `${tokens} / ${contextUsage.contextWindow.toLocaleString()} tokens (${Math.round(contextUsage.percent)}%)`;
}
