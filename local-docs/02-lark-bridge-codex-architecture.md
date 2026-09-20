# Lark, lark-channel-bridge, and Codex Architecture

**English** | [简体中文](./02-lark-bridge-codex-architecture.zh-CN.md)

The local extension uses three explicit session-management layers and exposes them through Lark interactive cards:

```text
Lark Scope
→ /lark status | /lark new | /lark resume

Windows Runtime
→ /windows status | /windows release

Global Session Manager
→ /session list | /session use | /session handoff | /session handback
```

Legacy commands remain compatibility aliases.

## Ownership model

```text
Codex Session
├─ Windows
├─ Lark scope
└─ Detached / Unknown
```

Only one logical writer should own a session at a time. Thread names are display metadata; the exact full Session ID is the execution identity for release, use, and handoff actions.

## Lark interaction layer

The three command layers are also three UI views:

```text
/lark status
→ current Lark scope view

/windows status
→ Windows runtime view

/session list
→ global ownership/inventory view
```

The card layer makes the bridge practical for remote control from **Lark Mobile App** and **Lark Web**:

- `/lark status` exposes current-scope actions.
- `/windows status` adds one-click Release actions for releasable Windows sessions.
- `/session list` adds ownership-aware Use, Handoff, and Hand Back actions.
- Web/Desktop clients can display `hover_tips`; mobile clients rely on concise button labels.

The label/target rule is intentionally asymmetric:

```text
Human-visible label
Thread Name
→ duplicate Thread Name + short Session ID
→ short Session ID when unnamed

Machine target
exact full Session ID
```

A Project Name or cwd may be shown as supporting metadata, but is not a session identity because multiple sessions may share the same project or directory.

## Windows → Lark

```text
/windows status
/session handoff <selector>
```

The handoff sequence is always:

```text
validate Windows session
→ release Windows writer
→ bind the Lark scope
```

The bridge must never bind Lark first and release Windows afterward. A card action may display a Thread Name, but it passes the exact Session ID to the underlying handoff/release path.

## Lark → Windows

```text
/session handback
```

The bridge removes the current Lark binding, preserves the Codex history, and returns a `codex3 resume <Session-ID>` command.

## Detached → Lark

```text
/session use <selector>
```

`/session use` only binds an already detached session. It does not terminate a Windows writer. If Windows still owns the target, the correct operation is `/session handoff`.

## Global inventory

```text
/session list
```

The inventory combines Codex history/index data, rollout metadata, Windows monitor state, and Lark scope bindings. Ownership may be reported as Windows, Lark, Detached, or Unknown / Unmanaged.

The interactive inventory renders actions according to ownership:

```text
Detached      → Use in this Lark
Windows       → Handoff to this Lark
Lark · Current → Hand Back to Windows
```

Unsafe or ambiguous actions are not exposed merely for convenience; the underlying handlers still perform their normal validation.

## Windows monitor

The Windows layer uses:

```text
Attach-CodexObserver.ps1
Watch-CodexSession.ps1
Watch-CodexRelease.ps1
Request-CodexRelease.ps1
Release-CodexSession.ps1
```

`/windows status` is a runtime view. `/lark status` is a current-scope view. `/session list` is the global inventory view.

## Why this helps remote workflows

The original bridge already supports Lark-to-Codex conversations. The local session-management layer adds a practical remote control plane around long-running Windows Codex sessions. A user can leave Codex running on a workstation, inspect state from Lark Mobile or Lark Web, release or hand off a waiting Windows session, continue it from Lark, and later hand it back to Windows without losing the underlying Session ID.
