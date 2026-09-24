# lark-channel-bridge — 面向 Codex 与 Claude Code 的 Windows Session 远程管理扩展

[English](./README.md) | **简体中文**

> 本仓库是在上游 **`lark-channel-bridge`** 基础上维护的 Windows 增强版本，重点增加本地 **Codex CLI** 与 **Claude Code** Session 的发现与监控、Windows 与 Lark 之间的安全 ownership transfer，以及通过 Lark Mobile App / Lark Web 远程管理多个 Session 的能力。

## 上游项目 — `lark-channel-bridge`

本仓库建立在上游 **`lark-channel-bridge`** 项目之上。上游项目名称是 `lark-channel-bridge`，其 GitHub 仓库为 [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)。

上游项目提供了本 fork 所依赖的核心基础：把 **飞书/Lark** 与本地 **Claude Code 或 Codex CLI** 连接起来，并提供 Chat / Topic 独立 Session、Workspace 切换、文件与图片传递、Streaming / Interactive Card、任务排队、权限控制、Profile 和后台运行机制等能力。

关于原版 Bridge 的安装、支持的 Agent、基础配置和通用行为，请以上游文档为准：

- **上游仓库：** [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- **原版英文 README：** [Upstream `README.md`](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.md)
- **原版中文 README：** [Upstream `README.zh.md`](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.zh.md)

本 fork 在主 README 中明确保留上游来源和 README 链接，是为了说明下面这些能力均建立在 `lark-channel-bridge` 之上，而不是对原项目的替代。

## 本 fork 新增了什么

上游 bridge 已经能够让一个 Lark Chat / Group / Topic 与本地 Coding Agent 交互。本 fork 进一步增加了一个面向 Windows 的 **Session 控制层**，用于管理那些直接在 Windows Terminal 中启动、并不一定由当前 Lark scope 创建的 Codex 与 Claude Code Session。每个 bot 管理其 profile 所运行的 agent，两者使用相同的 `/session` 命令，见 [Claude Code 会话](#claude-code-会话)。

| 能力 | 上游 `lark-channel-bridge` | 本 fork 新增 |
|---|---|---|
| Lark/飞书 ↔ Claude Code / Codex Bridge | 上游核心能力 | 直接复用 |
| Chat / Topic 独立 Session | 上游核心能力 | 保留 |
| Workspace 切换与保存 | 上游核心能力 | 保留 |
| Streaming / Interactive Card | 上游核心能力 | 增加 Session 控制 Action |
| 独立从 Windows 启动的 Codex / Claude Code Session | 不是原 Lark scope 模型的主要关注点 | 自动发现与监控 |
| Windows Runtime 视图（Codex） | — | `/windows status` |
| 安全释放 Windows writer（Codex） | — | `/windows release` + Release Agent |
| 跨运行时 Session inventory | — | `/session list` |
| Detached Session → 当前 Lark scope | — | `/session use` |
| Windows → Lark ownership transfer | — | `/session handoff` |
| Lark → Windows-ready handback | — | `/session handback` |
| Session ownership 模型 | Lark scope binding | Windows / Lark / Detached + 单 writer 规则 |
| Mobile / Web 远程 Session 管理 | 通用 Lark 交互 | 针对 **Lark Mobile App** / **Lark Web** 优化 Session 切换与 ownership Action |
| Action 身份 | 随命令而定 | UI 优先显示 Thread Name；底层执行始终使用 exact full Session ID |
| Claude Code 会话 | 作为 `claude` profile 的 agent 运行 | Claude bot 上提供同一套 `/session` 控制面，见 [Claude Code 会话](#claude-code-会话) |

### 为什么增加这些能力

一个典型场景是在 Windows 工作站中直接启动多个 Codex CLI 或 Claude Code Session，然后离开电脑。新增的监控、Release 和 Ownership 层可以把这些已经存在的 Session 暴露给 Lark。Codex 的链路如下（Claude Code 自带进程登记，不需要 Observer，见 [Claude Code 会话](#claude-code-会话)）：

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

## 从 Lark 远程管理 Session

Session 命令和 UI 统一分为三层：

| 范围 | 推荐命令 | 含义 |
|---|---|---|
| Lark Scope | `/lark status`, `/lark new`, `/lark resume` | 当前 Lark Chat / Group / Topic 的 Session binding |
| Windows Runtime（仅 Codex） | `/windows status`, `/windows release` | Windows Codex TUI、Observer、Release Agent、writer |
| Global Session Manager | `/session list`, `/session use`, `/session handoff`, `/session handback` | 跨 Windows / Lark 的 Session inventory 与 ownership transfer |

Interactive Card 针对手机端操作做了进一步优化：

- `/lark status` 查看当前 Lark scope，并提供 **New Lark Session**、**Resume Lark Session**、**Workspace**、**Help** 等快捷操作。
- `/windows status` 查看 Windows Codex Sessions；可以安全 release 的 Session 会直接出现 **Release** 按钮。
- `/session list` 展示 Session Owner，并根据当前 ownership 自动出现 **Use in Lark**、**Handoff to Lark** 或 **Hand Back to Windows**。
- Lark Web / Desktop 可以通过 `hover_tips` 查看按钮补充说明；Lark Mobile 没有 hover，因此按钮文字本身保持清晰可读。

按钮只写动作和方向（**Use in Lark**、**Handoff to Lark**、**Hand Back to Windows**）：上方带编号的那一行已经标明了是哪个 Session，短标签也能让手机上一行放下两个按钮；hover 提示里会重复 Session 标题。真正执行时身份依然明确：

```text
显示身份   编号行：Thread Name（没有名称时用 short Session ID）
执行身份   始终是按钮里携带的 exact full Session ID
```

因此 Project Name 和 cwd 仍可以显示为辅助信息，但不会再作为 Action 的 Session 身份，因为同一个 Project / cwd 下可以同时存在多个不同 Session。

`/session list` 打开时显示分类标签 **Handoff / Use / Hand Back / All**，取最近 10 个 Session，默认打开第一个非空分类。每个分类下列出的，正好是会显示该操作按钮的 Session。更早的 Session 用 `/session list <关键字>` 查找。

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

还没输入过任何内容的窗口没有 transcript，会从进程登记里列出，显示为 **No conversation yet**，不可接管。`claude -p`（包括 bridge 自己在 Lark 里的运行）也会登记（`entrypoint: sdk-cli`），但永远不会被当作 Windows writer。

`/help` 会跟随 profile：在 Claude bot 上介绍的是 Claude Code 会话，不列出 `/windows`；在 Claude bot 上执行 `/windows` / `/local-status` / `/local-release` 会提示它们只适用于 Codex bot，并引导到 `/session list` / `/session handoff`。

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
codex3                       # 新会话
codex3 resume <Session-ID>   # 或只属于一个会话的 thread 名称
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
Detached → Use in Lark
Windows  → Handoff to Lark
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

Claude Code 的流程相同，在 Claude bot 的群里进行：在 Windows 上启动 `claude`，然后用 `/session list` / `/session handoff`（没有 `/windows` 这一步）。handback 之后在 Windows 上这样续接：

```powershell
claude --resume <Session-ID>
```

## Ownership model

```text
同一个 Session（Codex 或 Claude Code）
       │
       ├── Windows writer
       ├── Lark scope
       └── Detached / 未绑定

任意时刻只允许一个逻辑 writer。
```

UI 可以用 Thread Name 提升可读性，但所有 release / use / handoff 等真正改变 ownership 的操作，底层始终使用 **完整 Session ID**。

把会话绑定到 Lark scope（Use / Handoff）时，bridge 会同时写入 session catalog 和 `sessions.json`，因为下一条 Lark 消息是从 catalog 续接的；Hand Back 会归档 catalog 条目，让 Lark 不再续接它。

## 交接时会带上什么

| 交接 | 是否显示 Last Response | 原因 |
|---|---|---|
| Windows → Lark（**Handoff to Lark**） | 是——结果卡片上的「Last Windows Response」 | 让你看到 Windows 上的对话停在哪里 |
| Detached → Lark（**Use in Lark**） | 是——结果卡片上的「Last Response」 | Detached 的会话通常最后是在 Windows 上用的 |
| Lark → Windows（**Hand Back to Windows**） | 不需要 | Lark 里的对话也在同一台 Windows 上执行，写进同一个 rollout / transcript，`codex3 resume` / `claude --resume` 本来就能看到 |

Last Response 只是给人看的。模型任何方向都不需要额外携带：续接的会话会从 rollout / transcript 读取完整历史。

## Handoff 状态：含义与处理方式

`/session list` 卡片会为 Windows 上运行的会话显示一行 **Handoff** 状态。标为「不可接管」的状态不提供 Handoff 按钮，`/session handoff` 也会给出同样的说明并拒绝。

| 状态 | Agent | 含义 | 处理方式 |
|---|---|---|---|
| 🟢 Ready | 两者 | Windows 上的 writer 空闲，且身份已完全确认 | **Handoff to Lark** |
| 🔵 Busy · … | 两者 | Windows 上的 writer 正在工作 | 等它空闲 |
| ⚪ Detached | 两者 | 没有 Windows writer，也没有 Lark 持有者 | **Use in Lark** |
| 🟡 Observer heartbeat stale | Codex | Observer 超过 30 秒没有报告 | 通常会自行恢复；仍提供 Handoff，释放链会重新校验 |
| 🟡 Launch mapping unavailable（不可接管） | Codex | 这个 Codex 没有经过 `codex3` 的 attach（在 attach 机制出现之前启动、手动启动，或 attach 没有完成），没有 Release Agent | 在 Windows 上退出它，再 **Use in Lark**；以后用 `codex3` / `codex3 resume` 打开。手动启动的 Observer 不会随之退出，需要一并结束 |
| 🟡 Release Agent not recorded（不可接管） | Codex | 原因相同：没有进程能释放这个 writer | 同上 |
| 🟡 Codex exited; stale Observer (pid N)（不可接管） | Codex | `codex3` 终端被直接关闭，清理步骤没有运行，Observer 比 Codex 活得久 | `Stop-Process N`（如果 `codex3` 是在管理员终端里运行的，要在管理员 PowerShell 中执行），之后会话变为 Detached。当前版本脚本启动的 Observer 会自行退出 |
| 🟡 Running as administrator — Claude release agent not running（不可接管） | Claude | 管理员权限的窗口，普通权限的 bridge 无法释放 | 注册 Claude Release Agent（见[下文](#普通与管理员-powershell)），或在 Windows 上退出后 **Use in Lark** |
| 🟡 No conversation yet（不可接管） | Claude | 窗口开着但还没输入过任何内容 | 没有可续接的内容，直接在 Lark 里和 bot 对话即可 |
| 🟡 Open in *client* — close it there（不可接管） | Claude | 运行在 IDE 或其他客户端中，而不是终端 | 在那里关闭，再 **Use in Lark** |
| 🟡 Unknown status / Process identity unavailable（不可接管） | Claude | 无法确认可以安全终止 | 在 Windows 上退出它，再 **Use in Lark** |

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

`codex3` 如何识别会话：

- `codex3`（新会话）：以它在当前目录写出的第一个 rollout 来识别。
- `codex3 resume <Session-ID>` 和 `codex3 resume <thread 名称>`：**直接从命令行识别**，不需要先输入任何内容。只有当这个名称只属于一个会话时才会使用它；多个会话同名、`resume --last` 或交互式选择器都会退回到「等第一次写入」的方式，想确保立即识别就用 Session ID。
- Observer 会在它的 Codex 退出后自行结束（即使终端是直接关掉的），并删除这次启动的 mapping 和 claim。

Attach 日志在 `%USERPROFILE%\.codex-monitor\logs\attach-<launch-id>.log`，出现 `Resume target from command line` 表示已立即识别。

## 普通与管理员 PowerShell

bridge 本身始终以 **LIMITED**（普通权限）计划任务运行——`lark-channel-bridge start` 只是启动这个任务，所以从管理员终端启动它也不会提升权限。Windows 不允许普通进程检查或终止管理员进程，这正是两个 Release Agent 存在的原因。

| 操作 | 在哪里执行 | 说明 |
|---|---|---|
| `.\scripts\windows\Register-ClaudeReleaseAgent.ps1`（及 `-Unregister`） | **管理员 PowerShell**，否则脚本会拒绝执行 | 只需一次。注册 `/RL HIGHEST` 的登录计划任务 `\LarkChannelBridge.ClaudeReleaseAgent` 并立即启动。只有在管理员终端里启动 Claude 时才需要 |
| 结束遗留 Observer：`Stop-Process <pid>` | 如果 `codex3` 是以管理员身份运行的，需要**管理员 PowerShell** | 管理员进程只能从管理员 shell 结束 |
| `codex3`、`codex3 resume …` | 都可以 | 以管理员身份运行时，它的 Observer 和 Release Agent 也是管理员权限，Codex 的 handoff 照样可用——终止动作由它自己的 Release Agent 完成 |
| `claude` | 都可以 | 管理员窗口的 handoff 需要 Claude Release Agent；普通终端里的窗口不需要 |
| `.\scripts\windows\Install-CodexBridgeScripts.ps1` | 都可以 | 把脚本复制到 `%USERPROFILE%\Scripts` |
| `lark-channel-bridge start / stop / status` | 都可以 | bridge 总是以普通权限运行 |
| `pnpm install / test / build`、`npm install -g .` | 普通 | — |

在管理员 shell 中，`whoami /groups | findstr "Mandatory Label"` 会显示 `High Mandatory Level`。

## Build and install

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
npm install -g .
.\scripts\windows\Install-CodexBridgeScripts.ps1

# 如果以管理员身份启动 Claude，在管理员 PowerShell 中执行一次：
.\scripts\windows\Register-ClaudeReleaseAgent.ps1

# 重启正在使用的每个 profile：
lark-channel-bridge stop --profile codex
lark-channel-bridge start --profile codex
lark-channel-bridge stop --profile claude
lark-channel-bridge start --profile claude
```

不要使用 `npm install -g lark-channel-bridge@latest` 覆盖本地增强版，否则本地 Session 管理功能会被上游 registry 包替换。

更新 `scripts/windows/` 之后要重新运行 `Install-CodexBridgeScripts.ps1`：`codex3` 和两个 Release Agent 运行的是 `%USERPROFILE%\Scripts` 里安装的副本，已经在运行的 Observer 会继续使用它启动时的版本。

测试在 UTC 时区下运行（`vitest.config.ts`），因为部分测试把时钟固定在 UTC 午夜，而日志文件按本地日期命名。

## 已知限制

- **话题（thread）里的卡片按钮。** 在群里，话题内输入的命令属于该话题的 Lark scope，但在话题里点击的卡片按钮会解析为群的主聊天 scope。因此通过按钮完成的 handoff / use 会绑定到主聊天区。在话题里建议直接输入命令，或在主聊天区使用按钮。
- **没有经过 `codex3` attach 的 Codex 会话**（在 attach 机制出现之前启动或手动启动）无法 handoff；请在 Windows 上退出后用 **Use in Lark**。
- **Handoff 会终止 Windows 上的窗口。** 对话完整保存在磁盘上，但终端输入框里未发送的草稿会丢失。Claude 被强制退出后，终端在切换焦点时可能打印 `[I[` 之类的转义序列，关闭该标签页即可。
- **一个 bot 只对应一种 agent。** 一个 profile 只运行 Codex 或 Claude Code，另一种请用它自己的 bot 管理。

## 文档

- [本地文档索引](./local-docs/README.zh-CN.md)
- [Codex 第三方 API Provider](./local-docs/01-codex-third-party-api-key.zh-CN.md)
- [Lark / bridge / Codex / Claude Code 架构](./local-docs/02-lark-bridge-codex-architecture.zh-CN.md)
- [Codex / Claude Code Session 管理](./local-docs/03-codex-session-management.zh-CN.md)

## 上游与致谢

本项目扩展自 **`lark-channel-bridge`**，基础架构与运行机制来自上游项目。

- [上游仓库](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- [上游英文 README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.md)
- [上游中文 README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.zh.md)

关于基础安装、支持的 Agent、上游命令、飞书/Lark App 配置和通用 Bridge 行为，请以上游 README 为准。本仓库文档重点记录新增的 Windows Codex 监控、远程 Session 控制、安全 release、handoff/handback 和跨运行时 ownership 能力。
