# Logos 多智能体 Web 工作区

该应用以 Web 作为多智能体协作入口。总师、建模和验证是三个可被用户直接访问的同级 Agent Graph；每个 Agent 拥有多个独立 Session，每个 Session 对应独立 LangGraph Thread。

## 组成

- `web/`：React + Vite 三栏工作台，包含 Agent/Session 导航、会话、任务派发、运行观测、文件、Artifact 和 Revision 管理。
- `backend/logos_workspace/control_plane.py`：Workspace、Session、Message、Task、Run 和 ChangeSet 协作治理。
- `backend/logos_workspace/scheduler.py`：每个 Session 串行、不同 Session 并行的后台 Inbox 调度器。
- `backend/logos_workspace/workspace_storage.py`：共享、Agent 私有、Session 和 Run 四层文件空间。
- `backend/logos_workspace/agents/`：三个独立 Deep Agents / LangGraph Graph。
- `docker-compose.yml`：生产配置使用的 PostgreSQL 17。

完整产品需求见 [documents/多智能体Web工作区实现需求.md](documents/多智能体Web工作区实现需求.md)。

## 本地启动

环境要求：Python 3.12、uv、Node.js 20+、pnpm。默认确定性运行时无需 API Key。

后端：

```powershell
cd apps/logos-workspace/backend
py -3.12 -m uv sync
py -3.12 -m uv run uvicorn logos_workspace.main:app --host 127.0.0.1 --port 8000
```

前端：

```powershell
cd apps/logos-workspace/web
pnpm install
pnpm dev
```

打开 http://127.0.0.1:5173 。API 文档位于 http://127.0.0.1:8000/docs 。

## PostgreSQL

```powershell
cd apps/logos-workspace
docker compose up -d postgres
Copy-Item .env.example .env
cd backend
py -3.12 -m uv run uvicorn logos_workspace.main:app --host 127.0.0.1 --port 8000
```

`.env.example` 已配置本机映射端口 `55432`。SQLite 仅作为无需外部服务的本地开发与隔离测试模式。

## LangGraph Server

启动三个独立 Graph：

```powershell
cd apps/logos-workspace/backend
$env:PYTHONUTF8 = "1"
py -3.12 -m uv run langgraph dev --host 127.0.0.1 --port 2025 --no-browser
```

然后在 Control Plane 环境中设置：

```powershell
$env:LOGOS_RUNTIME_MODE = "langgraph"
$env:LOGOS_LANGGRAPH_URL = "http://127.0.0.1:2025"
```

未设置 `OPENAI_API_KEY` 时，Graph 使用本地 fallback 模型，便于验证完整协议；设置 `OPENAI_API_KEY`、`OPENAI_MODEL` 和可选的 `OPENAI_BASE_URL` 后使用 OpenAI 兼容模型。

## 验证

```powershell
cd apps/logos-workspace/backend
py -3.12 -m uv run pytest -q
py -3.12 -m uv run ruff check logos_workspace tests

cd ../web
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Playwright 覆盖桌面与手机布局，以及直接对话、新建/继续/Fork 派发、文件创建和 ChangeSet 发布。
