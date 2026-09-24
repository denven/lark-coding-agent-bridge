# Lark、lark-channel-bridge、Codex 与 Claude Code 的架构和运行机制

[English](./02-lark-bridge-codex-architecture.md) | **简体中文**

本地增强版采用三层 Session 管理模型，并通过 Lark Interactive Card 提供对应 UI：

```text
Lark Scope
→ /lark status | /lark new | /lark resume

Windows Runtime（仅 Codex bot）
→ /windows status | /windows release

Global Session Manager
→ /session list | /session use | /session handoff | /session handback | /session tail
```

旧命令继续作为兼容 alias。

一个 profile 只运行一种 agent——Codex 或 Claude Code——所以所有 `/session` 命令都作用于这个 profile 的 agent，Codex bot 和 Claude bot 上的命令完全相同。要同时管理两种会话，就每种各用一个 bot。

## Ownership model

```text
Session（Codex 或 Claude Code）
├─ Windows writer
├─ Lark scope
└─ Detached
```

任意时刻只应该有一个逻辑 writer。Thread Name 用于展示；release、use、handoff 等真正执行时使用 exact full Session ID。

Lark 绑定要同时写两处：`sessions.json`（ownership 视图读取它）和 session catalog（下一条 Lark 消息从它续接——Codex 只从 catalog 续接）。只写其中一处不算绑定。

## Lark 交互层

三层命令同时对应三个 UI 视角：

```text
/lark status
→ 当前 Lark scope

/windows status
→ Windows runtime（Codex）

/session list
→ 全局 ownership / inventory
```

这种 Card 化设计主要用于改善 **Lark Mobile App** 和 **Lark Web** 中的远程管理体验：

- `/lark status` 提供当前 scope 的快捷 Action。
- `/windows status` 为可安全 release 的 Windows Codex Session 增加一键 Release。
- `/session list` 打开时显示分类标签（Handoff / Use / Hand Back / All，取最近 10 个 Session），并根据 ownership 显示 Action。
- Web / Desktop 可显示 `hover_tips`；Mobile 没有 hover，因此按钮名称本身必须清楚。

按钮只写动作和方向——**Handoff to Lark**、**Use in Lark**、**Hand Back to Windows**、**Last Response**；上方编号行标明是哪个 Session，hover 提示会重复其标题：

```text
用户看到的身份
编号行 —— Thread Name，没有名称时用 short Session ID

机器真正执行
按钮里携带的 exact full Session ID
```

Project Name 和 cwd 可以作为辅助信息展示，但不能作为 Session identity，因为多个 Session 可以属于同一 Project / cwd。

## Windows → Lark

```text
/session handoff <selector>
```

顺序必须是：

```text
验证 Windows Session
→ release Windows writer
→ bind 当前 Lark scope（catalog + sessions.json）
```

绝不能先 bind Lark 再 release Windows。Card 上可以显示 Thread Name，但内部会把完整 Session ID 交给 release / handoff handler。

由于 bridge 是普通权限的计划任务，真正的释放由一个与 writer 同等权限的代理执行：

- **Codex**：`codex3` 为每个会话启动的 Release Agent（`Request-CodexRelease.ps1` → `Watch-CodexRelease.ps1` → `Release-CodexSession.ps1`）。
- **Claude Code**：`Request-ClaudeRelease.ps1`。如果管理员权限的 Claude Release Agent 在运行（`Watch-ClaudeRelease.ps1`，由 `Register-ClaudeReleaseAgent.ps1` 注册一次），就交给它执行；否则直接运行，只对非管理员窗口有效。

结果卡片会显示 **Last Windows Response**，方便在 Lark 里接着对话。

## Lark → Windows

```text
/session handback
```

Bridge 解除当前 Lark binding（并归档 catalog 条目），保留历史，并返回 `codex3 resume <Session-ID>` 或 `claude --resume <Session-ID>`。不需要把任何内容带回去：Lark 里的对话也在同一台 Windows 上执行，写进同一个 rollout / transcript。

## Detached → Lark

```text
/session use <selector>
```

`/session use` 只绑定已经 Detached 的 Session，不负责结束 Windows writer。如果目标仍由 Windows 控制，应使用 `/session handoff`。结果卡片会显示该会话的 **Last Response**。

## Global inventory

```text
/session list
```

Inventory 聚合 agent 的历史（Codex 的 rollout 与 index；Claude Code 的 transcript）、Windows 上的实时状态（Codex Observer 的 status 文件；Claude Code 自己的进程登记）与 Lark scope binding。Owner 可以是 Windows、Lark 或 Detached。

Interactive Card 根据 ownership 显示 Action：

```text
Detached       → Use in Lark
Windows        → Handoff to Lark
Lark · Current → Hand Back to Windows
```

注定失败的 Action 不会显示。handoff 状态为「不可接管」的会话——例如没有经过 `codex3` attach 的 Codex、writer 已退出但 Observer 还在的 Codex、没有 Claude Release Agent 时的管理员 Claude 窗口——不提供 Handoff 按钮，`/session handoff` 会说明原因。底层 handler 仍会做正常的安全校验。

## Windows monitor

Codex 自己没有运行中进程的登记，所以需要监控层：

```text
Attach-CodexObserver.ps1   识别 codex3 启动或恢复的会话
Watch-CodexSession.ps1     Observer：写状态心跳；它的 Codex 退出后自行结束
Watch-CodexRelease.ps1     每个会话一个 Release Agent；Codex 退出后自行结束
Request-CodexRelease.ps1   bridge 发出的释放请求
Release-CodexSession.ps1   校验进程身份后终止 writer
```

Attach 会直接从命令行识别 `codex3 resume <Session-ID | 唯一的 thread 名称>`；新会话则以它写出的第一个 rollout 识别。

Claude Code 判断状态不需要监控层：它会把每个运行中的进程登记在 `~/.claude/sessions/<pid>.json`。只有释放才需要上面列出的脚本。

`/windows status` 是 runtime 视角，`/lark status` 是当前 scope 视角，`/session list` 是全局 inventory 视角。

## 对远程工作流的意义

上游 bridge 已经能够让 Lark 与 Codex、Claude Code 对话；本地 Session 管理层进一步提供了 Windows 上长时间运行会话的远程控制面。Codex 或 Claude Code 可以继续运行在工作站上，用户离开电脑后使用 Lark Mobile 或 Lark Web 查看状态、把 Waiting 的 Windows Session handoff 过来、在 Lark 中继续同一个 Session，再在需要时 handback 到 Windows，底层 Session ID 始终保持一致。
