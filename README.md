# Logos Agent

Logos is a local LangGraph prototype built from the official LangChain,
LangGraph, Deep Agents, and Agent Chat UI packages. It has three Agents: a
user-facing conversation/planning Deep Agent, a modeling Deep Agent, and an
independent LangChain validation Agent. A single root LangGraph owns the
deterministic execution order and retry loop.

The prototype does not run a physical solver. It emits frozen placeholder
artifacts so orchestration, provenance, hashing, context isolation, and
validation behavior can be exercised without claiming numerical or engineering
acceptance.

## Architecture

```text
user conversation
  -> conversation/planning agent
       -> answer or clarify -> wait for the next user turn
       -> structured TaskPlan
  -> modeling agent
  -> deterministic placeholder execution
  -> frozen artifact manifest
  -> independent validation agent
  -> prototype_complete or revision_required
```

The conversation Agent lives in `src/agent/chat_agent.py`; the modeling and
validation definitions live in `src/agent/agents/`. The conversation Agent
returns `answer`, `clarify`, or `submit_plan`; it does not call a workflow tool
or execute modeling. `src/agent/graph.py` adopts complete plans, assigns
identifiers, calls the modeling and validation Agents as ordinary LangGraph
nodes, freezes artifacts, and controls retries. There are no browser-driven
interrupts, Agent Server self-calls, or custom child-Thread protocol.

Skill directories under `src/agent/skills/` contain the initial scope and safety
rules loaded on demand by Deep Agents. Add domain procedures there as they are
defined.

## Setup

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]" --index-url https://pypi.org/simple
```

Copy `.env.example` to `.env` and configure the OpenAI-compatible endpoint,
model, and API key. Secrets belong only in `.env`.

## Start the Agent Server

```powershell
$env:PYTHONUTF8 = "1"
.\.venv\Scripts\langgraph.exe dev --port 2025
```

The server exposes one Assistant:

- `chat_agent`: conversation, planning, and the complete root graph. The root
  graph invokes the modeling and validation Agents directly in the same server
  process.

After changing `langgraph.json` or Agent code, restart the server so the graph
registration is reloaded.

## Start the chat interface

In a second terminal:

```powershell
cd agent-chat-ui
corepack pnpm dev
```

Open `http://127.0.0.1:3000`. This is the unmodified official Agent Chat UI
connected to `chat_agent`. It displays the root conversation and official tool
stream. All stage progression happens on the server during the same root run;
the browser does not resume, coordinate, or maintain child workflows.

## Run the CLI client

With the Agent Server already running:

```powershell
.\.venv\Scripts\python.exe run_local.py
```

The script displays an input prompt and streams the root Agent run. A request can
also be passed directly:

```powershell
.\.venv\Scripts\python.exe run_local.py "Create a thermal-structural placeholder workflow"
```

Set `LOGOS_AGENT_SERVER_URL` when the server uses another address. If the server
is unavailable, the CLI exits immediately and prints the startup command.

Each workflow writes immutable evidence to
`.runs/<run-id>/input-v<version>/`. Old versions remain in place after a user
revision. Placeholder completion is recorded separately from numerical
validation and engineering acceptance.

The local development server keeps Thread checkpoints in memory. Browser refresh
is recoverable, while an Agent Server restart discards conversation state.
Restart-safe persistence and long-term user memory require a database-backed
checkpointer and Store and remain outside this version.

Deep Agents currently provides Skill discovery, filesystem tools, context
management, and sub-agent infrastructure. Shell execution, web search, MCP,
human approval rules, and durable long-term memory have not yet been connected.

## Tests

```powershell
python -m pytest -vv
cd agent-chat-ui
corepack pnpm lint
corepack pnpm build
```

The live integration test requires a running Agent Server and uses the configured
external model. It verifies the independent child Threads and confirms that a
modified frozen artifact is rejected by hash validation.
