# 本地文档

[English](./README.md) | **简体中文**

本 fork 面向 **Codex CLI** 与 **Claude Code** 的 Windows Session 管理扩展的文档。概览、命令和安装请先看[主 README](../README.zh-CN.md)；上游 bridge 本身请看 [README.zh.md](../README.zh.md)。

| 文档 | 内容 |
|---|---|
| [01 — Codex 使用第三方 API Key](./01-codex-third-party-api-key.zh-CN.md) | 用独立的 `CODEX_HOME` 让 Codex CLI 连接第三方 API 提供方，以及 Windows monitor 所依赖的 `codex3` wrapper |
| [02 — Lark、bridge、Codex 与 Claude Code 的架构](./02-lark-bridge-codex-architecture.zh-CN.md) | 三层命令、ownership 模型，以及 Codex 与 Claude Code 的每种交接如何进行 |
| [03 — Codex / Claude Code Session 管理](./03-codex-session-management.zh-CN.md) | Codex rollout / thread 存储参考；`/session` 控制面；Claude Code 会话、Claude Release Agent 与 session catalog 绑定 |

每篇文档都有英文版本（去掉 `.zh-CN` 后缀）。
