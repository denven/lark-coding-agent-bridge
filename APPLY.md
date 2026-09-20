# Applying These Documentation Files to an Existing Repository

**English** | [简体中文](./APPLY.md)

The package uses this repository-ready structure:

```text
README.zh-CN.md
README.md
README.upstream.md
APPLY.md
APPLY.en.md
local-docs/
├─ README.zh-CN.md
├─ README.md
├─ 01-codex-third-party-api-key.zh-CN.md
├─ 01-codex-third-party-api-key.md
├─ 02-lark-bridge-codex-architecture.zh-CN.md
├─ 02-lark-bridge-codex-architecture.md
├─ 03-codex-session-management.zh-CN.md
└─ 03-codex-session-management.md
```

Before replacing the repository README, preserve the current upstream/local README:

```powershell
git mv README.zh-CN.md README.upstream.md
```

Then copy the new `README.zh-CN.md`, `README.md`, and `local-docs/` into the repository.

If your existing README already contains local changes, keep the file produced by `git mv`; do not overwrite it with the packaged `README.upstream.md`.

Stage and inspect:

```powershell
git add README.zh-CN.md README.md README.upstream.md APPLY.md APPLY.en.md local-docs
git status --short
git diff --cached
```
