# dsh-workspace-organizer

> ⚠️ **仅从 GitHub 安装。** 本项目没有发布到 npm；npm 上若出现同名包 `dsh-workspace-organizer`，与本项目无关，请勿安装。
>
> 许可证：MIT（见 [LICENSE](LICENSE)）。部分实现衍生于 DeepSeek Harness 客户端（MIT），归属声明见 [NOTICE](NOTICE)。

编辑 DSH 侧边栏工作区的插件：**接管工作区浏览器**，把「工作区 → 文件夹（可折叠）→ 会话」渲染成原生树；同时提供跨工作区移动会话、删除项目（回收站 / 仅移除注册 / 彻底删除）。

文件夹是**工作区内部的视图层容器**：只改侧边栏渲染与 sidecar 元数据，不改 `Session` 的 `header.cwd`、
不移动磁盘文件、不删除任何会话或目录。

## 架构：priority -1 影子接管

`sidebar.workspaces` 是 single 槽位（官方 `@deepseek-ai/dsh-client-ui-workspace` 以 priority 0 占用）。
本插件以 **priority -1** 注册同一个槽位，最低优先级赢得渲染位，从而接管整个工作区浏览器：

- **不声明 children**：官方条目已经持有 `sidebar.workspaces.directoryFlow`、
  `sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`、
  `sidebar.session.row.leading`、`sidebar.session.row.hover` 等子座位；重声明会抛
  `already declared` 并静默注销自己的座位。
- **从 ledger 读回官方行座位**：渲染树时用 `slots.entriesOfSlot(name)` 读出存活的座位条目，
  按其 `inject()` 面 + 槽位级 hooks 组装 props 后插回原位（菜单项、归档/pin 行内按钮、
  leading 标记、hover 卡）。任一座位缺失只跳过它，不阻断整树。
- **可逆**：`disposer` 一调，官方 priority 0 条目自动回到渲染位。侧边栏底部还有
  **「文件夹树 / 官方视图」** 开关，随时切换。
- **不 disable 官方条目**，也不往官方列表容器里插 DOM：整棵树由本插件渲染，位移动画参考官方
  `AnimatedRows`（cloneNode + `inert` 退场克隆）。
- **等声明，不赌加载顺序**：槽位声明者是 `@deepseek-ai/dsh-client-ui-sidebar`，它的 inject 是
  `['slots','layout','sessions','workspaces','locale']`，而本插件只需要 `['connection','slots']` ——
  Cordis loader 并行创建 entry（`Promise.allSettled`），所以冷启动时本插件**必然先于** ui-sidebar 激活，
  apply 那一刻 `sidebar.workspaces` 还没被声明。因此接管注册走官方 `slots.inject('sidebar.workspaces', cb)`
  （声明出现即执行，折叠即回收），而不是「apply 时读一次 spec」。

  ⚠️ 不要用 `slots.subscribeDeclaration` / `slots.specDynamic` 做兜底：`SlotRegistry` 的服务面只暴露
  `inject / spec / entries / entriesOfSlot / register`，那两个方法根本不存在（取值恒为 `undefined`），
  写出来等于「永不重试」——表现为**每次冷启动侧边栏都退回官方视图，只有重载插件才恢复**，
  而 footer / 菜单等座位（走 `slots.inject`）却一切正常。

## 功能

### 1. 工作区树 + 文件夹

```
工作区 A
├─ 前端项目（文件夹，可折叠）   ← 与未收纳会话同级交错
│  ├─ 会话 1
│  └─ 会话 2
├─ 会话 3（未收纳）
└─ 会话 4（未收纳）
工作区 B
└─ …
未分组（尾组，不在任何工作区里的会话）
```

- 每个工作区行有独立的 **新建文件夹** 入口（工作区菜单）。
- 文件夹可折叠、重命名、改颜色、删除；删除时内部会话**回退到同级未收纳区**，绝不删除会话。
- 文件夹与未收纳会话在同一层级内可拖拽排序，顺序写入 `WorkspaceItemOrder`。
- 会话行保留官方能力：打开 / 重命名（双击）/ 归档 / pin / fork / 行内快捷操作 /「…」菜单；
  菜单里另有本插件的 **移到文件夹…** 与 **删除项目…**。
- 顶部有搜索框与视图选项（按工作区分组 / 单列表、隐藏归档 / 含归档 / 仅归档）。
- 侧边栏折叠成窄栏时显示一个展开按钮。

### 2. 拖拽语义

