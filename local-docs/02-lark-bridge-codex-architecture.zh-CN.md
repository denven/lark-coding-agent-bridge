# Lark、lark-channel-bridge 与 Codex 的架构和运行机制

[English](./02-lark-bridge-codex-architecture.md) | **简体中文**

本地增强版采用三层 Session 管理模型，并通过 Lark Interactive Card 提供对应 UI：

```text
Lark Scope
→ /lark status | /lark new | /lark resume

Windows Runtime
→ /windows status | /windows release

Global Session Manager
→ /session list | /session use | /session handoff | /session handback
```

旧命令继续作为兼容 alias。

## Ownership model

```text
Codex Session
├─ Windows
├─ Lark scope
└─ Detached / Unknown
```

任意时刻只应该有一个逻辑 writer。Thread Name 用于展示；release、use、handoff 等真正执行时使用 exact full Session ID。

## Lark 交互层

三层命令同时对应三个 UI 视角：

```text
/lark status
→ 当前 Lark scope

/windows status
→ Windows runtime

/session list
→ 全局 ownership / inventory
```

这种 Card 化设计主要用于改善 **Lark Mobile App** 和 **Lark Web** 中的远程管理体验：

- `/lark status` 提供当前 scope 的快捷 Action。
- `/windows status` 为可安全 release 的 Windows Session 增加一键 Release。
- `/session list` 根据 ownership 自动显示 Use、Handoff、Hand Back。
- Web / Desktop 可显示 `hover_tips`；Mobile 没有 hover，因此按钮名称本身必须清楚。

显示名称和真正执行目标严格分离：

```text
用户看到的 Action label
Thread Name
→ Thread Name 重名时追加 short Session ID
→ 没有 Thread Name 时显示 short Session ID

机器真正执行
exact full Session ID
```

Project Name 和 cwd 可以作为辅助信息展示，但不能作为 Session identity，因为多个 Session 可以属于同一 Project / cwd。

## Windows → Lark

```text
/windows status
/session handoff <selector>
```

顺序必须是：

```text
验证 Windows Session
→ release Windows writer
→ bind 当前 Lark scope
```

绝不能先 bind Lark 再 release Windows。Card 上可以显示 Thread Name，但内部会把完整 Session ID 交给 release / handoff handler。

## Lark → Windows

```text
/session handback
```

Bridge 解除当前 Lark binding，保留 Codex 历史，并返回 `codex3 resume <Session-ID>`。

## Detached → Lark

```text
/session use <selector>
```

`/session use` 只绑定已经 Detached 的 Session，不负责结束 Windows writer。如果目标仍由 Windows 控制，应使用 `/session handoff`。

## Global inventory

```text
/session list
```

Inventory 聚合 Codex history/index、rollout metadata、Windows monitor state 与 Lark scope binding。Owner 可以是 Windows、Lark、Detached 或 Unknown / Unmanaged。

Interactive Card 根据 ownership 显示 Action：

```text
Detached       → Use in this Lark
Windows        → Handoff to this Lark
Lark · Current → Hand Back to Windows
```

为了方便操作而增加按钮，不会绕过原有安全校验；不安全或不适用的 Action 不应该显示。

## Windows monitor

Windows 层使用：

```text
Attach-CodexObserver.ps1
Watch-CodexSession.ps1
Watch-CodexRelease.ps1
Request-CodexRelease.ps1
Release-CodexSession.ps1
```

`/windows status` 是 runtime 视角，`/lark status` 是当前 scope 视角，`/session list` 是全局 inventory 视角。

## 对远程工作流的意义

上游 bridge 已经能够让 Lark 与 Codex 对话；本地 Session 管理层进一步提供了 Windows Codex 的远程控制面。Codex 可以继续运行在工作站上，用户离开电脑后使用 Lark Mobile 或 Lark Web 查看状态、释放或 handoff 已 Waiting 的 Session、从 Lark 继续同一个 Session，再在需要时 handback 到 Windows，底层 Session ID 始终保持一致。
