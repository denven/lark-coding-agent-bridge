# 应用到现有仓库

[English](./APPLY.md) | **简体中文**

压缩包中的目录结构：

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
└─ README.md（以及其中列出的三张截图）
```

如果你要保留当前本地仓库的原 `README.zh-CN.md`，建议先在仓库中执行：

```powershell
git mv README.zh-CN.md README.upstream.md
```

然后把压缩包中的新 `README.md`、`README.zh-CN.md`、`local-docs/` 和 `screenshots/` 复制到仓库。

如果你的当前 `README.zh-CN.md` 与上游最新版本存在本地修改，请保留 `git mv` 后得到的那一份 `README.upstream.md`，不要用压缩包中的 `README.upstream.md` 覆盖它。

完成后：

```powershell
git add README.md README.zh-CN.md README.upstream.md APPLY.md APPLY.zh-CN.md local-docs screenshots
git status --short
git diff --cached
```

以上步骤用普通 PowerShell 即可。本仓库中唯一必须在**管理员 PowerShell** 中执行的步骤是注册 Claude Release Agent（`scripts\windows\Register-ClaudeReleaseAgent.ps1`），详见 README 的「普通与管理员 PowerShell」一节。
