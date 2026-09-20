# 本地增强文档

[English](./README.md) | **简体中文**

本目录保存基于上游 `lark-channel-bridge` 增加的 Windows / Codex 本地增强功能说明。

## 文档

1. [Codex 第三方 API Provider](./01-codex-third-party-api-key.zh-CN.md)
2. [Lark / Bridge / Codex 架构](./02-lark-bridge-codex-architecture.zh-CN.md)
3. [Codex Session / Thread 管理与本地存储](./03-codex-session-management.zh-CN.md)

当前 Session 管理统一使用三层命令模型：

```text
Lark Scope      → /lark ...
Windows Runtime → /windows ...
Global Sessions → /session ...
```

最新版 UI 还提供针对 Lark Mobile App / Lark Web 的 Interactive Card Action。截图与快速使用说明见根目录 [README 中文版](../README.zh-CN.md)。
