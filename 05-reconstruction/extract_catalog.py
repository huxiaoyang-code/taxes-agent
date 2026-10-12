# -*- coding: utf-8 -*-
"""Extract the 有数云 /work 财税工作台 agent specification from the captured bundle.

The bundle (02-scripts/work/index-yoSd2Nx7.js) shows that the workbench is a
client of the OpenAI **Codex app-server**. This script pulls out the domain
declarations that are embedded in the frontend bundle so they can be reused
when rebuilding the same capability set with Codex (CLI or app-server).

Run:  python 05-reconstruction/extract_catalog.py
"""
import io, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = os.path.join(ROOT, "02-scripts", "work", "index-yoSd2Nx7.js")
OUT = os.path.join(ROOT, "05-reconstruction", "catalog.json")


def obj_pairs(text):
    """Parse a flat JS object literal `{ k:"v", "k2":"v2", ... }` into a dict."""
    return dict(re.findall(r'"?([A-Za-z_][\w./-]*)"?\s*:\s*"((?:[^"\\]|\\.)*)"', text))


def arr_objects(text):
    """Parse `[{ a:"x", b:"y" }, ...]` with only string fields."""
    out = []
    for chunk in re.findall(r"\{([^{}]*)\}", text):
        out.append(dict(re.findall(r'([A-Za-z_][\w]*)\s*:\s*"((?:[^"\\]|\\.)*)"', chunk)))
    return out


def slice_between(src, start_marker, end_marker):
    i = src.find(start_marker)
    j = src.find(end_marker, i)
    if i < 0 or j < 0:
        raise SystemExit("marker not found: %r" % start_marker)
    return src[i + len(start_marker):j]


def main():
    src = io.open(BUNDLE, encoding="utf-8", errors="ignore").read()

    subagents = arr_objects(slice_between(src, "P9e=[", "],O9e="))
    query_catalog = obj_pairs(slice_between(src, "O9e={", "};function k9e"))
    tools = obj_pairs(slice_between(src, "const E9={", "},_9e="))
    skill_files = obj_pairs(slice_between(src, "_9e={", "},j9e="))
    activity_labels = obj_pairs(slice_between(src, "j9e={", "};function z9e"))

    catalog = {
        "source_bundle": "02-scripts/work/index-yoSd2Nx7.js",
        "source_bundle_sha256": "098e3f59318305abace7f8f600fac22986f7102438af73c652266b716fe0265e",
        "runtime": "OpenAI Codex app-server (WebSocket subprotocol codex-runtime-ticket.<ticket>)",
        "runtime_protocol": {
            "ticket_endpoint": "POST /api/agent/runtime-ticket  (override: window.__WEB_CHAT_CONFIG__.runtimeTicketUrl)",
            "transport": "WebSocket, subprotocol `codex-runtime-ticket.${ticket}`",
            "client_error_type": "CodexAppServerRpcError",
            "native_item_types": [
                "userMessage", "agentMessage", "reasoning", "plan", "commandExecution",
                "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall",
                "subAgentActivity", "webSearch", "imageView", "imageGeneration",
                "contextCompaction", "sleep", "enteredReviewMode", "exitedReviewMode",
                "hookPrompt", "functionCallOutput"
            ],
            "native_error_codes": ["app_server_unavailable", "app_server_closed",
                                   "thread_bridge_closed", "thread_bridge_disconnected",
                                   "thread_bridge_unavailable", "thread_bridge_stalled"],
            "delegation_envelope": "<codex_delegation><source_thread_id>..</source_thread_id><input>..</input></codex_delegation>",
            "subagent_spawn_kind": "subAgentThreadSpawn (parent_thread_id / thread_spawn)",
            "approval_kind": "codex_approval_kind=mcp_tool_call; elicitation mode openai/form with requestedSchema",
            "model_api": "OpenAI Responses API (/v1/responses, api.openai.com)",
            "sentry_release": "codex2-verified-release-20261011 / service codex2-web"
        },
        "subagents": subagents,
        "dynamic_tools": tools,
        "finance_query_catalog": query_catalog,
        "skill_files": skill_files,
        "activity_labels": activity_labels,
        "skill_market_scopes": {"user": "用户 Skill", "repo": "项目 Skill",
                                "system": "内置 Skill", "admin": "管理员 Skill"},
        "backends": {
            "work": {"base_url": "/api", "note": "axios baseURL='/api', withCredentials=true, timeout=30s"},
            "finance": {"base_url": "/finance-api", "note": "auth/signup app"}
        },
    }

    with io.open(OUT, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=2)
    print("wrote", OUT)
    print("subagents=%d tools=%d queries=%d skills=%d" % (
        len(subagents), len(tools), len(query_catalog), len(skill_files)))


if __name__ == "__main__":
    main()
