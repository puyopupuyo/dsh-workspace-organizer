# 安全策略

## 报告问题

**请不要公开提 Issue。** 请使用 GitHub 的私密报告通道：

- 仓库页 → **Security** → **Report a vulnerability**（GitHub Security Advisory）

如果该入口不可用，可以开一个**不含任何利用细节**的 Issue，只说明「有安全问题，希望私下联系」，维护者会与你约定后续渠道。

我们会在确认后尽快回复，并在修复发布后致谢（如你愿意署名）。

## 支持范围

| 版本 | 是否支持 |
| --- | --- |
| 最新 release / main 分支 | ✅ |
| 更早版本 | 视情况，建议先升级 |

## 本插件的安全边界

`dsh-workspace-organizer` 是**本地插件**，运行在你自己的机器上：

- Host 半通过 `connection.rpc.handle('/', { authority: 'loopback' })` 只暴露**回环** RPC，不监听公网端口、不访问外部网络。
- 所有数据落在 `$DSH_HOME/workspace-organizer/`，不采集、不上传任何内容。
- 文件夹是**视图层容器**，不改 `Session` 的 `header.cwd`、不移动磁盘文件。
- 删除操作默认进回收站；彻底删除前强制备份，备份失败即拒绝。
- 任何删改前会校验目标位于 `$DSH_HOME/sessions` 下恰好两层，且整条链没有符号链接。

因此最有价值的报告方向是：

- 路径穿越 / 越界删除（例如通过构造的 sessionId、folderId 逃出 `$DSH_HOME`）
- 原子写入失败导致 sidecar 损坏或数据丢失
- 成本数据源被恶意内容污染导致 UI 崩溃或注入
- 权限提升：从 loopback RPC 越权访问本不该读写的文件

## 依赖与安装风险

本项目的包名 `dsh-workspace-organizer` **没有 npm 作用域**。如果 npm 上出现同名包，它不是本项目的发布物，请勿安装。官方安装方式只有 README 里写的「从 GitHub 仓库 link 安装」。
