# lark-channel-bridge — Local Codex Session Handoff Extension

[English](./README.md) | **简体中文**

> 本仓库是在上游 `lark-channel-bridge` 基础上维护的 Windows 本地增强版本，重点解决 **Codex CLI Session 的远程监控、安全 handoff / handback、多 Session ownership 管理，以及通过 Lark/飞书进行远程操作**。

本次增强的重点之一，是让这些 Session 操作在 **Lark Mobile App** 和 **Lark Web** 中都更容易完成。通过 Interactive Card，可以直接查看当前 Lark binding、Windows runtime Session 以及全局 Codex Session inventory，并通过按钮完成常见远程操作，不必在手机上反复输入较长的 Session ID，也不需要为了切换 Session 专门连接远程桌面。

## 从 Lark 远程管理 Codex Session

Session 命令和 UI 统一分为三层：

| 范围 | 推荐命令 | 含义 |
|---|---|---|
| Lark Scope | `/lark status`, `/lark new`, `/lark resume` | 当前 Lark Chat / Group / Topic 的 Session binding |
| Windows Runtime | `/windows status`, `/windows release` | Windows Codex TUI、Observer、Release Agent、writer |
| Global Session Manager | `/session list`, `/session use`, `/session handoff`, `/session handback` | 跨 Windows / Lark 的 Session inventory 与 ownership transfer |

Interactive Card 针对手机端操作做了进一步优化：

- `/lark status` 查看当前 Lark scope，并提供 **New Lark Session**、**Resume Lark Session**、**Workspace**、**Help** 等快捷操作。
- `/windows status` 查看 Windows Codex Sessions；可以安全 release 的 Session 会直接出现 **Release** 按钮。
- `/session list` 展示 Session Owner，并根据当前 ownership 自动出现 **Use in this Lark**、**Handoff to this Lark** 或 **Hand Back to Windows**。
- Lark Web / Desktop 可以通过 `hover_tips` 查看按钮补充说明；Lark Mobile 没有 hover，因此按钮文字本身保持清晰可读。

Action 的显示与真正执行使用两套身份规则：

```text
显示给用户
Thread Name
→ 如果 Thread Name 重名：Thread Name + short Session ID
→ 如果没有 Thread Name：short Session ID

真正执行
始终使用 exact full Session ID
```

因此 Project Name 和 cwd 仍可以显示为辅助信息，但不会再作为 Action 的 Session 身份，因为同一个 Project / cwd 下可以同时存在多个不同 Session。

### Screenshots

<table>
<tr>
<td align="center"><strong>Lark Scope</strong></td>
<td align="center"><strong>Windows Runtime</strong></td>
<td align="center"><strong>All Codex Sessions</strong></td>
</tr>
<tr>
<td><img src="./screenshots/lark-session-status.png" alt="Lark Session Status" width="100%"></td>
<td><img src="./screenshots/windows-codex-sessions.png" alt="Windows Codex Sessions" width="100%"></td>
<td><img src="./screenshots/all-codex-sessions.png" alt="All Codex Sessions" width="100%"></td>
</tr>
</table>

这样可以直接在手机 Lark 或 Lark Web 中查看 Session、释放 Windows writer、把 Windows Session handoff 到当前 Lark、接管 Detached Session，或者再 handback 给 Windows，同时保持明确的单 Writer 语义。

## 兼容旧命令

旧命令目前继续作为 alias：

```text
/status            → /lark status
/new               → /lark new
/resume            → /lark resume

/local-status      → /windows status
/local-release     → /windows release

/sessions          → /session list
/use               → /session use
/local-handoff     → /session handoff
/handback          → /session handback
```

## 典型工作流

Windows 中启动 Codex：

```powershell
cd E:\AI_Tools\codex\AcuPilot
codex3
```

在 Lark 中查看 Windows runtime：

```text
/windows status
```

如果某个 Windows Session 已经处于 `Waiting`，可以直接点该 Session 的 **Release** 按钮，仅释放 Windows writer；如果希望直接把它转交给当前 Lark scope，则使用：

```text
/session handoff <Thread名称或Session-ID前缀>
```

也可以打开全局 inventory：

```text
/session list
```

并直接使用卡片中根据 ownership 自动出现的 Action：

```text
Detached → Use in this Lark
Windows  → Handoff to this Lark
Current Lark → Hand Back to Windows
```

需要回到 Windows 时：

```text
/session handback
```

Bridge 解除当前 Lark binding 后会返回类似：

```powershell
codex3 resume <Session-ID>
```

在 Windows 中执行即可继续同一个 Codex Session。

## Ownership model

```text
同一个 Codex Session
       │
       ├── Windows writer
       ├── Lark scope
       └── Detached / 未绑定

任意时刻只允许一个逻辑 writer。
```

UI 可以用 Thread Name 提升可读性，但所有 release / use / handoff 等真正改变 ownership 的操作，底层始终使用 **完整 Session ID**。

## Windows monitoring layer

```text
scripts/windows/
├─ Attach-CodexObserver.ps1
├─ Watch-CodexSession.ps1
├─ Watch-CodexRelease.ps1
├─ Request-CodexRelease.ps1
├─ Release-CodexSession.ps1
├─ Stop-CodexObserver.ps1
└─ Install-CodexBridgeScripts.ps1
```

运行时数据位于：

```text
%USERPROFILE%\.codex-monitor\
```

## Build and install

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
npm install -g .
.\scripts\windows\Install-CodexBridgeScripts.ps1

lark-channel-bridge stop --profile codex
lark-channel-bridge start --profile codex
```

不要使用 `npm install -g lark-channel-bridge@latest` 覆盖本地增强版，否则本地 Session 管理功能会被上游 registry 包替换。

## 文档

- [本地文档索引](./local-docs/README.zh-CN.md)
- [Codex 第三方 API Provider](./local-docs/01-codex-third-party-api-key.zh-CN.md)
- [Lark / Bridge / Codex 架构](./local-docs/02-lark-bridge-codex-architecture.zh-CN.md)
- [Codex Session 管理](./local-docs/03-codex-session-management.zh-CN.md)

## 上游

基于 `zarazhangrui/lark-coding-agent-bridge`。
