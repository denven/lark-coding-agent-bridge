# lark-channel-bridge — Local Codex Session Handoff Extension

**English** | [简体中文](./README.zh-CN.md)

> A Windows-focused extension of `lark-channel-bridge` for remote Codex CLI monitoring, safe session handoff/handback, and multi-session ownership management through Lark/Feishu.

The extension is designed to make Codex session operations practical from both **Lark Mobile App** and **Lark Web**. Interactive cards expose the current Lark binding, Windows runtime sessions, and the global Codex session inventory, so common remote operations can be performed without typing long Session IDs or opening a remote desktop session.

## Remote Codex session management from Lark

The UI follows the same three-layer model as the command set:

| Scope | Recommended commands | Meaning |
|---|---|---|
| Lark Scope | `/lark status`, `/lark new`, `/lark resume` | Current Lark Chat / Group / Topic binding |
| Windows Runtime | `/windows status`, `/windows release` | Windows Codex TUI, Observer, Release Agent, writer |
| Global Session Manager | `/session list`, `/session use`, `/session handoff`, `/session handback` | Cross-runtime inventory and ownership transfer |

The interactive cards are especially useful on a phone:

- `/lark status` shows the current Lark scope and provides quick actions such as **New Lark Session**, **Resume Lark Session**, **Workspace**, and **Help**.
- `/windows status` shows Windows Codex sessions and adds a **Release** action for sessions that are safe to release.
- `/session list` shows session ownership and exposes context-aware actions: **Use in this Lark**, **Handoff to this Lark**, or **Hand Back to Windows**.
- Lark Web/Desktop can additionally show button `hover_tips`; Lark Mobile relies on the button labels themselves.

Action labels are optimized for readability, while execution remains unambiguous:

```text
Display identity
Thread Name
→ duplicate Thread Name + short Session ID
→ short Session ID when no Thread Name exists

Execution identity
ALWAYS the exact full Session ID
```

Project names and working directories are shown as metadata, but are **not** used as the identity of an action because several sessions can share the same project or cwd.

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

This makes it possible to inspect and switch Codex ownership remotely from Lark Mobile or Lark Web while keeping the Windows/Lark single-writer rule explicit.

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
codex3
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

## Ownership model

```text
One Codex Session
       │
       ├── Windows writer
       ├── Lark scope
       └── Detached / unbound

Only one logical writer should own the session at a time.
```

The UI can use a Thread Name for readability, but all destructive or ownership-changing actions target the **full Session ID** internally.

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

Runtime data is stored under:

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

Do not replace the local build with `npm install -g lark-channel-bridge@latest`; that installs the upstream registry package and removes the local session-management extensions.

## Documentation

- [Local documentation index](./local-docs/README.md)
- [Third-party Codex API provider setup](./local-docs/01-codex-third-party-api-key.md)
- [Lark / Bridge / Codex architecture](./local-docs/02-lark-bridge-codex-architecture.md)
- [Codex session management](./local-docs/03-codex-session-management.md)

## Upstream

Based on `zarazhangrui/lark-coding-agent-bridge`.