| 拖动 | 落到 | 结果 |
| --- | --- | --- |
| 会话（未收纳） | 文件夹行 | 收纳进该文件夹 |
| 会话（文件夹内） | 未收纳会话行 | 移出文件夹，并按落点前后排序 |
| 会话 | 同区会话行（文件夹内） | 收纳/移动到该文件夹，并插到目标前/后 |
| 文件夹 | 未收纳会话 / 另一文件夹行 | 调整工作区顶层顺序（folder 与 session 交错） |
| 工作区行 | 另一个工作区行 | 调整工作区顺序（官方 `insertBefore`） |
| 会话 | **另一个工作区的文件夹行** | **两步**：先改 `header.cwd`（跨区移动），成功后再写 `FolderMembership` |
| 会话 | 另一个工作区标题行 | 跨区移动（弹确认框，保留全部历史） |

拖拽监听只在命中本插件发起的拖拽时 `preventDefault/stopPropagation`；其他拖拽事件立即放行，
不吞官方排序的 drop。

### 3. 删除项目

会话行「…」菜单里 **删除项目…**，三种方式：

| 方式 | 行为 | 能否恢复 |
| --- | --- | --- |
| 移入回收站（默认） | 档案移到插件回收站，侧边栏移除 | 可以，在回收站面板里恢复 |
| 仅移除注册 | 只摘掉工作区名单，磁盘档案保留 | 索引重建后可能重新出现 |
| 彻底删除 | **先备份**，再删磁盘档案 | 通过备份目录人工恢复 |

彻底删除需要再点一次确认；备份失败会直接拒绝删除（零副作用）。

### 4. 回收站面板

侧边栏底部「回收站」按钮：列出已删除项目，可**恢复**（回原工作区原目录）或**彻底删除**（同样先备份）。

## 安装

### 1. 克隆仓库

```bash
git clone https://github.com/puyopupuyo/dsh-workspace-organizer.git
cd dsh-workspace-organizer
```

### 2. link 进 profile

```bash
dsh plugin --profile <name> add link:/path/to/dsh-workspace-organizer
```

Windows 上把路径换成盘符写法，例如 `link:E:/path/to/dsh-workspace-organizer`。

或手工：

1. 在 profile 的 `package.json` 的 `dependencies` 加
   `"dsh-workspace-organizer": "link:/path/to/dsh-workspace-organizer"`；
2. 在 `dsh.profile.bundles` 末尾加 `"dsh-workspace-organizer"`；
3. 在 profile 目录执行 `pnpm install`；
4. **完全退出 DSH 再启动**（不是刷新窗口，也不是只重载插件）：Client 半的包名映射在启动时建立，改过 `package.json` 必须冷启动。

`cordis.patch.yml` 会把 Host 半插入插件行，`package.json` 的 `dsh.client` 声明 Client 半的平台与依赖。

### 3. 验证

重启后侧边栏应被本插件接管（工作区标题 + 搜索 + 视图选项）。若仍是官方视图，先看 DevTools（`Ctrl+Shift+I`）Console 里的报错，以及主进程日志里 `[workspace-organizer]` 开头的行。

卸载：`dsh plugin --profile <name> remove dsh-workspace-organizer`，或从 profile 的 `dependencies` / `bundles` 里删掉后 `pnpm install`。已建的文件夹留在 sidecar 里，不会删除任何会话。

## 数据位置

全部落在 `$DSH_HOME/workspace-organizer/`：

```
folders.v1.json                                # 文件夹 / 归属 / 工作区顶层顺序，原子写入
folders.v1.json.corrupt-<时间戳>                # sidecar 损坏时的留档（自动回退到「全部未收纳」）
folder-cost-rollups.json                       # 统一会话级成本缓存 + 文件夹/工作区汇总（独立文件）
folder-cost-rollups.json.corrupt-<时间戳>       # 成本缓存损坏时的留档（自动重建）
recycle/<timestamp>-<sessionId>/session/...   # 回收站（可恢复）
recycle/<...>/manifest.json                   # 原 cwd / 原工作区 / 归档状态
backups/<sessionId>/<ISO 时间戳>/session/...  # 彻底删除前的强制备份，每个会话保留最近 20 份
```

会话档案本身仍在 `$DSH_HOME/sessions/<projectKey>/<sessionSegment>/`，插件不做任何"另存一份"的迁移。

sidecar 结构：

