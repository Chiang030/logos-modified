# Local names and session attribution

The settings panel lets users type a name and choose **添加并使用**, or select a
previously added name. Names are trimmed, limited to 80 characters, and saved
in the current workspace on this machine. Adding the same name again selects
its existing entry. There is no built-in roster and no API usage display.
Names are self-selected registration, not authentication or access control.

The extension stores names, the selected member ID, immutable session owners,
and observed response usage in `sessions/session-identities.json` under VS Code
workspace storage. Usage remains local and is not shown in the settings panel.
The file does not store prompts, responses, API keys, or access tokens.

Upgrading a legacy ledger clears its preset selection and starts with an empty
custom name list. Historical session owners and response records remain intact.
Each new session is bound on its first accepted prompt. Switching names does not
rewrite old ownership; start a new conversation to send as another member.
Older conversations without a recorded owner remain readable but require a new
conversation for further prompts. No historical identity is inferred from the
current selection. A corrupt ledger is reported and is never silently replaced.

# Software discovery

The fourth home-screen shortcut, **全局扫描软件**, opens **软件发现与路径配置**
in settings and starts a scan without requiring a user name or API connection.
The same section offers another global scan, quick revalidation, version
selection, manual executable paths, and restoring automatic discovery.

On Windows, global scans enumerate fixed local disks and search arbitrary
installation directories for the supported executable names. On Linux/macOS,
they search common installation roots, the home directory, and mount locations.
Scans do not launch programs. System internals, dependency trees, and symbolic
links are skipped. A scan stops after 120 seconds or 150,000 directories; the
settings panel explicitly reports limited coverage and unreadable directories.

Results are saved automatically in `software-cache.json`. Cached executable
paths are revalidated on later loads, including quick refresh and manual path
updates. Explicit paths take precedence; an invalid explicit path stays visible
as an error until corrected or reset. The panel shows the host, discovery time,
last global scan coverage, and detected paths. An idle running agent is restarted
after a global scan so its environment uses the new paths. Scanning is disabled
while a task is running. Finding a binary does not verify SDKs or licenses.
