import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error("LOGOS Webview error", error, info.componentStack); }
  render(): ReactNode {
    if (this.state.error) return <div className="webview-fatal" role="alert"><strong>LOGOS UI failed to render.</strong><span>{this.state.error.message}</span><button type="button" onClick={() => this.setState({ error: undefined })}>Try again</button></div>;
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("LOGOS Webview root is missing");

createRoot(root).render(
  <StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>,
);