```jsonc
{
  "version": 2,
  "folders": [
    { "id": "f_1a2b3c4d", "workspaceId": "<Workspace ID>", "name": "前端项目",
      "color": "#4f7cf5", "icon": "📦", "collapsed": false, "order": 0 }
  ],
  "memberships": [
    { "folderId": "f_1a2b3c4d", "sessionId": "<Session ID>", "orderInFolder": 0 }
  ],
  "orders": {
    "<Workspace ID>": [
      { "type": "session", "id": "<Session ID>" },
      { "type": "folder", "id": "f_1a2b3c4d" }
    ]
  }
}
```

- `workspaceId` 必填，是层级正确的前提；文件夹只能出现在自己所属工作区的顺序表里。
- `sessionId` 就是 **Session ID**（与成本/状态数据同一把钥匙）；一个会话同时最多属于一个文件夹。
- 已收纳的会话不占工作区顶层槽位；未出现在顺序表里的会话与文件夹自动补到末尾。

## 成本展示：文件夹小计 / 工作区总计 / 底栏会话（M1–M6）

三处展示**共用同一份 Host 侧会话级成本缓存**（`state.sessions`）：会话成本只按水位读一次，
文件夹小计与工作区总计都只是对同一份 mark 求和，底栏徽章直接读当前会话的 mark。
不采集 token、不实现计价——价目表与峰谷判定来自外部账单插件。

```
文件夹行   📁 客户项目 A  ¥12.48     （其下会话小计）
工作区行   🗂 工作区 A     ¥48.20     （该工作区**全部**会话，含未收纳）
底栏       ⚡ 缓存命中 99%  ¥1.25  上下文占用 16%
```

降级规则（统一，绝不显示 ¥0.00 或占位符）：

```
空文件夹 / 空工作区            → 不渲染任何成本字符
有会话查不到成本               → ¥12.48*（并标「部分数据缺失」）
全部会话都查不到               → 隐藏
无成本数据源                   → 所有花费列隐藏，树顶一行「成本统计不可用」；底栏徽章不渲染
```

- 悬停文件夹行给出明细卡：文件夹总计、会话数、token 总量、**逐会话成本**（明细求和 = 小计）、
  「其中子代理：¥xx」、缺失项清单，末尾固定声明「估算值（非平台账单）」。
- 悬停工作区行显示「包含 X 个会话，其中未收纳 Y 个」的明细。
- 底栏花费是 `conversation.composer.dock` 上的**独立条目**（`id: 'workspace-organizer-cost'`、`order: 10`），
  与官方 `stats`（默认 priority 0 / order 0）并列渲染：dock 本身是 flex 行，于是顺序天然是
  「StatsPills（轮步/tok/s、token/缓存命中）→ 花费徽章 → ContextMeter（上下文占用）」。
  **不影子官方 stats cell**（不用 priority -1，也不读回官方组件重渲染）、不接管整个底栏、
  不用 MutationObserver —— 官方统计永远由官方条目自己渲染。
  成本缺失 / 数据源不可用 / 金额非正数时徽章整块不渲染。
- 徽章外观与官方 pill 对齐：字号/行高直接复用官方变量
  `calc(var(--dsh-content-font-size-secondary,13px) - 1px)` /
  `calc(20px + var(--dsh-content-font-delta-secondary,0px))`，颜色 `--dsw-alias-label-tertiary`，
  前缀一枚 **16px 内联 SVG「一碗白饭」**（`viewBox 0 0 16 16`、`fill:none`、`stroke:currentColor`、
  `strokeWidth 1`、圆头线帽，与官方图标同一画法）。
  造型照 🍚：上方一团**比碗口小的半圆米饭**，下方梯形碗 + 横碗沿；米饭的底边与碗沿故意不齐，
  两条线不连成整圆，小尺寸下才不会读成胶囊。
- 成本小计**不参与** `WorkspaceItemOrder` 排序，只是行附属信息。

### 数据源（优先级从高到低，第一个可用的胜出）

| # | 来源 | 说明 |
| --- | --- | --- |
| 1 | `dsh-workspace-hub` | `/api/wsfm/cost` + `/api/wsfm/tokens`，需显式配置 `DSH_WSFM_BASE`（自带日志水位校验） |
| 2 | **会话投影缓存**（本机默认） | `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`：`rows.cacheBilling.val.totals`（meow-cachebilling 算好的会话累计花费，含峰谷）+ `rows.tokenUsage.val.totals`（原生 token-meter 投影）+ `rows.subagent`（子代理标记） |
| 3 | `meow_cachebilling` 历史账本 | `$DSH_HOME/storages/meow_cachebilling.json` → `tables.sessions[<recordId>].steps[].c` 逐轮求和（压缩换代的 `<id>#<gen>` 也会合并） |

