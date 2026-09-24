# Lark, lark-channel-bridge, Codex, and Claude Code Architecture

**English** | [简体中文](./02-lark-bridge-codex-architecture.zh-CN.md)

The local extension uses three explicit session-management layers and exposes them through Lark interactive cards:

```text
Lark Scope
→ /lark status | /lark new | /lark resume

Windows Runtime (Codex bots only)
→ /windows status | /windows release

Global Session Manager
→ /session list | /session use | /session handoff | /session handback | /session tail
```

Legacy commands remain compatibility aliases.

A profile runs exactly one agent — Codex or Claude Code — so every `/session` command works on that profile's agent, and the commands are identical on a Codex bot and a Claude bot. To manage both kinds of session, run one bot per profile.

## Ownership model

```text
Session (Codex or Claude Code)
├─ Windows writer
├─ Lark scope
└─ Detached
```

Only one logical writer should own a session at a time. Thread names are display metadata; the exact full Session ID is the execution identity for release, use, and handoff actions.

A Lark binding is written to two places: `sessions.json` (which the ownership view reads) and the session catalog (which the next Lark message resumes from — Codex resumes only from the catalog). Writing only one of them is not a binding.

## Lark interaction layer

The three command layers are also three UI views:

```text
/lark status
→ current Lark scope view

/windows status
→ Windows runtime view (Codex)

/session list
→ global ownership/inventory view
```

The card layer makes the bridge practical for remote control from **Lark Mobile App** and **Lark Web**:

- `/lark status` exposes current-scope actions.
- `/windows status` adds one-click Release actions for releasable Windows Codex sessions.
- `/session list` opens on category tabs (Handoff / Use / Hand Back / All, over the 10 most recent sessions) and adds ownership-aware actions.
- Web/Desktop clients can display `hover_tips`; mobile clients rely on concise button labels.

Buttons carry only the action and its direction — **Handoff to Lark**, **Use in Lark**, **Hand Back to Windows**, **Last Response**. The numbered row above them identifies the session and the hover tip repeats its title:

```text
Human-visible identity
the numbered row — Thread Name, or a short Session ID when unnamed

Machine target
exact full Session ID in the button payload
```

A Project Name or cwd may be shown as supporting metadata, but is not a session identity because multiple sessions may share the same project or directory.

## Windows → Lark

```text
/session handoff <selector>
```

The handoff sequence is always:

```text
validate the Windows session
→ release the Windows writer
→ bind the Lark scope (catalog + sessions.json)
```

The bridge must never bind Lark first and release Windows afterward. A card action may display a Thread Name, but it passes the exact Session ID to the underlying handoff/release path.

The release itself runs in an agent with the writer's privileges, because the bridge is a non-elevated scheduled task:

- **Codex** — the per-session Release Agent that `codex3` started (`Request-CodexRelease.ps1` → `Watch-CodexRelease.ps1` → `Release-CodexSession.ps1`).
- **Claude Code** — `Request-ClaudeRelease.ps1`, run by the elevated Claude Release Agent when one is up (`Watch-ClaudeRelease.ps1`, registered once by `Register-ClaudeReleaseAgent.ps1`), or directly for non-elevated windows.

The result card shows the **Last Windows Response** so the conversation can be picked up from Lark.

## Lark → Windows

```text
/session handback
```

The bridge removes the current Lark binding (archiving the catalog entry), preserves the history, and returns `codex3 resume <Session-ID>` or `claude --resume <Session-ID>`. Nothing needs to be carried back: Lark turns run on the same Windows machine and are written to the same rollout / transcript.

## Detached → Lark

```text
/session use <selector>
```

`/session use` only binds an already detached session. It does not terminate a Windows writer. If Windows still owns the target, the correct operation is `/session handoff`. The result card shows the session's **Last Response**.

## Global inventory

```text
/session list
```

The inventory combines the agent's history (Codex rollouts and index; Claude Code transcripts), live Windows state (the Codex Observer's status files; Claude Code's own process registry), and Lark scope bindings. Ownership may be reported as Windows, Lark, or Detached.

The interactive inventory renders actions according to ownership:

```text
Detached       → Use in Lark
Windows        → Handoff to Lark
Lark · Current → Hand Back to Windows
```

An action that cannot succeed is not shown. A session whose handoff state is *not transferable* — for example a Codex window never attached by `codex3`, a Codex whose writer exited while its Observer lives on, or an elevated Claude window without the Claude Release Agent — gets no Handoff button, and `/session handoff` explains why instead. The underlying handlers still perform their normal validation.

## Windows monitor

Codex needs a monitor because Codex keeps no live-process registry:

```text
Attach-CodexObserver.ps1   identifies the session codex3 started or resumed
Watch-CodexSession.ps1     Observer: status heartbeat; exits when its Codex exits
Watch-CodexRelease.ps1     per-session Release Agent; exits when its Codex exits
Request-CodexRelease.ps1   the bridge's release request
Release-CodexSession.ps1   identity checks, then terminates the writer
```

Attach resolves `codex3 resume <Session-ID | unique thread name>` directly from the command line; a new session is identified by the first rollout it writes.

Claude Code needs no monitor for status: it records every live process in `~/.claude/sessions/<pid>.json`. Only its release needs the scripts above.

`/windows status` is a runtime view. `/lark status` is a current-scope view. `/session list` is the global inventory view.

## Why this helps remote workflows

The original bridge already supports Lark conversations with Codex and Claude Code. The local session-management layer adds a practical remote control plane around long-running Windows sessions. A user can leave Codex or Claude Code running on a workstation, inspect state from Lark Mobile or Lark Web, hand off a waiting Windows session, continue it from Lark, and later hand it back to Windows without losing the underlying Session ID.
