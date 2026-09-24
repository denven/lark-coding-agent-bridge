# Local documentation

**English** | [简体中文](./README.zh-CN.md)

Documentation for this fork's Windows session-management extensions for **Codex CLI** and **Claude Code**. For an overview, commands, and installation, start with the [main README](../README.md). For the upstream bridge itself, see [README.upstream.md](../README.upstream.md).

| Document | Covers |
|---|---|
| [01 — Third-party API key for Codex](./01-codex-third-party-api-key.md) | Running Codex CLI against a third-party API provider with an isolated `CODEX_HOME`, and the `codex3` wrapper the Windows monitor attaches to |
| [02 — Lark, bridge, Codex, and Claude Code architecture](./02-lark-bridge-codex-architecture.md) | The three command layers, the ownership model, and how each transfer works for Codex and Claude Code |
| [03 — Codex / Claude Code session management](./03-codex-session-management.md) | Codex rollout / thread storage reference; the `/session` control plane; Claude Code sessions, the Claude Release Agent, and session-catalog binding |

Each document also has a Simplified Chinese version (`*.zh-CN.md`).
