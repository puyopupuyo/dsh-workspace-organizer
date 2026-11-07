/**
 * dsh-workspace-organizer — 文件夹总计花费（成本聚合）数据层。
 *
 * 定位（用户拍板）：
 *   - **不自己采集 token、不自己实现计价**：会话级成本复用外部数据源；
 *   - 文件夹成员只通过 `getSessionsInFolder(folderId)` 拿，绝不由 DOM/侧边栏反查；
 *   - 只做「按归属求和 + 按会话日志水位增量更新 + 给 UI 一份快照」。
 *
 * 数据源优先级（第一个可用的胜出）：
 *   1. dsh-workspace-hub 的 `/api/wsfm/cost` + `/api/wsfm/tokens`（需显式配置 base URL）；
 *   2. **会话投影缓存** `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`：
 *      `record.rows.cacheBilling.val.totals` 是 meow-cachebilling 已经算好的
 *      会话累计花费（峰谷/一口价都在里面），`record.rows.tokenUsage.val.totals`
 *      是 DSH 原生 token-meter 投影的 token 总量；`rows.subagent` 标记子代理会话；
 *   3. meow-cachebilling 的历史账本 `$DSH_HOME/storages/meow_cachebilling.json`
 *      （`tables.sessions[<recordId>].steps[].c` 逐轮求和）。
 *   合并成一条本地成本缓存 `folder-cost-rollups.json`，与 `folders.v1.json` **分开写**：
 *   归属是低频写入，成本是高频刷新，互不拖累。
 *
 * 失效判定用**会话日志水位**（mtime + size）加投影缓存水位；两者都没动就直接复用
 * 缓存里的 cost，不再问数据源。水位不变的会话绝不重复取成本。
 */
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, errorMessage, dshHome, pluginDataDir } from './util.mjs';

/** 成本缓存文件名（与 folders.v1.json 分离）。 */
export const COST_FILE = 'folder-cost-rollups.json';

/** 成本缓存结构版本（v2 起有统一的会话级缓存 + 工作区汇总）。 */
export const COST_VERSION = 2;

