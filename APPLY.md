# 应用到现有仓库

压缩包中的目录结构：

```text
README.md
README.upstream.md
local-docs/
├─ README.md
├─ 01-codex-third-party-api-key.md
└─ 02-lark-bridge-codex-architecture.md
```

如果你要保留当前本地仓库的原 `README.md`，建议先在仓库中执行：

```powershell
git mv README.md README.upstream.md
```

然后把压缩包中的新 `README.md` 和 `local-docs` 复制到仓库。

如果你的当前 `README.md` 与上游最新版本存在本地修改，请保留 `git mv` 后得到的那一份 `README.upstream.md`，不要用压缩包中的 `README.upstream.md` 覆盖它。

完成后：

```powershell
git add README.md README.upstream.md local-docs
git status --short
git diff --cached
```
