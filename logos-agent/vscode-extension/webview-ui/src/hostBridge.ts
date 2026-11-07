import type { ExtensionToWebviewMessage } from "./protocol";

export interface HostBridge {
  postMessage(message: unknown): void;
  subscribe(listener: (message: ExtensionToWebviewMessage) => void): () => void;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
let bridge: HostBridge | undefined;

/** Lazily acquire VS Code once; browser hosts inject their own transport. */
export function getHostBridge(): HostBridge {
  if (!bridge) {
    const api = acquireVsCodeApi();
    bridge = {
      postMessage: (message) => api.postMessage(message),
      subscribe: (listener) => {
        const receive = (event: MessageEvent<ExtensionToWebviewMessage>): void => listener(event.data);
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
      },
    };
  }
  return bridge;
}
