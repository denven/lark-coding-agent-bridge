# Applying These Documentation Files to an Existing Repository

**English** | [简体中文](./APPLY.zh-CN.md)

The package uses this repository-ready structure:

```text
README.md
README.zh-CN.md
README.upstream.md
APPLY.md
APPLY.zh-CN.md
local-docs/
├─ README.md
├─ README.zh-CN.md
├─ 01-codex-third-party-api-key.md
├─ 01-codex-third-party-api-key.zh-CN.md
├─ 02-lark-bridge-codex-architecture.md
├─ 02-lark-bridge-codex-architecture.zh-CN.md
├─ 03-codex-session-management.md
└─ 03-codex-session-management.zh-CN.md
screenshots/
└─ README.md  (plus the three screenshots it lists)
```

Before replacing the repository README, preserve the current upstream/local README:

```powershell
git mv README.zh-CN.md README.upstream.md
```

Then copy the new `README.md`, `README.zh-CN.md`, `local-docs/`, and `screenshots/` into the repository.

If your existing README already contains local changes, keep the file produced by `git mv`; do not overwrite it with the packaged `README.upstream.md`.

Stage and inspect:

```powershell
git add README.md README.zh-CN.md README.upstream.md APPLY.md APPLY.zh-CN.md local-docs screenshots
git status --short
git diff --cached
```

These steps only need a normal PowerShell. The one step in this repository that requires an **administrator PowerShell** is registering the Claude Release Agent (`scripts\windows\Register-ClaudeReleaseAgent.ps1`); see the README section *Normal vs. administrator PowerShell*.
