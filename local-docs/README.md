# Local Documentation

**English** | [简体中文](./README.zh-CN.md)

This directory documents the local Windows/Codex extensions maintained on top of the upstream `lark-channel-bridge` project.

## Documents

1. [Third-party Codex API provider setup](./01-codex-third-party-api-key.md)
2. [Lark / Bridge / Codex architecture](./02-lark-bridge-codex-architecture.md)
3. [Codex Session / Thread management and local storage](./03-codex-session-management.md)

The session-management documentation uses the current command model:

```text
Lark Scope      → /lark ...
Windows Runtime → /windows ...
Global Sessions → /session ...
```

The latest UI also provides interactive actions intended for practical remote management from Lark Mobile App and Lark Web. See the root [README](../README.md) for screenshots.
