# Screenshots

The root README expects these three screenshots:

```text
screenshots/
├─ lark-session-status.png
├─ windows-codex-sessions.png
└─ all-codex-sessions.png
```

They demonstrate the fork-specific remote session-management UI, taken on a Codex bot:

- `lark-session-status.png` — current Lark scope/session binding and quick actions.
- `windows-codex-sessions.png` — Windows Codex runtime sessions and safe Release actions.
- `all-codex-sessions.png` — global inventory with ownership-aware actions.

A Claude Code bot renders the same `/session list` card; only the agent name in the title and the data source differ, and it has no `/windows` view.

These screenshots predate two card changes: the category tabs (Handoff / Use / Hand Back / All) at the top of `/session list`, and action-only button labels — buttons now read **Handoff to Lark**, **Use in Lark**, and **Hand Back to Windows** instead of repeating the session name, which the numbered row already shows.

The screenshots document extensions built on top of the upstream `lark-channel-bridge` project.
