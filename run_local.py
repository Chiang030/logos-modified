"""Small Agent Server client for the Logos root chat graph."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

from dotenv import load_dotenv
from langgraph_sdk import get_sync_client


def _check_server(server_url: str) -> None:
    with urlopen(f"{server_url.rstrip('/')}/info", timeout=3) as response:
        if response.status != 200:
            raise ConnectionError(f"GET /info returned HTTP {response.status}")


def _connection_error(server_url: str, exc: Exception) -> int:
    print(f"无法连接 Logos Agent Server：{server_url}", file=sys.stderr)
    print(f"原因：{type(exc).__name__}: {exc}", file=sys.stderr)
    print("\n请先在项目根目录启动服务：", file=sys.stderr)
    print('$env:PYTHONUTF8 = "1"', file=sys.stderr)
    print(".\\.venv\\Scripts\\langgraph.exe dev --port 2025", file=sys.stderr)
    return 2


def _message_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        block if isinstance(block, str) else str(block.get("text", ""))
        for block in content
        if isinstance(block, (str, dict))
    )


def run_chat(server_url: str, request: str, thread_id: str | None = None) -> int:
    client = get_sync_client(url=server_url)
    if thread_id:
        client.threads.create(
            thread_id=thread_id,
            if_exists="do_nothing",
            graph_id="chat_agent",
        )
        active_thread_id = thread_id
    else:
        active_thread_id = client.threads.create(
            metadata={"client": "run_local.py", "graph_id": "chat_agent"}
        )["thread_id"]

    print(f"Thread: {active_thread_id}", flush=True)
    run = client.runs.create(
        active_thread_id,
        "chat_agent",
        input={"messages": [{"role": "user", "content": request}]},
        stream_mode=["values", "messages-tuple", "updates"],
        stream_subgraphs=True,
        stream_resumable=True,
    )

    printed_ids: set[str] = set()
    for part in client.runs.join_stream(
        active_thread_id,
        run["run_id"],
        stream_mode=["values", "messages-tuple", "updates"],
    ):
        if not str(part.event).startswith("messages"):
            continue
        data = part.data
        message = data[0] if isinstance(data, (list, tuple)) and data else data
        if not isinstance(message, dict):
            continue
        message_id = str(message.get("id", ""))
        text = _message_text(message).strip()
        if not text or (message_id and message_id in printed_ids):
            continue
        if message_id:
            printed_ids.add(message_id)
        print(text, flush=True)

    client.runs.join(active_thread_id, run["run_id"])
    values = client.threads.get_state(active_thread_id).get("values") or {}
    print("\n当前状态")
    for key in (
        "status",
        "execution_status",
        "numerical_validation_status",
        "engineering_status",
    ):
        if key in values:
            print(f"  {key}: {values[key]}")
    if manifest := values.get("artifact_manifest"):
        print(
            f"  frozen_artifacts: {len(manifest.get('artifacts', []))} "
            f"(input-v{manifest.get('input_version', 0)})"
        )
    if error := values.get("error"):
        print(f"  error: {error}")
    return 1 if values.get("status") in {"failed", "max_attempts_exhausted"} else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="连接 Logos Agent Server 并运行官方 chat_agent 图。"
    )
    parser.add_argument("request", nargs="*", help="消息内容；省略时交互输入")
    parser.add_argument(
        "--server",
        default=os.getenv("LOGOS_AGENT_SERVER_URL", "http://127.0.0.1:2025"),
        help="Agent Server URL",
    )
    parser.add_argument("--thread-id", help="复用指定主 Thread")
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    load_dotenv()
    args = parse_args()
    request = " ".join(args.request).strip()
    if not request:
        try:
            request = input("请输入消息：").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n未提供消息。", file=sys.stderr)
            return 1
    if not request:
        print("消息不能为空。", file=sys.stderr)
        return 1

    server_url = args.server.rstrip("/")
    try:
        _check_server(server_url)
        return run_chat(server_url, request, args.thread_id)
    except (URLError, TimeoutError, ConnectionError, OSError) as exc:
        return _connection_error(server_url, exc)
    except Exception as exc:
        print(
            json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
