# lark-channel-bridge — Windows Codex Session 远程管理扩展

[English](./README.md) | **简体中文**

> 本仓库是在上游 **`lark-channel-bridge`** 基础上维护的 Windows / Codex 增强版本，重点增加本地 Codex CLI Session 的发现与监控、Windows 与 Lark 之间的安全 ownership transfer，以及通过 Lark Mobile App / Lark Web 远程管理多个 Codex Session 的能力。

## 上游项目 — `lark-channel-bridge`

本仓库建立在上游 **`lark-channel-bridge`** 项目之上。上游项目名称是 `lark-channel-bridge`，其 GitHub 仓库为 [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)。

上游项目提供了本 fork 所依赖的核心基础：把 **飞书/Lark** 与本地 **Claude Code 或 Codex CLI** 连接起来，并提供 Chat / Topic 独立 Session、Workspace 切换、文件与图片传递、Streaming / Interactive Card、任务排队、权限控制、Profile 和后台运行机制等能力。

关于原版 Bridge 的安装、支持的 Agent、基础配置和通用行为，请以上游文档为准：

- **上游仓库：** [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- **原版英文 README：** [Upstream `README.md`](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.md)
- **原版中文 README：** [Upstream `README.zh.md`](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.zh.md)

本 fork 在主 README 中明确保留上游来源和 README 链接，是为了说明下面这些能力均建立在 `lark-channel-bridge` 之上，而不是对原项目的替代。

## 本 fork 新增了什么

上游 bridge 已经能够让一个 Lark Chat / Group / Topic 与本地 Coding Agent 交互。本 fork 进一步增加了一个面向 Windows 的 **Codex Session 控制层**，用于管理那些直接在 Windows Terminal 中启动、并不一定由当前 Lark scope 创建的 Codex Session。

| 能力 | 上游 `lark-channel-bridge` | 本 fork 新增 |
|---|---|---|
| Lark/飞书 ↔ Claude Code / Codex Bridge | 上游核心能力 | 直接复用 |
| Chat / Topic 独立 Session | 上游核心能力 | 保留 |
| Workspace 切换与保存 | 上游核心能力 | 保留 |
| Streaming / Interactive Card | 上游核心能力 | 增加 Session 控制 Action |
| 独立从 Windows 启动的 Codex Session | 不是原 Lark scope 模型的主要关注点 | 自动发现与监控 |
| Windows Runtime 视图 | — | `/windows status` |
| 安全释放 Windows writer | — | `/windows release` + Release Agent |
| 跨运行时 Session inventory | — | `/session list` |
| Detached Session → 当前 Lark scope | — | `/session use` |
| Windows → Lark ownership transfer | — | `/session handoff` |
| Lark → Windows-ready handback | — | `/session handback` |
| Session ownership 模型 | Lark scope binding | Windows / Lark / Detached + 单 writer 规则 |
| Mobile / Web 远程 Session 管理 | 通用 Lark 交互 | 针对 **Lark Mobile App** / **Lark Web** 优化 Session 切换与 ownership Action |
| Action 身份 | 随命令而定 | UI 优先显示 Thread Name；底层执行始终使用 exact full Session ID |
| Claude Code 会话 | 作为 `claude` profile 的 agent 运行 | Claude bot 上提供同一套 `/session` 控制面，见 [Claude Code 会话](#claude-code-会话) |

### 为什么增加这些能力

一个典型场景是在 Windows 工作站中直接启动多个 Codex CLI Session，然后离开电脑。新增的 Observer、Monitor、Release 和 Ownership 层可以把这些已经存在的 Session 暴露给 Lark：

```text
Windows Terminal / codex3
        │
        ├─ Session A
        ├─ Session B
        └─ Session C
             │
             ▼
      Windows Observer layer
             │
             ▼
        .codex-monitor
             │
             ▼
      lark-channel-bridge
             │
             ▼
      Lark Mobile / Lark Web
```

这样无需连接 Remote Desktop，就可以从 Lark 查看 Windows Session、release Waiting 状态的 Windows writer、把 Session handoff 到当前 Lark scope、接管 Detached Session，并在之后 handback 给 Windows。

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

`/session list` 打开时显示分类标签 **Handoff / Use / Hand Back / All**，取最近 10 个 Session，默认打开第一个非空分类。每个分类下列出的，正好是会显示该操作按钮的 Session。更早的 Session 用 `/session list <关键字>` 查找。

## Claude Code 会话

一个 profile 只运行一种 agent（`agentKind` 为 `codex` 或 `claude`），所以所有 `/session` 命令都作用于**这个 profile 的 agent**。Codex bot 和 Claude bot 上的命令完全相同，不需要任何 agent 参数：

```text
/session list [handoff|use|handback|all|keyword]
/session use <selector>
/session handoff <selector>
/session handback
/session tail [selector]
```

要同时管理两种会话，就每种各用一个 bot：分别建群，或把两个 bot 放进同一个群。旧写法里的 `codex` / `claude` 仍被接受但会被忽略，已发出的旧卡片按钮不会失效。

判断运行状态不需要 Observer：Claude Code 自己维护了一份运行中进程的登记（释放管理员窗口是另一回事，见下文）。

| 数据 | 来源 |
|---|---|
| 会话列表、更新时间 | `~/.claude/projects/*/<sessionId>.jsonl` |
| 工作目录 | transcript 里记录的 `cwd`（项目目录名的编码有损，无法反解） |
| 标题 | `custom-title.json` → 最新的 `ai-title` → 第一条输入 |
| Windows 上是否在运行 | `~/.claude/sessions/<pid>.json`：`status` 为 `idle / busy`；终端窗口的 `entrypoint` 为 `cli` |

还没输入过任何内容的窗口没有 transcript，会从进程登记里列出，显示为 **No conversation yet**，不可接管。

### Handoff 与 Claude Release Agent

Handoff 会终止 Windows 上空闲的 `claude.exe`（对话都在磁盘上，只会丢失输入框里未发送的草稿），然后把会话绑定到当前 Lark scope。`Request-ClaudeRelease.ps1` 只有在确认这是**唯一一个、空闲的终端窗口**，且进程创建时间与登记的 `procStart` 一致时才会动手。

bridge 以 **LIMITED**（普通权限）计划任务运行，而 Windows 不允许普通进程检查或终止管理员进程。如果你在**管理员 PowerShell** 里启动 Claude，handoff 就需要以管理员权限运行的 **Claude Release Agent**：

```text
bridge（普通权限）        → ~/.claude-monitor/requests/release-<id>.json
Release Agent（管理员权限）→ 校验、终止，写入 results/release-<id>.json
```

Codex 不需要这一步，是因为 `codex3` 在它所在的管理员终端里启动了自己的 Release Agent。Claude 是直接启动的，所以需要在管理员 PowerShell 里注册一次代理，之后每次登录都会以管理员权限自动启动，不弹 UAC：

```powershell
.\scripts\windows\Register-ClaudeReleaseAgent.ps1
# 取消注册：
.\scripts\windows\Register-ClaudeReleaseAgent.ps1 -Unregister
```

没有代理时，管理员权限的 Claude 窗口会显示 **Running as administrator — Claude release agent not running**，不提供 Handoff 按钮。从普通终端启动的 Claude 窗口不需要代理也能接管。

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
├─ Request-ClaudeRelease.ps1        Claude：校验并释放一个空闲窗口
├─ Watch-ClaudeRelease.ps1          Claude：管理员权限的 Release Agent
├─ Register-ClaudeReleaseAgent.ps1  Claude：登录时以管理员权限启动代理
└─ Install-CodexBridgeScripts.ps1
```

运行时数据位于：

```text
%USERPROFILE%\.codex-monitor\    Codex
%USERPROFILE%\.claude-monitor\   Claude Release Agent 的请求 / 结果 / 心跳
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

## 上游与致谢

本项目扩展自 **`lark-channel-bridge`**，基础架构与运行机制来自上游项目。

- [上游仓库](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- [上游英文 README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.md)
- [上游中文 README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.zh.md)

关于基础安装、支持的 Agent、上游命令、飞书/Lark App 配置和通用 Bridge 行为，请以上游 README 为准。本仓库文档重点记录新增的 Windows Codex 监控、远程 Session 控制、安全 release、handoff/handback 和跨运行时 ownership 能力。
