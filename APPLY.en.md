# Applying These Documentation Files to an Existing Repository

**English** | [简体中文](./APPLY.md)

The package uses this repository-ready structure:

```text
README.md
README.en.md
README.upstream.md
APPLY.md
APPLY.en.md
local-docs/
├─ README.md
├─ README.en.md
├─ 01-codex-third-party-api-key.md
├─ 01-codex-third-party-api-key.en.md
├─ 02-lark-bridge-codex-architecture.md
├─ 02-lark-bridge-codex-architecture.en.md
├─ 03-codex-session-management.md
└─ 03-codex-session-management.en.md
```

Before replacing the repository README, preserve the current upstream/local README:

```powershell
git mv README.md README.upstream.md
```

Then copy the new `README.md`, `README.en.md`, and `local-docs/` into the repository.

If your existing README already contains local changes, keep the file produced by `git mv`; do not overwrite it with the packaged `README.upstream.md`.

Stage and inspect:

```powershell
git add README.md README.en.md README.upstream.md APPLY.md APPLY.en.md local-docs
git status --short
git diff --cached
```
