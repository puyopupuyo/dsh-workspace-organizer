# AGENTS.md

## 项目
DSH Cordis 插件 `dsh-workspace-organizer`：侧边栏工作区编辑（排序/跨区移动/回收站删除）。只改视图层，不动 DSH 核心。

## 硬约束
- 改名四同步：package.json name、cordis.patch.yml name、src/util.mjs NAME、client.js loader id + exports.name。
- Session 目录 = `session.header.cwd`，无 `session.cwd`。
- 纯 ESM，无构建步骤；client.js 单文件不可拆。

## 架构决策
- 基座：dsh-session-manager；回收站/备份参考 dsh-workspace-mover。
- 移动 = 重写 `session.header.cwd`，活跃会话同步运行时；删除默认回收站，彻底删除二次确认且默认不删磁盘。
- 排序：workspaceOrder["__topLevel__"] / sessionOrder[workspaceId]。

## 命令
dsh plugin --profile <name> add link:/path/to/plugin   # 本地调试
npm test                                             # 测试

## 禁止
- 不改 src/generated/ 等自动生成文件；不硬编码工作区路径；不做无关重构。

## 验证
改移动/删除逻辑后，手动验证：活跃会话迁移、回收站恢复。提交前检查 diff 无无关改动。