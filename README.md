# lark-channel-bridge — Windows Session Remote Management Extension for Codex and Claude Code

**English** | [简体中文](./README.zh-CN.md)

> A Windows-focused downstream extension of **`lark-channel-bridge`** for discovering and monitoring local **Codex CLI** and **Claude Code** sessions, safely transferring session ownership between Windows and Lark, and remotely managing multiple sessions from Lark Mobile App or Lark Web.

## Upstream project — `lark-channel-bridge`

This repository is built on top of the upstream **`lark-channel-bridge`** project. The upstream project name is `lark-channel-bridge`; its GitHub repository is [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge).

The upstream project provides the foundation used by this fork: a local bridge between **Feishu/Lark** and **Claude Code or Codex CLI**, with per-chat/topic session continuity, workspace switching, file/image forwarding, streaming/interactive cards, queueing, access controls, profiles, and background runtime management.

Please treat the upstream documentation as the authoritative reference for the original bridge behavior, installation, supported agents, and general configuration:

- **Upstream repository:** [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- **Original English README:** [Upstream `README.md`](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.md)
- **Original Chinese README:** [Upstream `README.zh.md`](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.zh.md)

This fork intentionally keeps the upstream project prominent in the documentation. The features below are **extensions built on top of `lark-channel-bridge`**, not a replacement for the original project.

## What this fork adds

The upstream bridge already lets a Lark Chat / Group / Topic interact with a local coding agent. This fork adds a Windows-focused **Session control plane** for Codex and Claude Code sessions that may have been started independently in Windows Terminal rather than created only through the current Lark scope. Each bot manages the agent its profile runs, with the same `/session` commands for both — see [Claude Code sessions](#claude-code-sessions).

| Area | Upstream `lark-channel-bridge` | This fork adds |
|---|---|---|
| Lark/Feishu ↔ Claude Code / Codex bridge | Core upstream feature | Reused as the foundation |
| Per-chat/topic session continuity | Core upstream feature | Preserved |
| Workspace switching and saved workspaces | Core upstream feature | Preserved |
| Streaming and interactive cards | Core upstream feature | Extended with session-control actions |
| Windows Codex / Claude Code sessions started independently of Lark | Not the focus of the original Lark scope model | Automatic local discovery and monitoring |
| Windows runtime view (Codex) | — | `/windows status` |
| Safe Windows writer release (Codex) | — | `/windows release` with Release Agent |
| Cross-runtime session inventory | — | `/session list` |
| Detached Session → current Lark scope | — | `/session use` |
| Windows → Lark ownership transfer | — | `/session handoff` |
| Lark → Windows-ready handback | — | `/session handback` |
| Session ownership model | Lark scope binding | Windows / Lark / Detached with a single-writer rule |
| Mobile/Web remote session control | General Lark interaction | Session switching and ownership actions optimized for **Lark Mobile App** and **Lark Web** |
| Action identity | Command-specific | Readable Thread Name in UI; exact full Session ID for execution |
| Claude Code sessions | Run as the agent of a `claude` profile | The same `/session` control plane on a Claude bot — see [Claude Code sessions](#claude-code-sessions) |

### Why these extensions exist

A common workflow is to start several Codex CLI or Claude Code sessions directly on a Windows workstation and later leave the computer. The additional monitoring, release, and ownership layers let Lark become a remote control surface for those existing sessions. For Codex the path looks like this (Claude Code needs no Observer — it keeps its own process registry; see [Claude Code sessions](#claude-code-sessions)):

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

From Lark you can inspect Windows sessions, safely release a waiting Windows writer, hand a session to the current Lark scope, use a detached session, and hand the current Lark-owned session back to Windows without requiring Remote Desktop.

## Remote session management from Lark

The UI follows the same three-layer model as the command set:

| Scope | Recommended commands | Meaning |
|---|---|---|
| Lark Scope | `/lark status`, `/lark new`, `/lark resume` | Current Lark Chat / Group / Topic binding |
| Windows Runtime (Codex only) | `/windows status`, `/windows release` | Windows Codex TUI, Observer, Release Agent, writer |
| Global Session Manager | `/session list`, `/session use`, `/session handoff`, `/session handback` | Cross-runtime inventory and ownership transfer |

The interactive cards are especially useful on a phone:

- `/lark status` shows the current Lark scope and provides quick actions such as **New Lark Session**, **Resume Lark Session**, **Workspace**, and **Help**.
- `/windows status` shows Windows Codex sessions and adds a **Release** action for sessions that are safe to release.
- `/session list` shows session ownership and exposes context-aware actions: **Use in Lark**, **Handoff to Lark**, or **Hand Back to Windows**.
- Lark Web/Desktop can additionally show button `hover_tips`; Lark Mobile relies on the button labels themselves.

Buttons name only the action and its direction (**Use in Lark**, **Handoff to Lark**, **Hand Back to Windows**): the numbered row above them already identifies the Session, and short labels keep two buttons per line on a phone. The hover tip repeats the Session title. Execution stays unambiguous:

```text
Display identity   the numbered row: Thread Name (short Session ID when unnamed)
Execution identity ALWAYS the exact full Session ID carried in the button payload
```

Project names and working directories are shown as metadata, but are **not** used as the identity of an action because several sessions can share the same project or cwd.

`/session list` opens on category tabs — **Handoff**, **Use**, **Hand Back**, **All** — drawn from the 10 most recent Sessions, defaulting to the first category that has a Session in it. Each tab lists exactly the Sessions that render that action's button. Use `/session list <keyword>` to find an older Session.

### Screenshots

<table>
<tr>
<td align="center"><strong>Lark scope</strong></td>
<td align="center"><strong>Windows runtime</strong></td>
<td align="center"><strong>All Codex sessions</strong></td>
</tr>
<tr>
<td><img src="./screenshots/lark-session-status.png" alt="Lark Session Status" width="100%"></td>
<td><img src="./screenshots/windows-codex-sessions.png" alt="Windows Codex Sessions" width="100%"></td>
<td><img src="./screenshots/all-codex-sessions.png" alt="All Codex Sessions" width="100%"></td>
</tr>
</table>

This makes it possible to inspect and switch session ownership remotely from Lark Mobile or Lark Web while keeping the Windows/Lark single-writer rule explicit.

## Claude Code sessions

A profile runs exactly one agent (`agentKind` is `codex` or `claude`), so every `/session` command works on **that profile's agent**. The commands are identical on a Codex bot and a Claude bot — there is no agent parameter:

```text
/session list [handoff|use|handback|all|keyword]
/session use <selector>
/session handoff <selector>
/session handback
/session tail [selector]
```

To manage both kinds of Session, run one bot per profile — in separate groups, or both bots in the same group. The legacy words `codex` / `claude` are still accepted and ignored, so older card buttons keep working.

Claude Code needs no Observer to track status: it keeps its own live-process registry. (Releasing an elevated window is a separate matter — see below.)

| Data | Source |
|---|---|
| Sessions, updated time | `~/.claude/projects/*/<sessionId>.jsonl` |
| Working directory | the `cwd` recorded inside the transcript (the project directory name is a lossy encoding) |
| Title | `custom-title.json` → latest `ai-title` → first prompt |
| Running on Windows | `~/.claude/sessions/<pid>.json` — `status: idle / busy`, `entrypoint: cli` for a terminal window |

A window that has not been sent anything yet has no transcript; it is listed from the registry as **No conversation yet** and cannot be handed off. `claude -p` runs — including the bridge's own Lark runs — register too (as `entrypoint: sdk-cli`) and are never treated as Windows writers.

`/help` follows the profile: on a Claude bot it describes Claude Code sessions and omits `/windows`, and `/windows` / `/local-status` / `/local-release` reply that they apply to Codex bots only, pointing to `/session list` / `/session handoff`.

### Handoff and the Claude Release Agent

Handoff terminates the idle Windows `claude.exe` (the conversation is on disk, so nothing is lost but an unsent draft) and binds the Session to the current Lark scope. `Request-ClaudeRelease.ps1` refuses unless the writer is a single idle terminal window whose process creation time matches the registry's `procStart`.

The bridge runs as a **LIMITED** scheduled task, and Windows does not let a non-elevated process inspect or terminate an elevated one. If you start Claude from an **elevated (Run as administrator) PowerShell**, handoff needs the elevated **Claude Release Agent**:

```text
bridge (LIMITED)  → ~/.claude-monitor/requests/release-<id>.json
Release Agent (elevated) → validates, terminates, writes results/release-<id>.json
```

Codex does not need this step because `codex3` starts its Release Agent from the elevated terminal it runs in. Claude is launched directly, so register the agent once from an elevated PowerShell — it then starts elevated at every logon, with no UAC prompt:

```powershell
.\scripts\windows\Register-ClaudeReleaseAgent.ps1
# remove it again:
.\scripts\windows\Register-ClaudeReleaseAgent.ps1 -Unregister
```

Without the agent, elevated Claude windows are shown as **Running as administrator — Claude release agent not running** and offer no Handoff button. Claude windows started from a normal terminal can be handed off without it.

## Compatibility aliases

Legacy commands remain available as compatibility aliases:

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

## Typical workflow

Start Codex on Windows:

```powershell
cd E:\AI_Tools\codex\AcuPilot
codex3                       # new session
codex3 resume <Session-ID>   # or a thread name that only one session uses
```

Inspect Windows sessions from Lark:

```text
/windows status
```

For a waiting Windows session, either tap its **Release** button when you only want to release the Windows writer, or transfer ownership directly to the current Lark scope:

```text
/session handoff <thread-name-or-session-prefix>
```

You can also open the global inventory:

```text
/session list
```

and use the context-aware card buttons to switch a detached session into the current Lark scope, hand off a Windows session, or hand the current Lark-owned session back.

Return the current Lark session to Windows-ready state:

```text
/session handback
```

Then resume it on Windows with the command returned by the bridge:

```powershell
codex3 resume <Session-ID>
```

With Claude Code the flow is the same, in the Claude bot's group: start `claude` on Windows, then use `/session list` / `/session handoff` (there is no `/windows` step), and resume on Windows after a handback with:

```powershell
claude --resume <Session-ID>
```

## Ownership model

```text
One Session (Codex or Claude Code)
       │
       ├── Windows writer
       ├── Lark scope
       └── Detached / unbound

Only one logical writer should own the session at a time.
```

The UI can use a Thread Name for readability, but all destructive or ownership-changing actions target the **full Session ID** internally.

Binding a session to a Lark scope (Use / Handoff) writes the bridge's session catalog as well as `sessions.json`, because that catalog is what the next Lark message resumes from; Hand Back archives the catalog entry so Lark stops resuming it.

## What a transfer carries

| Transfer | Shows the Last Response? | Why |
|---|---|---|
| Windows → Lark (**Handoff to Lark**) | Yes — "Last Windows Response" on the result card | Where the Windows conversation left off |
| Detached → Lark (**Use in Lark**) | Yes — "Last Response" on the result card | A Detached session was usually last used on Windows |
| Lark → Windows (**Hand Back to Windows**) | Not needed | Lark turns run on the same Windows machine and are written to the same rollout / transcript, so `codex3 resume` / `claude --resume` already shows them |

The Last Response is shown to the person only. The model never needs it carried over: a resumed session reads its full history from the rollout / transcript in either direction.

## Handoff states — what they mean and what to do

The `/session list` card shows a **Handoff** line for sessions running on Windows. A state marked *not transferable* gets no Handoff button, and `/session handoff` refuses it with the same explanation.

| State | Agent | Meaning | What to do |
|---|---|---|---|
| 🟢 Ready | both | Idle Windows writer, fully identified | **Handoff to Lark** |
| 🔵 Busy · … | both | The Windows writer is working | Wait until it is idle |
| ⚪ Detached | both | No Windows writer and no Lark owner | **Use in Lark** |
| 🟡 Observer heartbeat stale | Codex | The Observer has not reported for over 30 s | Usually recovers; Handoff is still offered and the release chain re-validates |
| 🟡 Launch mapping unavailable *(not transferable)* | Codex | This Codex was never attached by `codex3` (started before the attach mechanism, by hand, or the attach did not finish), so it has no Release Agent | Exit it on Windows, then **Use in Lark**; open sessions with `codex3` / `codex3 resume` from now on. A hand-started Observer keeps running and must be stopped too |
| 🟡 Release Agent not recorded *(not transferable)* | Codex | Same cause: nothing can release this writer | Same as above |
| 🟡 Codex exited; stale Observer (pid N) *(not transferable)* | Codex | The `codex3` terminal was closed without its cleanup and its Observer outlived Codex | `Stop-Process N` (in an administrator PowerShell if `codex3` ran elevated); the session then becomes Detached. Observers started by the current scripts exit on their own |
| 🟡 Running as administrator — Claude release agent not running *(not transferable)* | Claude | Elevated window; the non-elevated bridge cannot release it | Register the Claude Release Agent ([below](#normal-vs-administrator-powershell)), or exit it on Windows and **Use in Lark** |
| 🟡 No conversation yet *(not transferable)* | Claude | Open window that has not been sent anything | Nothing to resume — just talk to the bot in Lark |
| 🟡 Open in *client* — close it there *(not transferable)* | Claude | Running in an IDE or other client, not a terminal | Close it there, then **Use in Lark** |
| 🟡 Unknown status / Process identity unavailable *(not transferable)* | Claude | Cannot confirm it is safe to terminate | Exit it on Windows, then **Use in Lark** |

## Windows monitoring layer

```text
scripts/windows/
├─ Attach-CodexObserver.ps1
├─ Watch-CodexSession.ps1
├─ Watch-CodexRelease.ps1
├─ Request-CodexRelease.ps1
├─ Release-CodexSession.ps1
├─ Stop-CodexObserver.ps1
├─ Request-ClaudeRelease.ps1        Claude: validate and release one idle window
├─ Watch-ClaudeRelease.ps1          Claude: elevated Release Agent
├─ Register-ClaudeReleaseAgent.ps1  Claude: run the agent elevated at logon
└─ Install-CodexBridgeScripts.ps1
```

Runtime data is stored under:

```text
%USERPROFILE%\.codex-monitor\    Codex
%USERPROFILE%\.claude-monitor\   Claude Release Agent requests / results / heartbeat
```

How `codex3` attaches a session:

- `codex3` (a new session) is identified by the first rollout it writes in the current directory.
- `codex3 resume <Session-ID>` and `codex3 resume <thread name>` are identified **immediately** from the command line — before anything is typed. A thread name is used only when exactly one session carries it; a name shared by several sessions, `resume --last`, or the interactive picker falls back to the first-write matching, so use the Session ID to be certain.
- The Observer exits by itself when its Codex exits, even if the terminal was closed with the X button, and removes that launch's mapping and claim.

Attach logs are in `%USERPROFILE%\.codex-monitor\logs\attach-<launch-id>.log`; `Resume target from command line` confirms an immediate match.

## Normal vs. administrator PowerShell

The bridge itself always runs as a **LIMITED** (non-elevated) scheduled task — `lark-channel-bridge start` only runs that task, so starting it from an administrator terminal does not elevate it. Windows does not let a non-elevated process inspect or terminate an elevated one, which is what the release agents are for.

| Task | Where to run it | Notes |
|---|---|---|
| `.\scripts\windows\Register-ClaudeReleaseAgent.ps1` (and `-Unregister`) | **Administrator PowerShell** — the script refuses otherwise | Once. Registers `\LarkChannelBridge.ClaudeReleaseAgent`, a `/RL HIGHEST` logon task, and starts it. Needed only if you start Claude from an administrator terminal |
| `Stop-Process <pid>` for a stale Observer | **Administrator PowerShell** if `codex3` ran elevated | An elevated process can only be stopped from an elevated shell |
| `codex3`, `codex3 resume …` | Either | If elevated, its Observer and Release Agent are elevated too, and Codex handoff still works — its own Release Agent does the terminating |
| `claude` | Either | Elevated windows need the Claude Release Agent for handoff; windows from a normal terminal do not |
| `.\scripts\windows\Install-CodexBridgeScripts.ps1` | Either | Copies the scripts to `%USERPROFILE%\Scripts` |
| `lark-channel-bridge start / stop / status` | Either | The bridge runs LIMITED regardless |
| `pnpm install / test / build`, `npm install -g .` | Normal | — |

`whoami /groups | findstr "Mandatory Label"` shows `High Mandatory Level` in an elevated shell.

## Build and install

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
npm install -g .
.\scripts\windows\Install-CodexBridgeScripts.ps1

# Once, from an elevated PowerShell, if you start Claude as administrator:
.\scripts\windows\Register-ClaudeReleaseAgent.ps1

# Restart each profile you run:
lark-channel-bridge stop --profile codex
lark-channel-bridge start --profile codex
lark-channel-bridge stop --profile claude
lark-channel-bridge start --profile claude
```

Do not replace the local build with `npm install -g lark-channel-bridge@latest`; that installs the upstream registry package and removes the local session-management extensions.

After updating `scripts/windows/`, run `Install-CodexBridgeScripts.ps1` again: `codex3` and the release agents run the installed copies in `%USERPROFILE%\Scripts`, and already-running Observers keep the version they started with.

The test suite runs in UTC (`vitest.config.ts`) because some tests pin the clock to midnight UTC while log files are named by local date.

## Known limitations

- **Card buttons inside a message thread.** In a group, a typed command inside a thread belongs to that thread's Lark scope, but a card button clicked inside the thread resolves to the group's main chat scope. A session handed off or used by a button click is therefore bound to the main chat. Prefer typed commands inside threads, or use the buttons from the main chat area.
- **Codex sessions not attached by `codex3`** (started before the attach mechanism or by hand) cannot be handed off; exit them on Windows and use **Use in Lark**.
- **Handoff terminates the Windows window.** The conversation is intact on disk, but an unsent draft in the terminal prompt is lost. After a forced Claude exit the terminal may print stray escape sequences such as `[I[` on focus changes; close that tab.
- **One bot per agent.** A profile runs either Codex or Claude Code; manage the other kind from its own bot.

## Documentation

- [Local documentation index](./local-docs/README.md)
- [Third-party Codex API provider setup](./local-docs/01-codex-third-party-api-key.md)
- [Lark / bridge / Codex / Claude Code architecture](./local-docs/02-lark-bridge-codex-architecture.md)
- [Codex / Claude Code session management](./local-docs/03-codex-session-management.md)

## Upstream and attribution

This project extends **`lark-channel-bridge`** and depends on the upstream project's architecture and runtime behavior.

- [Upstream repository](https://github.com/zarazhangrui/lark-coding-agent-bridge)
- [Upstream English README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.md)
- [Upstream Chinese README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/main/README.zh.md)

For base installation, supported agents, upstream commands, Feishu/Lark app setup, and general bridge configuration, follow the upstream README. The documentation in this repository focuses on the additional Windows Codex monitoring, remote session control, safe release, handoff/handback, and cross-runtime ownership features.
