# Member selection and local usage

The API settings panel includes a member dropdown and a usage table. Select a
member before sending a prompt. The roster and stable IDs live in
`src/shared/members.ts`. Names are self-selected; this is usage registration,
not authentication or access control.

The extension writes `sessions/session-identities.json` under its VS Code
workspace storage directory. The settings panel shows its full path and can open
it. The versioned file contains the selected member, immutable session owners,
and deduplicated model response usage. It does not contain prompts, responses,
API keys, access tokens, or application secrets.

Each new session is bound on its first accepted prompt. Switching members does
not rewrite old ownership; start a new conversation to send as another member.
Older conversations without a recorded owner remain labeled “未登记用户” and are
readable, but require a new conversation for further prompts. No historical
identity or consumption is inferred from the current selection.

Usage counts observed final assistant responses, including tool-calling model
responses and failed/aborted responses. One user prompt can cause several model
responses. Transport requests, retries that do not produce a final message,
and independent background calls such as compaction are not guaranteed to be
included. These numbers are not a provider billing ledger.

Pi normalizes input, output, cache-read, and cache-write tokens into disjoint
categories. Their sum is the displayed total; reasoning tokens are already
included in output and are not added again. Missing, invalid, and all-zero usage
is unknown rather than verified zero. Totals with `+` include only the known
portion. Costs are not estimated in this version; use the provider's bill.

Live events and recovered transcripts share response fingerprints, so reopening
a bound session does not count the same response twice. Saved transcript usage
can repair records missed during a crash when that session is reopened. A
corrupt ledger is surfaced as an error and is never silently replaced.

Statistics cover this workspace on this machine since registration. They are
not synchronized across computers or workspaces. For company-wide totals, a
future shared collector or imported ledgers must merge response IDs rather than
sum snapshots. The local roster and files can be edited by their owner and should
not be used as proof of identity or payment obligations.
