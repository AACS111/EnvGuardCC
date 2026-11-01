# 开发与合并流程

## 分支约定

- `main`：稳定版本与正式发布入口。日常开发和外部 PR 测试均不直接在此分支进行。
- `develop`：长期开发与集成测试分支，接收功能分支和外部 PR；通过测试后再发起 `develop → main` 的发布 PR。
- `feature/<主题>`、`fix/<主题>`：从最新 `develop` 创建，完成后向 `develop` 提交 PR。

```bash
git switch develop
git pull --ff-only origin develop
git switch -c feature/my-change
```

现有外部 PR 若目标为 `main`，先在 `develop` 本地集成并测试；后续贡献 PR 请以 `develop` 为目标。将 PR 合入开发分支不代表其已通过发布验证。

## 本地验证

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm build
node --test --test-timeout=60000 scripts/check-*.mjs scripts/check-*.cjs tools/license-generator/check-license.mjs
```

真实浏览器测试要求本机已安装且可正常启动 Chrome 或 Edge，可用 `CHECKCC_BROWSER_PATH` 指定路径。macOS 和 Windows 的系统集成、桌面启动和安装包需分别在对应平台验证；提交 PR 时说明测试环境、结果及尚未验证的项目。

## 发布

开发分支测试完成后向 `main` 提交 PR，检查通过并审核后合并。`develop` 推送后构建 Windows x64 与 macOS arm64 安装包用于验证；将通过验证的代码合入 `main` 后，推送与 package.json 版本一致的 `v<版本>` 标签。标签工作流等待两平台构建成功，汇总四个安装包和校验值，再发布 GitHub Release。GitHub 默认分支和分支保护策略由仓库设置管理，本流程文件不提供强制保护。
