# 贡献指南

感谢你愿意改进 `dsh-workspace-organizer`。

## 提交 Issue

请尽量包含：

- **DSH 版本**（桌面版 / `dsh --version`）与操作系统
- **插件版本**（`package.json` 的 `version`）
- **复现步骤**：从哪里点、拖到哪里、期望什么、实际什么
- **相关日志**：侧边栏相关日志以 `[workspace-organizer]` 开头；Host 侧报错在 DSH 主进程日志里
- 如果涉及渲染/槽位，附上 DevTools Console 的报错（`Ctrl+Shift+I`）

安全相关问题**不要**开公开 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

## 提交 Pull Request

- 保持**纯 ESM、无构建步骤**：`client.js` 是单文件 Client 半，`src/*.mjs` 是 Host 半。
- **不要硬编码任何本机路径**（Windows 用户目录、Linux 家目录、具体盘符工作区路径）；一律走 `$DSH_HOME` 或占位符。
- **不要提交** `.env`、`.credentials.yaml`、`auth.json`、`*.pem`、`*.key`、会话日志、真实 sessionId（`.gitignore` 已覆盖，提交前 `git status` 自查）。
- **改名要四同步**：`package.json` 的 `name`、`cordis.patch.yml` 的 `name`、`src/util.mjs` 的 `NAME`、`client.js` 的 loader `id` 与 `PLUGIN`。
- **不做无关重构**：一个 PR 只做一件事，不要顺手改格式。
- 新增行为请带测试，且不要为了「让测试过」而删除既有断言。

## 本地运行

```bash
npm run check                 # 语法 + 导入自检
npm test                      # Host 半单测（apply/folders/files/host/cost）
node test/ui-tree.test.mjs    # Client 半 UI 冒烟（需要 react-test-renderer）
```

`node --check` 与测试都直接跑源码，没有构建产物。

UI 冒烟测试依赖 `react` / `react-test-renderer`。仓库不附带它们，请自备：

```bash
mkdir -p .tmp-ui && cd .tmp-ui
npm init -y && npm i react@18 react-test-renderer@18
```

## 代码风格

- 与现有代码保持一致：2 空格缩进、单引号、分号。
- 注释写「为什么」，不写「做了什么」。
- 槽位注册一律用 `guarded()` 包裹，渲染崩溃用 `QuietBoundary` 兜住——这是硬约束，见 README「架构」。
