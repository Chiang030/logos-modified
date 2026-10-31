import { normalizeAccountLimitMessage } from "../src/model-errors.mjs";

/** Classify terminal account failures before Pi persists the message or schedules a retry. */
export default function registerModelErrorPolicy(pi) {
  pi.on("message_end", (event) => {
    const message = normalizeAccountLimitMessage(event.message);
    if (message) return { message };
  });
}