/** 万元级别以上的和自动收敛到 6 位小数，避免浮点噪声进 UI。 */
function money(value) {
  return Math.round(value * 1e6) / 1e6;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 成本缓存绝对路径。 */
export function costFilePath(env = process.env) {
  return join(pluginDataDir(env), COST_FILE);
}

/** 空状态。 */
export function emptyCostState() {
  return { version: COST_VERSION, sessions: {}, workspaces: {}, rollups: {} };
}

/** 投影缓存目录。 */
export function projectionDir(env = process.env) {
  return join(dshHome(env), 'storages', 'session_projcache', 'sessions');
}

/** meow-cachebilling 历史账本。 */
export function meowBillingPath(env = process.env) {
  return join(dshHome(env), 'storages', 'meow_cachebilling.json');
}

/** 文件水位（不存在时给空水位，调用方据此判定“无日志”）。 */
function statOf(path) {
  try {
    const stat = statSync(path);
    return { mtime: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

// #region 数据源：会话投影缓存 / 喵账单历史账本
/**
 * 从 meow-cachebilling 的 projection 结果里取出累计花费与 token 总量。
 * 只读它在磁盘上的**公开产物**，不 import 它的内部函数、不复算单价。
 */
function readProjectionSession(dir, sessionId) {
  const path = join(dir, `${sessionId}.json`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const rows = parsed?.record?.rows;
  if (!isPlainObject(rows)) return undefined;

  const billing = rows.cacheBilling?.val;
  let cost;
  if (isPlainObject(billing)) {
    const totals = billing.totals;
    if (isPlainObject(totals)) {
      cost = money(num(totals.cacheHitCost) + num(totals.missCost) + num(totals.outputCost));
    }
    // 压缩换代会留下上一代的逐轮账；有就补上，避免总计少一段。
    const previous = billing.prevGen;
    if (isPlainObject(previous) && Array.isArray(previous.steps)) {
      let extra = 0;
      for (const step of previous.steps) extra += num(step?.c);
      if (extra > 0) cost = money((cost ?? 0) + extra);
    }
  }

  let tokens;
  const usage = rows.tokenUsage?.val?.totals;
  if (isPlainObject(usage)) {
    tokens =
      num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens);
  } else if (cost !== undefined) {
    // 投影里没有 tokenUsage 时退回 cacheBilling 的计数（同一份用量）。
    const totals = billing?.totals;
    if (isPlainObject(totals)) {
      tokens = num(totals.inputTokens) + num(totals.cacheReadTokens) + num(totals.outputTokens);
    }
  }

  const identity = rows.subagent?.val?.identity;
  return {
    cost,
    tokens,
    subagent: identity !== undefined && identity !== null
  };
}

/** 读一次喵账单历史账本（按 mtime 缓存，避免反复解析同一份大 JSON）。 */
function makeMeowReader(path, logger) {
  let cached = { mtime: -1, table: null };
  return function meowRows(sessionId) {
    const stamp = statOf(path);
    if (stamp === undefined) return undefined;
    if (cached.table === null || cached.mtime !== stamp.mtime) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        cached = { mtime: stamp.mtime, table: isPlainObject(parsed?.tables?.sessions) ? parsed.tables.sessions : {} };
      } catch (error) {
        logger?.warn?.(`workspace-organizer: 喵账单历史账本解析失败，成本按缺失处理: ${errorMessage(error)}`);
        cached = { mtime: stamp.mtime, table: {} };
      }
    }
    const table = cached.table;
    if (table === null) return undefined;
    let cost = 0;
    let found = false;
    for (const key of Object.keys(table)) {
      // recordId 可能是 `<sessionId>` 或 `<sessionId>#<gen>`（压缩换代）。
      const base = key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : key;
      if (base !== sessionId) continue;
      const steps = table[key]?.steps;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) cost += num(step?.c);
      found = true;
    }
    return found ? money(cost) : undefined;
  };
}

/**
 * 会话投影缓存数据源（本机默认走它）。
 * `readSession` 返回 `{ cost, tokens, subagent }`；`cost === undefined` 表示“查不到成本”。
 */
export function createProjectionCostSource({ env = process.env, logger = console } = {}) {
  const dir = projectionDir(env);
  const billingPath = meowBillingPath(env);
  const meowRows = makeMeowReader(billingPath, logger);

  return {
    id: 'projcache',
    label: '会话投影缓存（喵账单 · 原生 token-meter）',
    estimated: true,
    available: existsSync(dir) || existsSync(billingPath),
    /** 投影缓存文件水位：它一变，成本可能就变了。 */
    stamp(sessionId) {
      const stamp = statOf(join(dir, `${sessionId}.json`));
      return stamp === undefined ? { srcMtime: 0, srcSize: 0 } : { srcMtime: stamp.mtime, srcSize: stamp.size };
    },
    readSession(sessionId) {
      const projection = readProjectionSession(dir, sessionId);
      if (projection !== undefined && projection.cost !== undefined) return projection;
      const meowCost = meowRows(sessionId);
      if (meowCost !== undefined) {
        return {
          cost: meowCost,
          tokens: projection?.tokens,
          subagent: projection?.subagent === true
        };
      }
      return { cost: undefined, tokens: projection?.tokens, subagent: projection?.subagent === true };
    }
  };
}

/**
 * dsh-workspace-hub 数据源（可选，最高优先级）。
 *
 * 只有显式给出 baseUrl（配置或环境变量 `DSH_WSFM_BASE`）才会启用；它的
 * `/api/wsfm/cost` 与 `/api/wsfm/tokens` 自带会话日志水位校验，我们直接采用。
 */
export function createHubCostSource({ baseUrl, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  const call = async (path, sessionId) => {
    if (typeof fetchImpl !== 'function') return undefined;
    try {
      const response = await fetchImpl(`${base}${path}?sessionId=${encodeURIComponent(sessionId)}`);
      if (response === undefined || response === null || response.ok === false) return undefined;
      return await response.json();
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 成本服务请求失败（${path}）: ${errorMessage(error)}`);
      return undefined;
    }
  };
  return {
    id: 'wshub',
    label: `dsh-workspace-hub（${base}）`,
    estimated: true,
    available: base !== '' && typeof fetchImpl === 'function',
    stamp() {
      return { srcMtime: 0, srcSize: 0 };
    },
    async readSession(sessionId) {
      const cost = await call('/api/wsfm/cost', sessionId);
      const tokens = await call('/api/wsfm/tokens', sessionId);
      const value = num(cost?.cost ?? cost?.totalCost);
      return {
        cost: Number.isFinite(cost?.cost ?? cost?.totalCost) ? money(value) : undefined,
        tokens: Number.isFinite(tokens?.tokens ?? tokens?.totalTokens) ? num(tokens?.tokens ?? tokens?.totalTokens) : undefined,
        subagent: cost?.subagent === true || tokens?.subagent === true
      };
    }
  };
}

/** 依优先级挑一个可用数据源；一个都没有时返回不可用占位（不抛）。 */
export function resolveCostSource({ env = process.env, logger = console, fetchImpl } = {}) {
  const hubBase = typeof env.DSH_WSFM_BASE === 'string' ? env.DSH_WSFM_BASE.trim() : '';
  if (hubBase !== '') {
    const hub = createHubCostSource({ baseUrl: hubBase, fetchImpl, logger });
    if (hub.available) return hub;
  }
  const projection = createProjectionCostSource({ env, logger });
  if (projection.available) return projection;
  return { id: 'none', label: '无', estimated: true, available: false, stamp: () => ({}), readSession: () => undefined };
}
// #endregion

// #region 缓存
/** 把持久化的单会话水位/成本收敛成合法 mark；坏数据返回 undefined。 */
function normalizeMark(raw) {
  if (!isPlainObject(raw)) return undefined;
  return {
    logMtime: num(raw.logMtime),
    logSize: num(raw.logSize),
    srcMtime: num(raw.srcMtime),
    srcSize: num(raw.srcSize),
    cost: Number.isFinite(raw.cost) ? num(raw.cost) : undefined,
    tokens: Number.isFinite(raw.tokens) ? num(raw.tokens) : undefined,
    subagent: raw.subagent === true,
    missing: raw.missing === true || !Number.isFinite(raw.cost)
  };
}

/** 把持久化原文收敛成合法状态；坏数据整段丢弃（这是一份缓存，丢得起）。 */
export function normalizeCostState(raw) {
  const state = emptyCostState();
  if (!isPlainObject(raw)) return state;

  // v2：统一的会话级缓存（文件夹/工作区/底栏都从它求和或读取）。
  const rawSessions = isPlainObject(raw.sessions) ? raw.sessions : {};
  for (const sessionId of Object.keys(rawSessions)) {
    const mark = normalizeMark(rawSessions[sessionId]);
    if (mark !== undefined) state.sessions[sessionId] = mark;
  }

  const rollups = isPlainObject(raw.rollups) ? raw.rollups : {};
  for (const folderId of Object.keys(rollups)) {
    const item = rollups[folderId];
    if (!isPlainObject(item)) continue;
    const watermarks = {};
    if (isPlainObject(item.sessionWatermarks)) {
      for (const sessionId of Object.keys(item.sessionWatermarks)) {
        const mark = normalizeMark(item.sessionWatermarks[sessionId]);
        if (mark === undefined) continue;
        watermarks[sessionId] = mark;
        // v1 → v2 迁移：旧缓存只把成本记在文件夹里，回填到会话级缓存，
        // 这样升级后不必把所有会话重读一遍数据源。
        if (state.sessions[sessionId] === undefined) state.sessions[sessionId] = { ...mark };
      }
    }
    state.rollups[folderId] = {
      folderId,
      totalCost: num(item.totalCost),
      totalTokens: num(item.totalTokens),
      sessionCount: num(item.sessionCount),
      lastComputedAt: typeof item.lastComputedAt === 'string' ? item.lastComputedAt : '',
      sessionWatermarks: watermarks
    };
  }

  const workspaces = isPlainObject(raw.workspaces) ? raw.workspaces : {};
  for (const workspaceId of Object.keys(workspaces)) {
    const item = workspaces[workspaceId];
    if (!isPlainObject(item)) continue;
    state.workspaces[workspaceId] = {
      workspaceId,
      totalCost: num(item.totalCost),
      totalTokens: num(item.totalTokens),
      sessionCount: num(item.sessionCount),
      missingCount: num(item.missingCount),
      subagentCost: num(item.subagentCost),
      sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : [],
      lastComputedAt: typeof item.lastComputedAt === 'string' ? item.lastComputedAt : ''
    };
  }
  return state;
}

function sameStamp(mark, stamp) {
  return (
    mark !== undefined &&
    mark.logMtime === stamp.logMtime &&
    mark.logSize === stamp.logSize &&
    mark.srcMtime === stamp.srcMtime &&
    mark.srcSize === stamp.srcSize
  );
}

/**
 * 建立绑定当前插件实例的成本聚合门面。
 *
 * 注入口（全部可替换，便于测试）：
 *   - source：成本数据源（见上）；
 *   - sessionIdsOfFolder(folderId)：等价于 getSessionsInFolder；
 *   - foldersOfSession(sessionId)：来自 membershipStore 的 sessionToFolderIndex；
 *   - folderIds()：当前全部文件夹 ID；
 *   - sessionIdsOfWorkspace(workspaceId) / workspaceIds()：工作区成员（Host 侧）；
 *   - workspacesOfSession(sessionId)：会话归属的工作区（成员变化时定位重算对象）；
 *   - stampOf(sessionIds)：批量取会话日志水位（Host 侧实现）。
 *
 * 三种展示（文件夹小计 / 工作区总计 / 底栏会话花费）**共用同一份会话级缓存**
 * （state.sessions）：成本只按会话读一次，汇总都只是求和。
 */
export function createCostRollups(options = {}) {
  const {
    env = process.env,
    logger = console,
    source = resolveCostSource({ env, logger }),
    sessionIdsOfFolder = () => [],
    foldersOfSession = () => [],
    folderIds = () => [],
    sessionIdsOfWorkspace = () => [],
    workspaceIds = () => [],
    workspacesOfSession = () => [],
    stampOf = async () => ({}),
    now = () => Date.now()
  } = options;

  const filePath = () => costFilePath(env);
  let cache = null;
  let chain = Promise.resolve();

  function readState() {
    const path = filePath();
    if (!existsSync(path)) return emptyCostState();
    try {
      const text = readFileSync(path, 'utf8');
      if (text.trim() === '') return emptyCostState();
      return normalizeCostState(JSON.parse(text));
    } catch (error) {
      // 缓存损坏直接重建；旧文件留档便于排查。
      const target = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, target);
      } catch {
        /* 留档失败无妨，反正是缓存 */
      }
      logger?.warn?.(`workspace-organizer: 成本缓存损坏，已重建: ${errorMessage(error)}`);
      return emptyCostState();
    }
  }

  async function ensureLoaded() {
    if (cache === null) cache = readState();
    return cache;
  }

  async function persist(state) {
    const payload = {
      version: COST_VERSION,
      updatedAt: new Date().toISOString(),
      rollups: state.rollups
    };
    await atomicWrite(filePath(), Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
  }

  /** 写回只在有变化时发生，且串行，避免两个快照互相盖掉。 */
  function withLock(operation) {
    const task = chain.then(operation, operation);
    chain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /**
   * 落盘失败只报警一次/分钟：成本缓存写不进去时界面照样能用（内存里有值），
   * 但每 1.2 秒刷新一次日志会把控制台刷爆。
   */
  let lastPersistWarnAt = 0;
  function warnPersist(error) {
    const nowMs = now();
    if (nowMs - lastPersistWarnAt < 60_000) return;
    lastPersistWarnAt = nowMs;
    logger?.warn?.(`workspace-organizer: 成本缓存写入失败（当前会话内继续用内存值）: ${errorMessage(error)}`);
  }

  /** 一个 rollup 的 UI 视图（含逐会话明细）。 */
  function viewOf(rollup) {
    const sessions = [];
    for (const sessionId of Object.keys(rollup.sessionWatermarks)) {
      const mark = rollup.sessionWatermarks[sessionId];
      sessions.push({
        sessionId,
        cost: mark.missing === true ? undefined : mark.cost,
        tokens: mark.tokens,
        subagent: mark.subagent === true,
        missing: mark.missing === true
      });
    }
    return {
      folderId: rollup.folderId,
      sessionCount: rollup.sessionCount,
      totalCost: rollup.totalCost,
      totalTokens: rollup.totalTokens,
      missingCount: sessions.filter((item) => item.missing).length,
      subagentCost: money(sessions.reduce((sum, item) => sum + (item.subagent === true ? num(item.cost) : 0), 0)),
      lastComputedAt: rollup.lastComputedAt,
      sessions
    };
  }

  /** 一个工作区 rollup 的 UI 视图。 */
  function viewOfWorkspace(rollup) {
    return {
      workspaceId: rollup.workspaceId,
      sessionCount: rollup.sessionCount,
      totalCost: rollup.totalCost,
      totalTokens: rollup.totalTokens,
      missingCount: rollup.missingCount,
      subagentCost: rollup.subagentCost,
      lastComputedAt: rollup.lastComputedAt,
      sessionIds: rollup.sessionIds
    };
  }

  /** 单会话的 UI 视图（底栏徽章直接读它）。 */
  function viewOfSession(sessionId, mark) {
    return {
      sessionId,
      cost: mark.missing === true ? undefined : mark.cost,
      tokens: mark.tokens,
      subagent: mark.subagent === true,
      missing: mark.missing === true
    };
  }

  /** 批量取会话日志水位；失败只记日志（成本按缺失处理）。 */
  async function stampsFor(sessionIds) {
    try {
      return (await stampOf(sessionIds)) ?? {};
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 会话日志水位读取失败，本次按缺失处理: ${errorMessage(error)}`);
      return {};
    }
  }

  /**
   * 保证某个会话在**统一的会话级缓存**里是最新的。
   *
   * 文件夹小计、工作区总计、底栏徽章都只经过这一个函数：水位没变就复用
   * 缓存，变了才问数据源。这就是「三处花费共用同一份计算逻辑」的落点。
   */
  async function ensureSessionCost(state, sessionId, stamps, options = {}) {
    const logStamp = (stamps ?? {})[sessionId] ?? {};
    const srcStamp = typeof source.stamp === 'function' ? source.stamp(sessionId) ?? {} : {};
    const stamp = {
      logMtime: num(logStamp.logMtime),
      logSize: num(logStamp.logSize),
      srcMtime: num(srcStamp.srcMtime),
      srcSize: num(srcStamp.srcSize)
    };
    const cached = state.sessions[sessionId];
    if (options.force !== true && sameStamp(cached, stamp)) return cached;
    let read;
    try {
      read = await source.readSession(sessionId);
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 会话 ${sessionId} 成本读取失败: ${errorMessage(error)}`);
      read = undefined;
    }
    const cost = Number.isFinite(read?.cost) ? money(read.cost) : undefined;
    const mark = {
      ...stamp,
      cost,
      tokens: Number.isFinite(read?.tokens) ? num(read.tokens) : undefined,
      subagent: read?.subagent === true,
      missing: cost === undefined
    };
    state.sessions[sessionId] = mark;
    return mark;
  }

  /**
   * 重算一个文件夹的**内存内**实现（调用方必须已持有串行锁）。
   * 逐会话比对日志水位：没变就复用缓存 cost，不打扰数据源。
   */
  async function computeFolderInPlace(state, folderId, options = {}) {
    const id = String(folderId ?? '').trim();
    if (id === '') return undefined;
    const sessionIds = (sessionIdsOfFolder(id) ?? []).map(String);

    if (source.available !== true) {
      return { folderId: id, available: false, reason: '成本数据源不可用', sessions: [], sessionCount: sessionIds.length };
    }

    const stamps = await stampsFor(sessionIds);
    const watermarks = {};
    let totalCost = 0;
    let totalTokens = 0;
    for (const sessionId of sessionIds) {
      const mark = await ensureSessionCost(state, sessionId, stamps, options);
      watermarks[sessionId] = { ...mark };
      if (mark.missing !== true) totalCost += num(mark.cost);
      totalTokens += num(mark.tokens);
    }

    const rollup = {
      folderId: id,
      totalCost: money(totalCost),
      totalTokens,
      sessionCount: sessionIds.length,
      lastComputedAt: new Date(now()).toISOString(),
      sessionWatermarks: watermarks
    };
    state.rollups[id] = rollup;
    return { ...viewOf(rollup), available: true };
  }

  /**
   * 重算一个工作区的**内存内**实现（调用方必须已持有串行锁）。
   *
   * 成员来自工作区记账（含未收纳、已归档会话），成本来自统一的会话级缓存；
   * 这里只做求和，不产生第二套计算逻辑。
   */
  async function computeWorkspaceInPlace(state, workspaceId, options = {}) {
    const id = String(workspaceId ?? '').trim();
    if (id === '') return undefined;
    const sessionIds = (sessionIdsOfWorkspace(id) ?? []).map(String);
    const previous = state.workspaces[id];

    if (source.available !== true) {
      return {
        workspaceId: id,
        available: false,
        reason: '成本数据源不可用',
        sessionCount: sessionIds.length,
        sessionIds,
        ...(previous === undefined ? {} : { totalCost: previous.totalCost })
      };
    }

    const stamps = await stampsFor(sessionIds);
    let totalCost = 0;
    let totalTokens = 0;
    let missingCount = 0;
    let subagentCost = 0;
    for (const sessionId of sessionIds) {
      const mark = await ensureSessionCost(state, sessionId, stamps, options);
      totalTokens += num(mark.tokens);
      if (mark.missing === true) {
        missingCount += 1;
        continue;
      }
      totalCost += num(mark.cost);
      if (mark.subagent === true) subagentCost += num(mark.cost);
    }

    const rollup = {
      workspaceId: id,
      totalCost: money(totalCost),
      totalTokens,
      sessionCount: sessionIds.length,
      missingCount,
      subagentCost: money(subagentCost),
      sessionIds,
      lastComputedAt: new Date(now()).toISOString()
    };
    state.workspaces[id] = rollup;
    return { ...viewOfWorkspace(rollup), available: true };
  }

  /**
   * 重算一个文件夹：逐会话比对日志水位，没变就复用缓存 cost。
   * @param {string} folderId
   * @param {object} [options] `force: true` 无视缓存；`persist: false` 由调用方统一落盘
   */
  async function recomputeFolder(folderId, options = {}) {
    if (String(folderId ?? '').trim() === '') return undefined;
    return await withLock(async () => {
      const state = await ensureLoaded();
      const view = await computeFolderInPlace(state, folderId, options);
      if (options.persist !== false) {
        try {
          await persist(state);
        } catch (error) {
          warnPersist(error);
        }
      }
      return view;
    });
  }

  /** 批量重算（锁内一次写盘）：会话被移出/删除后刷新它原来所在的文件夹。 */
  async function recomputeFolders(folderIdsToRefresh) {
    const ids = [...new Set((folderIdsToRefresh ?? []).map(String))];
    if (ids.length === 0) return { folders: [] };
    return await withLock(async () => {
      const state = await ensureLoaded();
      const done = [];
      for (const folderId of ids) {
        const view = await computeFolderInPlace(state, folderId, { persist: false });
        if (view !== undefined && view.available === true) done.push(folderId);
      }
      if (done.length > 0) {
        try {
          await persist(state);
        } catch (error) {
          warnPersist(error);
        }
      }
      return { folders: done };
    });
  }

  /**
   * 重算一个工作区：成员来自工作区记账，成本来自统一的会话级缓存。
   * 触发时机与 recomputeFolder 完全一致（成员变化 / 归档 / 删除 / 水位变化）。
   * @param {string} workspaceId
   * @param {object} [options] `force: true` 无视缓存；`persist: false` 由调用方统一落盘
   */
  async function recomputeWorkspace(workspaceId, options = {}) {
    if (String(workspaceId ?? '').trim() === '') return undefined;
    return await withLock(async () => {
      const state = await ensureLoaded();
      const view = await computeWorkspaceInPlace(state, workspaceId, options);
      if (options.persist !== false) {
        try {
          await persist(state);
        } catch (error) {
          warnPersist(error);
        }
      }
      return view;
    });
  }

  /** 批量重算工作区（锁内一次写盘）：成员变化后只刷受影响的那些。 */
  async function recomputeWorkspaces(workspaceIdsToRefresh) {
    const ids = [...new Set((workspaceIdsToRefresh ?? []).map(String))];
    if (ids.length === 0) return { workspaces: [] };
    return await withLock(async () => {
      const state = await ensureLoaded();
      const done = [];
      for (const workspaceId of ids) {
        const view = await computeWorkspaceInPlace(state, workspaceId, { persist: false });
        if (view !== undefined && view.available === true) done.push(workspaceId);
      }
      if (done.length > 0) {
        try {
          await persist(state);
        } catch (error) {
          warnPersist(error);
        }
      }
      return { workspaces: done };
    });
  }

  /** 重算全部工作区（会话被删/恢复后无法反查归属时用；只求和，不开销数据源）。 */
  async function recomputeAllWorkspaces() {
    let ids = [];
    try {
      ids = (workspaceIds() ?? []).map(String);
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 工作区列表读取失败: ${errorMessage(error)}`);
      return { workspaces: [] };
    }
    return await recomputeWorkspaces(ids);
  }

  /** 所有成员会话（文件夹 + 工作区，去重；只收集 ID，不做任何重算）。 */
  function collectMemberSessions() {
    const out = new Set();
    let ids = [];
    try {
      ids = (folderIds() ?? []).map(String);
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 文件夹列表读取失败: ${errorMessage(error)}`);
      ids = [];
    }
    for (const folderId of ids) {
      let members = [];
      try {
        members = (sessionIdsOfFolder(folderId) ?? []).map(String);
      } catch {
        members = [];
      }
      for (const sessionId of members) out.add(sessionId);
    }
    let workspaceIdsList = [];
    try {
      workspaceIdsList = (workspaceIds() ?? []).map(String);
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 工作区列表读取失败: ${errorMessage(error)}`);
      workspaceIdsList = [];
    }
    for (const workspaceId of workspaceIdsList) {
      let members = [];
      try {
        members = (sessionIdsOfWorkspace(workspaceId) ?? []).map(String);
      } catch {
        members = [];
      }
      for (const sessionId of members) out.add(sessionId);
    }
    return [...out];
  }

  /**
   * 批量水位检查（M4）：把「多次变更」合并成一次，之后**只重算有变化的
   * 文件夹与工作区**。
   *
   * - 不给 `sessionIds` 时检查全部成员会话（文件夹 + 工作区，定时兜底）；
   * - 给了就只检查这些会话（事件驱动，如 `session/event` 触发的脏集合）；
   * - 没有会话级缓存记录、没有变化的会话都直接跳过，不读数据源、不写盘。
   * @returns {Promise<{ changed: string[], workspaces: string[], checked: number }>}
   */
  async function poll(sessionIds) {
    if (source.available !== true) return { changed: [], workspaces: [], checked: 0 };
    return await withLock(async () => {
      const state = await ensureLoaded();
      const wanted =
        Array.isArray(sessionIds) && sessionIds.length > 0
          ? [...new Set(sessionIds.map(String))]
          : collectMemberSessions();
      if (wanted.length === 0) return { changed: [], workspaces: [], checked: 0 };

      // 只比对**已经有会话级缓存**的会话：没算过的交给 snapshot 首次计算。
      const known = [];
      for (const sessionId of wanted) {
        let folders = [];
        let workspaces = [];
        try {
          folders = (foldersOfSession(sessionId) ?? []).map(String);
        } catch {
          folders = [];
        }
        try {
          workspaces = (workspacesOfSession(sessionId) ?? []).map(String);
        } catch {
          workspaces = [];
        }
        if (state.sessions[sessionId] !== undefined) known.push({ sessionId, folders, workspaces });
      }
      if (known.length === 0) return { changed: [], workspaces: [], checked: 0 };

      const stamps = await stampsFor(known.map((item) => item.sessionId));
      const dirtySessions = [];
      const dirtyFolders = new Set();
      const dirtyWorkspaces = new Set();
      for (const { sessionId, folders, workspaces } of known) {
        const logStamp = stamps[sessionId] ?? {};
        const srcStamp = typeof source.stamp === 'function' ? source.stamp(sessionId) ?? {} : {};
        const stamp = {
          logMtime: num(logStamp.logMtime),
          logSize: num(logStamp.logSize),
          srcMtime: num(srcStamp.srcMtime),
          srcSize: num(srcStamp.srcSize)
        };
        if (sameStamp(state.sessions[sessionId], stamp)) continue;
        dirtySessions.push(sessionId);
        for (const folderId of folders) dirtyFolders.add(folderId);
        for (const workspaceId of workspaces) dirtyWorkspaces.add(workspaceId);
      }
      if (dirtySessions.length === 0) return { changed: [], workspaces: [], checked: known.length };

      // 先刷新会话级缓存（底栏也读这一份），再重算受影响的汇总。
      for (const sessionId of dirtySessions) await ensureSessionCost(state, sessionId, stamps, {});
      for (const folderId of dirtyFolders) await computeFolderInPlace(state, folderId, { persist: false });
      for (const workspaceId of dirtyWorkspaces) await computeWorkspaceInPlace(state, workspaceId, { persist: false });
      try {
        await persist(state);
      } catch (error) {
        warnPersist(error);
      }
      return { changed: [...dirtyFolders], workspaces: [...dirtyWorkspaces], checked: known.length };
    });
  }

  /**
   * 全量快照：对每个文件夹与工作区做**增量**重算（只读水位变了的会话）。
   * UI 每次拿它刷新；没有变化的汇总不会产生任何数据源读取。
   *
   * `options.sessionIds`：额外确保这些会话在会话级缓存里（底栏当前会话即使
   * 没被收纳进文件夹也要有成本可读）。同样遵守水位增量，不会重复读数。
   */
  async function snapshot(options = {}) {
    if (source.available !== true) {
      return {
        available: false,
        source: source.id,
        reason: '未找到可用的会话级成本数据源',
        estimated: true,
        folders: {},
        workspaces: {},
        sessions: {}
      };
    }
    let ids = [];
    try {
      ids = (folderIds() ?? []).map(String);
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 文件夹列表读取失败: ${errorMessage(error)}`);
      ids = [];
    }
    let wids = [];
    try {
      wids = (workspaceIds() ?? []).map(String);
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 工作区列表读取失败: ${errorMessage(error)}`);
      wids = [];
    }
    const focused = Array.isArray(options.sessionIds)
      ? [...new Set(options.sessionIds.map(String).filter((sessionId) => sessionId !== ''))]
      : [];
    return await withLock(async () => {
      const state = await ensureLoaded();
      const folders = {};
      let dirty = false;
      for (const folderId of ids) {
        const before = state.rollups[folderId];
        const beforeJson = before === undefined ? '' : JSON.stringify(before);
        const view = await computeFolderInPlace(state, folderId, { persist: false });
        if (view === undefined || view.available !== true) continue;
        const after = state.rollups[folderId];
        if (after !== undefined && JSON.stringify(after) !== beforeJson) dirty = true;
        folders[folderId] = view;
      }
      const workspaces = {};
      for (const workspaceId of wids) {
        const before = state.workspaces[workspaceId];
        const beforeJson = before === undefined ? '' : JSON.stringify(before);
        const view = await computeWorkspaceInPlace(state, workspaceId, { persist: false });
        if (view === undefined || view.available !== true) continue;
        const after = state.workspaces[workspaceId];
        if (after !== undefined && JSON.stringify(after) !== beforeJson) dirty = true;
        workspaces[workspaceId] = view;
      }
      if (focused.length > 0) {
        const stamps = await stampsFor(focused);
        for (const sessionId of focused) {
          const before = state.sessions[sessionId];
          const beforeJson = before === undefined ? '' : JSON.stringify(before);
          await ensureSessionCost(state, sessionId, stamps, {});
          if (JSON.stringify(state.sessions[sessionId]) !== beforeJson) dirty = true;
        }
      }
      if (dirty) {
        try {
          await persist(state);
        } catch (error) {
          warnPersist(error);
        }
      }
      const sessions = {};
      for (const sessionId of Object.keys(state.sessions)) {
        sessions[sessionId] = viewOfSession(sessionId, state.sessions[sessionId]);
      }
      return {
        available: true,
        source: source.id,
        label: source.label,
        estimated: source.estimated !== false,
        folders,
        workspaces,
        sessions
      };
    });
  }

  /**
   * 某个会话的成本/归属变了（新增/移出/删除/归档）→ 只重算包含它的
   * 文件夹**与工作区**，两处汇总在同一把锁里更新，不会出现割裂。
   */
  async function invalidateSessions(sessionIds) {
    const affectedFolders = new Set();
    const affectedWorkspaces = new Set();
    for (const raw of sessionIds ?? []) {
      const sessionId = String(raw);
      let folders = [];
      try {
        folders = foldersOfSession(sessionId) ?? [];
      } catch {
        folders = [];
      }
      for (const folderId of folders) affectedFolders.add(String(folderId));
      let workspaces = [];
      try {
        workspaces = workspacesOfSession(sessionId) ?? [];
      } catch {
        workspaces = [];
      }
      for (const workspaceId of workspaces) affectedWorkspaces.add(String(workspaceId));
    }
    const folders = await recomputeFolders([...affectedFolders]);
    const workspaces = await recomputeWorkspaces([...affectedWorkspaces]);
    return { folders: folders.folders, workspaces: workspaces.workspaces };
  }

  /** 只读：某文件夹上一次算好的结果（不触发重算）。 */
  async function peekFolder(folderId) {
    const state = await ensureLoaded();
    const rollup = state.rollups[String(folderId ?? '')];
    return rollup === undefined ? undefined : { ...viewOf(rollup), available: true };
  }

  /** 只读：某工作区上一次算好的结果（不触发重算）。 */
  async function peekWorkspace(workspaceId) {
    const state = await ensureLoaded();
    const rollup = state.workspaces[String(workspaceId ?? '')];
    return rollup === undefined ? undefined : { ...viewOfWorkspace(rollup), available: true };
  }

  /** 只读：某会话上一次算好的成本（底栏徽章读它，不触发重算）。 */
  async function peekSession(sessionId) {
    const state = await ensureLoaded();
    const mark = state.sessions[String(sessionId ?? '')];
    return mark === undefined ? undefined : { ...viewOfSession(String(sessionId), mark), available: true };
  }

  return {
    file: filePath,
    source,
    warm: ensureLoaded,
    recomputeFolder,
    recomputeFolders,
    recomputeWorkspace,
    recomputeWorkspaces,
    recomputeAllWorkspaces,
    poll,
    snapshot,
    invalidateSessions,
    peekFolder,
    peekWorkspace,
    peekSession
  };
}
// #endregion