### 增量逻辑（水位不变就复用缓存）

```
ensureSessionCost(sessionId)            // 唯一的会话成本计算入口
  stamp = { 会话日志 mtime+size, 投影缓存 mtime+size }
  与 state.sessions[sessionId] 的水位一致 → 直接复用，不打扰数据源
  否则 → 读数据源，更新水位与 cost / tokens / subagent / missing

recomputeFolder(folderId):
  成员 = getSessionsInFolder(folderId)          // 只用这个接口，不遍历 DOM
  逐成员 ensureSessionCost() → 求和              // 文件夹只做求和
recomputeWorkspace(workspaceId):
  成员 = sessionIdsOfWorkspace(workspaceId)     // 含未收纳、已归档
  逐成员 ensureSessionCost() → 求和              // 工作区也只做求和
底栏徽章 = state.sessions[当前 sessionId]        // 直接读，不做第二套计算
```

`sessionToFolderIndex`（`sessionId → Set<folderId>`）在 `src/folders.mjs` 的 `mutate()` 里
与 `memberships` **同时翻页**，所以删会话/归档时一步就能定位受影响文件夹；`foldersOfSession()` 是它的只读出口。
工作区侧对应 `workspaceIds()` / `sessionIdsOfWorkspace()` / `workspacesOfSession()`（Host 从
`workspaceRegistry` 的原始记账名单读，不经过侧边栏可见性过滤）。

触发是**局部**的，两条路径互补，都不做全量重算；文件夹与工作区在**同一次锁内**一起更新，不会割裂：

| 触发 | 时机 | 行为 |
| --- | --- | --- |
| `addToFolder` / `removeFromFolder` | 收纳、移出 | `invalidateSessions()`：重算该会话所在的文件夹**与工作区** |
| 跨工作区移动 / 回收站恢复 | 移动、恢复成功后 | 成员换区，按 ID 重算受影响的工作区（只求和） |
| 会话删除 / 回收站彻底删除 | 删除成功后 | 先按反向索引记下原文件夹 → prune → 按文件夹 ID 批量重算 + 全量工作区重算 |
| `session/event` / `session/disposed` | 会话产生新用量、被销毁 | 只把 sessionId 记进脏集合，**2 秒内合并**成一次 `poll(ids)` |
| 定时兜底 `poll()` | 每 60 秒 | 批量 stat 已有缓存的会话，**只重算水位变了的文件夹/工作区** |
| UI 刷新 `organizer.cost.snapshot` | 文件夹/工作区/会话变化后 | 逐文件夹与工作区增量重算；可带 `sessionIds` 确保底栏当前会话也有缓存 |

`poll()` 与 `snapshot()` 的区别：`poll` 先批量读水位、跟缓存比对，**一个都没变就既不读数据源也不写盘**；
`snapshot` 则把文件夹/工作区/会话三份 view 一并算好返回给 UI。两者都在同一条串行锁上，不会互相踩写。

客户端**只有一个**成本 debounce（`scheduleCostsRefresh`，1.2s；树与底栏共用）。底栏没有自己的
轮询定时器，也不做全量扫描——它只按 `sessionId` 读缓存，刷新复用 M4 的水位触发。

> 定时器不是"每 30 秒全量扫描所有文件夹"：它只 stat **已经算过水位**的会话，命中没变化就立刻返回，
> 不做任何重算、不读取任何成本数据源。

### 成本缓存文件

```jsonc
// $DSH_HOME/workspace-organizer/folder-cost-rollups.json（与 folders.v1.json 分开写）
{
  "version": 2,
  // 统一的会话级缓存：三处花费的唯一事实来源
  "sessions": {
    "<Session ID>": { "logMtime": 1793102602173, "logSize": 128974,
                      "srcMtime": 1793102602173, "srcSize": 128974,
                      "cost": 2.019347, "tokens": 32808979, "subagent": false, "missing": false }
  },
  // 工作区总计（含未收纳；sessionIds 让 UI 能算「未收纳 Y 个」）
  "workspaces": {
    "ws_1": { "workspaceId": "ws_1", "totalCost": 48.2, "totalTokens": 81234567,
              "sessionCount": 9, "missingCount": 0, "subagentCost": 3.1,
              "sessionIds": ["..."], "lastComputedAt": "2026-11-03T14:00:00.000Z" }
  },
  // 文件夹小计（保留逐会话水位，v1 缓存升级时自动迁移进 sessions）
  "rollups": {
    "f_1a2b3c4d": {
      "folderId": "f_1a2b3c4d",
      "totalCost": 12.48, "totalTokens": 32072704, "sessionCount": 3,
      "lastComputedAt": "2026-11-03T14:00:00.000Z",
      "sessionWatermarks": { "<Session ID>": { "...": "同上" } }
    }
  }
}
```

- 归属是低频写、成本是高频刷新，两个文件分开写，互不拖累。
- 删除文件夹**不删**成本记录（历史留着；同名重建沿用旧记录的思路见下）。
- 缓存损坏就地留档 `.corrupt-<时间戳>` 后重建（它只是缓存，丢得起）。
- v1 → v2 迁移：把旧 `rollups[*].sessionWatermarks` 回填进 `sessions`，升级后**不重读**数据源。
- 成本模块任何异常（数据源缺、写盘失败、解析失败）都只让成本列/徽章消失，绝不阻断收纳/拖拽/折叠/排序。

### 刻意不做的事

| 规格里的可选项 | 为什么不做 |
| --- | --- |
| `folder-prices.json` 自定义单价 | 单价与峰谷属于**外部账单插件**的价目表（meow-cachebilling 的 `rates.yml`）。在这里再放一份单价，两处会各算一套数字，反而更不可信。要改价请改账单插件。 |
| 重名重建时拿旧 rollup 当初始值 | 同名不等于同一批会话（`folderId` 是随机新 ID）。当前实现是「旧记录保留、新文件夹按当前成员重新算」，一次快照即可，避免把无关历史串到新文件夹上。 |
| 归档动作触发重算 | 归档只隐藏会话、不改档案也不改用量，成本不会变；它仍在文件夹里，总计本来就不该动。 |
| 平台账单语义 | 价目表是刊例价 + 峰谷估算，和真实扣费可能不同，UI 一律标「估算值（非平台账单）」。 |

### 接入 dsh-workspace-hub（可选）

装了 hub 并希望用它当成本源时，给 Host 进程一个环境变量即可（它比投影缓存优先级更高）：

```bash
# 例：hub 监听 127.0.0.1:4300
export DSH_WSFM_BASE=http://127.0.0.1:4300
```

启动后 `organizer.cost.status` 会返回 `source: 'wshub'`；请求失败会自动回落到投影缓存，
两者都不可用时成本列隐藏。没有 hub 的话不用配，本机默认走投影缓存。

## 给「成本聚合」预留的接口

```js
// Host 半（同进程内同步调用，import 即可）
import { getSessionsInFolder, foldersOfSession } from 'dsh-workspace-organizer';
const sessionIds = getSessionsInFolder(folderId); // → string[]（按组内顺序）
const folderIds = foldersOfSession(sessionId);    // → string[]（反向索引，一步定位）

// Client 半（浏览器只能异步，签名返回 Promise<string[]>）
const sessionIds = await exports.getSessionsInFolder(folderId);
```

成本聚合模块直接用这个接口拿成员，**不要**遍历 DOM 或猜归属关系。

## 安全设计

- **先物理、后账目**：移动/删除都先把可回滚的文件动作做完，再改 registry；任一步失败按原路回滚。
- **收纳零物理侵入**：sidecar 原子写入（临时文件 + fsync + rename），写失败即整次操作回滚；
  sidecar 损坏自动留档并回退到「全部未收纳」，不会白屏。
- **档案目录白名单**：任何删改前都校验目标位于 `$DSH_HOME/sessions` 下恰好两层、目录名是编码后的会话 ID、整条链没有符号链接。
- **强制备份**：彻底删除与回收站的彻底删除都必须先备份成功；备份失败一律拒绝。
- **不删未知数据**：会话档案必须是普通文件，zstd 帧不完整或日志被截断时拒绝改写。
- **运行中会话**：正在运行的会话拒绝删除；移动时会重绑 writer，无法重绑则拒绝迁移而不是赌一把。
- **降级**：`guarded()` 包裹每次注册（失败只废掉该座位），`QuietBoundary` 包裹自绘浏览器
  （渲染崩溃不外溢），workspaces/sessions/slots 服务缺失时跳过接管、官方浏览器继续渲染。

## 端点（Host RPC，仅回环连接）

`connection.rpc.handle('/workspace-organizer', ...)`，`authority: 'loopback'`：

| 端点 | 说明 |
| --- | --- |
| `organizer.status` | 宿主能力位与数据目录 |
| `organizer.tree` | 工作区 + 会话概览 |
| `organizer.move` | `{sessionId, targetWorkspaceId, beforeSessionId?}` |
| `organizer.reorderWorkspace` | `{workspaceId, beforeWorkspaceId?}` |
| `organizer.reorderSession` | `{sessionId, beforeSessionId?}` |
| `organizer.delete` | `{sessionId, mode: 'recycle'\|'unregister'\|'purge'}` |
| `organizer.trash.list` / `restore` / `purge` | 回收站 |
| `organizer.backups.list` | 备份清单 |
| `organizer.folders.state` | 文件夹状态（folders / memberships / orders） |
| `organizer.folders.create` | `{workspaceId, name, color?, icon?}` |
| `organizer.folders.update` | `{folderId, name?, color?, icon?, collapsed?}` |
| `organizer.folders.delete` | `{folderId}` → 内部会话回退未收纳 |
| `organizer.folders.add` | `{folderId, sessionId, beforeSessionId?}` |
| `organizer.folders.remove` | `{sessionId, placeAtTop?}` |
| `organizer.folders.reorder` | `{folderId, sessionId, beforeSessionId?}` |
| `organizer.folders.order` | `{workspaceId, items: WorkspaceItemOrder[]}` |
| `organizer.folders.sessions` | `{folderId}` → `sessionIds`（只读聚合接口） |
| `organizer.cost.snapshot` | `{sessionIds?}` → 文件夹 / 工作区 / 会话三份成本视图（增量：只重取水位变了的会话；`sessionIds` 确保底栏当前会话也有缓存） |
| `organizer.cost.folder` | `{folderId, force?}` → 单文件夹重算并返回逐会话明细 |
| `organizer.cost.workspace` | `{workspaceId, force?}` → 单工作区重算（含未收纳会话） |
| `organizer.cost.session` | `{sessionId}` → 单会话成本视图（底栏用；不触发全量重算） |
| `organizer.cost.status` | 成本数据源是否可用、走的是哪一个、缓存文件路径、触发器状态（`watcher: {debounceMs, sweepMs, active, dirty}`） |

## 限制

- 子代理（`origin: subagent`）会话不支持跨工作区移动。
- 尚未落盘的空白会话没有档案，跨区移动会报错；删除会退化为「仅移除注册」。
- 文件夹内的「新建会话」暂未提供（工作区行上的新建会话按钮保留）；在文件夹里新建会话需要先
  建会话再写归属，本版不做。
- 接管后的树跟随官方 `sidebar.workspaces` 槽位契约；DSH 升级若改变子座位名称，相关座位会
  静默跳过（树仍可用，但可能缺某些行内按钮），日志里有 `[workspace-organizer]` 警告。
- 成本是**估算值**：价目表来自外部账单插件，第三方中转/未知模型会按其规则估算；缺失的会话一律
  标「未计价」，汇总会标「部分数据缺失」，不当作精确账单。
- 成本触发器依赖 `session/event` / `session/disposed` 事件名；宿主改名时订阅会失败并降级为
  惰性快照（`organizer.cost.status` 的 `watcher.active` 会是 `false`，功能不受影响，只是少了后台预热）。

## 开发

```bash
npm run check   # 语法 + 导入检查
npm test        # 依次直接运行 test/*.test.mjs（不依赖 node --test）
node test/ui-tree.test.mjs    # 侧边栏树 + 文件夹 + 拖拽 + 成本小计/工作区总计/底栏徽章 + 降级/卸载的 UI 冒烟
```

`test/ui-tree.test.mjs` 需要 `react` / `react-test-renderer`，仓库不附带（见 [CONTRIBUTING.md](CONTRIBUTING.md) 的安装方式）。

无构建步骤：`client.js` 是单文件 Client half，`src/*.mjs` 是纯 ESM Host half。
`src/folders.mjs` 是文件夹数据层（sidecar + 规范化 + 原子写），`src/host.mjs` 负责会话档案的物理动作，
`src/cost.mjs` 是成本聚合（外部成本源适配 + 统一会话级缓存 + 文件夹/工作区求和 + 水位增量 + 缓存落盘）。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

请不要公开提安全问题，按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)。本插件部分实现衍生于 DeepSeek Harness 客户端（MIT），第三方归属声明见 [NOTICE](NOTICE)。
