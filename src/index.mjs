/**
 * dsh-workspace-organizer — Host 入口。
 *
 * 通过 `connection.rpc.handle(CHANNEL, dispatch, { authority: 'loopback' })`
 * 暴露一组只对回环连接开放的端点；Client 半用
 * `ctx.connection.rpc.call(CHANNEL, endpoint, payload)` 调用。
 *
 * 这里刻意**不**注册任何 agent 工具，也不往 webServer 挂裸 HTTP 路由：
 * 破坏性操作只允许从本机 UI 触发。
 */
import { CHANNEL, NAME, codedError, errorMessage } from './util.mjs';
import { createHost } from './host.mjs';
import { createFolderStore, foldersOfSession, getSessionsInFolder, registerFolderStore } from './folders.mjs';
import { createCostRollups, resolveCostSource } from './cost.mjs';

export const name = NAME;

/** 只读分组接口：某文件夹下所有 Session ID（供成本聚合等模块直接调用）。 */
export { getSessionsInFolder };

/** 需要的 Host 服务；任一缺失时 fiber 挂起而不是半装载。 */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents', 'connection', 'webServer'];

/** 成本事件触发的合并窗口：2 秒内的多次会话事件合成一次批量水位检查。 */
export const COST_DEBOUNCE_MS = 2000;

/** 成本定时兜底间隔：只为覆盖「事件没送达」的情况，不是全量重算。 */
export const COST_SWEEP_MS = 60_000;

const ok = (value) => ({ ok: true, value });

function fail(code, message, details = {}) {
  return {
    ok: false,
    error: {
      code: typeof code === 'string' && code !== '' ? code : 'internal-error',
      message: typeof message === 'string' && message !== '' ? message : '未知错误',
      details
    }
  };
}

/** 把任意异常映射成稳定的错误码，Client 据此决定提示与是否回滚 UI。 */
function mapError(error) {
  const message = errorMessage(error);
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9-]*$/.test(error.code) ? error.code : undefined;
  if (code !== undefined) return fail(code, message, error?.details ?? {});
  if (/不存在|not found|no such/i.test(message)) return fail('not-found', message);
  if (/正在运行|busy|占用/i.test(message)) return fail('busy', message);
  if (/已存在|拒绝覆盖|conflict/i.test(message)) return fail('conflict', message);
  if (/备份失败|backup failed/i.test(message)) return fail('backup-failed', message);
  if (/回滚|rollback/i.test(message)) return fail('rollback-failed', message);
  if (/不合法|invalid|必填|required/i.test(message)) return fail('invalid-input', message);
  if (/不支持|unsupported|未提供/i.test(message)) return fail('unsupported', message);
  return fail('internal-error', message);
}

/** 参数必须是普通对象。 */
function bodyOf(payload) {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw codedError('invalid-input', '请求参数必须是对象');
  return payload;
}

function requireString(payload, key) {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') throw codedError('invalid-input', `${key} 必填`);
  return value.trim();
}

/**
 * 建立 RPC 派发器。
 * @param {object} ctx
 * @param {ReturnType<typeof createHost>} host
 * @param {ReturnType<typeof createFolderStore>} groups 工作区内虚拟文件夹数据门面
 */
function createDispatch(ctx, host, groups, costs, costWatcher) {
  /** 收纳校验：sessionId 必须是当前宿主认识的会话（含未落盘的空白会话）。 */
  const assertKnownSession = async (sessionId) => {
    const known = await host.knownSessionIds();
    if (!known.has(String(sessionId))) throw codedError('not-found', `会话 ${sessionId} 不存在`);
  };

  /**
   * 归属变了以后，**只**重算受影响的文件夹（成本缓存）。
   * 失败只记日志：成本是附属信息，绝不让它拖垮收纳/拖拽本身。
   */
  const refreshCosts = (sessionIds) => {
    if (costs === undefined || costs === null) return;
    Promise.resolve()
      .then(() => costs.invalidateSessions(sessionIds))
      .catch((error) => {
        ctx?.logger?.warn?.(`workspace-organizer: 文件夹成本重算失败: ${errorMessage(error)}`);
      });
  };

  /** 直接按文件夹 ID 重算（会话被删掉后反向索引已经查不到它原来在哪）。 */
  const refreshFolders = (folderIds) => {
    if (costs === undefined || costs === null) return;
    const ids = (folderIds ?? []).map(String);
    if (ids.length === 0) return;
    Promise.resolve()
      .then(() => costs.recomputeFolders(ids))
      .catch((error) => {
        ctx?.logger?.warn?.(`workspace-organizer: 文件夹成本重算失败: ${errorMessage(error)}`);
      });
  };

  /**
   * 会话已被删/恢复时无法反查它原来属于哪个工作区，只能按 ID 重算全部工作区。
   * 工作区重算只是对已缓存的会话成本求和（水位没变不读数源），开销很低。
   */
  const refreshAllWorkspaces = () => {
    if (costs === undefined || costs === null) return;
    Promise.resolve()
      .then(() => costs.recomputeAllWorkspaces())
      .catch((error) => {
        ctx?.logger?.warn?.(`workspace-organizer: 工作区成本重算失败: ${errorMessage(error)}`);
      });
  };

  return async (endpoint, rawPayload = {}, signal) => {
    if (signal?.aborted) throw codedError('cancelled', '请求已取消');
    const payload = bodyOf(rawPayload);
    switch (endpoint) {
      case 'organizer.status':
        return await host.status();
      case 'organizer.tree':
        return await host.tree();
      case 'organizer.folders.state':
        return await groups.state();
      case 'organizer.folders.create': {
        const created = await groups.createFolder({
          workspaceId: requireString(payload, 'workspaceId'),
          name: requireString(payload, 'name'),
          color: payload.color,
          icon: payload.icon
        });
        return created;
      }
      case 'organizer.folders.update': {
        const folderId = requireString(payload, 'folderId');
        const patch = {};
        if (payload.name !== undefined) patch.name = requireString(payload, 'name');
        if (Object.hasOwn(payload, 'color')) patch.color = payload.color;
        if (Object.hasOwn(payload, 'icon')) patch.icon = payload.icon;
        if (Object.hasOwn(payload, 'collapsed')) patch.collapsed = payload.collapsed === true;
        return await groups.updateFolder(folderId, patch);
      }
      case 'organizer.folders.delete': {
        const folderId = requireString(payload, 'folderId');
        // 删文件夹只删关系；成本 rollup 记录保留（重名重建可选作初值）。
        return await groups.deleteFolder(folderId);
      }
      case 'organizer.folders.add': {
        const folderId = requireString(payload, 'folderId');
        const sessionId = requireString(payload, 'sessionId');
        await assertKnownSession(sessionId);
        const beforeSessionId = typeof payload.beforeSessionId === 'string' && payload.beforeSessionId !== ''
          ? payload.beforeSessionId
          : undefined;
        const result = await groups.addToFolder(folderId, sessionId, { beforeSessionId });
        refreshCosts([sessionId]);
        return result;
      }
      case 'organizer.folders.remove': {
        const sessionId = requireString(payload, 'sessionId');
        const result = await groups.removeFromFolder(sessionId, { placeAtTop: payload.placeAtTop === true });
        refreshCosts([sessionId]);
        return result;
      }
      case 'organizer.folders.reorder': {
        const folderId = requireString(payload, 'folderId');
        const sessionId = requireString(payload, 'sessionId');
        const beforeSessionId = typeof payload.beforeSessionId === 'string' && payload.beforeSessionId !== ''
          ? payload.beforeSessionId
          : undefined;
        return await groups.reorderInFolder(folderId, sessionId, beforeSessionId);
      }
      case 'organizer.folders.order': {
        const workspaceId = requireString(payload, 'workspaceId');
        const items = payload.items;
        if (!Array.isArray(items)) throw codedError('invalid-input', 'items 必须是数组');
        return await groups.setOrder(workspaceId, items);
      }
      case 'organizer.folders.sessions': {
        const folderId = requireString(payload, 'folderId');
        await groups.state();
        return { folderId, sessionIds: getSessionsInFolder(folderId) };
      }
      case 'organizer.move': {
        const sessionId = requireString(payload, 'sessionId');
        const targetWorkspaceId = requireString(payload, 'targetWorkspaceId');
        const beforeSessionId = typeof payload.beforeSessionId === 'string' ? payload.beforeSessionId : undefined;
        const moved = await host.moveSession(sessionId, targetWorkspaceId, { beforeSessionId });
        // 成员换了工作区：两边的总计都要跟着变。
        refreshAllWorkspaces();
        return moved;
      }
      case 'organizer.reorderWorkspace': {
        const workspaceId = requireString(payload, 'workspaceId');
        const beforeWorkspaceId = typeof payload.beforeWorkspaceId === 'string' ? payload.beforeWorkspaceId : undefined;
        return await host.reorderWorkspace(workspaceId, beforeWorkspaceId);
      }
      case 'organizer.reorderSession': {
        const sessionId = requireString(payload, 'sessionId');
        const beforeSessionId = typeof payload.beforeSessionId === 'string' ? payload.beforeSessionId : undefined;
        return await host.reorderSession(sessionId, beforeSessionId);
      }
      case 'organizer.delete': {
        const sessionId = requireString(payload, 'sessionId');
        const mode = typeof payload.mode === 'string' && payload.mode !== '' ? payload.mode : 'recycle';
        const result = await host.deleteSession(sessionId, mode);
        // 彻底删除 / 仅移除注册：会话不再存在，归属关系同步清理。
        // 回收站（recycle）**保留**归属，恢复时项目自动回到原文件夹。
        if (result?.mode === 'purge' || result?.mode === 'unregister') {
          // 先记下它原来在哪些文件夹：prune 之后反向索引就查不到了。
          const affected = groups.foldersOfSession(sessionId);
          await groups.pruneSession(sessionId).catch((error) => {
            ctx?.logger?.warn?.(`workspace-organizer: 清理分组归属失败: ${errorMessage(error)}`);
          });
          refreshFolders(affected);
          // 工作区记账也一起清掉了；工作区总计必须同步收敛。
          refreshAllWorkspaces();
        }
        return result;
      }
      case 'organizer.cost.snapshot': {
        // 增量快照：只对水位变了的会话重取成本；其余直接复用缓存。
        if (costs === undefined || costs === null) {
          return { available: false, source: 'none', reason: '成本模块未启用', estimated: true, folders: {} };
        }
        return await costs.snapshot({
          sessionIds: Array.isArray(payload.sessionIds) ? payload.sessionIds : []
        });
      }
      case 'organizer.cost.workspace': {
        if (costs === undefined || costs === null) throw codedError('unsupported', '成本模块未启用');
        const workspaceId = requireString(payload, 'workspaceId');
        const view = await costs.recomputeWorkspace(workspaceId, { force: payload.force === true });
        if (view === undefined) throw codedError('not-found', `工作区不存在: ${workspaceId}`);
        return view;
      }
      case 'organizer.cost.session': {
        if (costs === undefined || costs === null) throw codedError('unsupported', '成本模块未启用');
        const sessionIds = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
        const snapshot = await costs.snapshot({ sessionIds });
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        const view = sessionId === '' ? undefined : (snapshot.sessions ?? {})[sessionId];
        return view === undefined ? { available: false, sessionId, reason: '该会话没有成本记录' } : { available: true, ...view };
      }
      case 'organizer.cost.folder': {
        if (costs === undefined || costs === null) throw codedError('unsupported', '成本模块未启用');
        const folderId = requireString(payload, 'folderId');
        const view = await costs.recomputeFolder(folderId, { force: payload.force === true });
        if (view === undefined) throw codedError('not-found', `文件夹不存在: ${folderId}`);
        return view;
      }
      case 'organizer.cost.status': {
        const source = costs?.source ?? resolveCostSource({});
        return {
          available: source.available === true,
          source: source.id,
          label: source.label,
          file: costs?.file?.(),
          // 触发器状态：排查「为什么小计没刷新」时一眼能看见
          watcher: typeof costWatcher === 'function' ? costWatcher() : undefined
        };
      }
      case 'organizer.trash.list':
        return await host.listTrash();
      case 'organizer.trash.restore': {
        const sessionId = requireString(payload, 'sessionId');
        const targetWorkspaceId = typeof payload.targetWorkspaceId === 'string' ? payload.targetWorkspaceId : undefined;
        const restored = await host.restoreFromTrash(sessionId, targetWorkspaceId);
        refreshAllWorkspaces();
        return restored;
      }
      case 'organizer.trash.purge': {
        const sessionId = requireString(payload, 'sessionId');
        const affected = groups.foldersOfSession(sessionId);
        const result = await host.purgeTrashEntry(sessionId);
        await groups.pruneSession(sessionId).catch((error) => {
          ctx?.logger?.warn?.(`workspace-organizer: 清理分组归属失败: ${errorMessage(error)}`);
        });
        refreshFolders(affected);
        refreshAllWorkspaces();
        return result;
      }
      case 'organizer.backups.list':
        return await host.listBackups();
      case 'organizer.reveal': {
        // 只读诊断：把某个会话的档案位置报给调用方（不打开文件管理器）。
        const sessionId = requireString(payload, 'sessionId');
        const tree = await host.tree();
        const session = tree.sessions.find((item) => item.sessionId === sessionId);
        if (session === undefined) throw codedError('not-found', `会话 ${sessionId} 不存在`);
        return session;
      }
      default:
        throw codedError('bad-endpoint', `未知端点: ${endpoint}`);
    }
  };
}

/**
 * Cordis 插件入口。
 * @param {object} ctx
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console;
  const host = createHost(ctx);
  const groups = createFolderStore(ctx);
  registerFolderStore(groups);
  // 预热一次：`getSessionsInFolder()` 是同步接口，需要缓存里已有数据。
  groups.warm().catch((error) => {
    logger.warn?.(`workspace-organizer: 分组数据预热失败: ${errorMessage(error)}`);
  });

  // 成本聚合：成员只来自 getSessionsInFolder，会话级成本来自外部数据源。
  // 任何失败都只是「没有成本列」，不影响文件夹与树本身。
  let costs = null;
  try {
    const source = resolveCostSource({ logger });
    costs = createCostRollups({
      logger,
      source,
      sessionIdsOfFolder: (folderId) => getSessionsInFolder(folderId),
      foldersOfSession: (sessionId) => foldersOfSession(sessionId),
      folderIds: () => groups.folderIds(),
      // 工作区花费与文件夹小计共用同一份会话级缓存（见 cost.mjs ensureSessionCost）。
      sessionIdsOfWorkspace: (workspaceId) => host.sessionIdsOfWorkspace(workspaceId),
      workspaceIds: () => host.workspaceIds(),
      workspacesOfSession: (sessionId) => host.workspacesOfSession(sessionId),
      stampOf: (sessionIds) => host.sessionStamps(sessionIds)
    });
    costs.warm().catch((error) => {
      logger.warn?.(`workspace-organizer: 成本缓存预热失败: ${errorMessage(error)}`);
    });
    if (source.available !== true) logger.info?.('workspace-organizer: 未找到会话级成本数据源，成本列将隐藏');
  } catch (error) {
    logger.warn?.(`workspace-organizer: 成本模块初始化失败，成本列将隐藏: ${errorMessage(error)}`);
    costs = null;
  }

  // #region M4：成本的事件触发（合并多次变更后只重算有变化的文件夹）
  //
  // 两条互补的触发路径，都**不做全量重算**：
  //   1) 事件：`session/event` / `session/disposed` 只把 sessionId 记进脏集合，
  //      2 秒内的多次事件合并成一次批量水位检查（poll）；
  //   2) 兜底：60 秒一次的批量水位检查，覆盖事件没送达的情况（比如外部改写档案）。
  // 两者都只 stat 已有水位记录的会话，没有变化就既不读数据源也不写盘。
  const watchCleanups = [];  let dirtySessions = new Set();
  let flushTimer = null;
  let sweepTimer = null;

  const flushDirtySessions = () => {
    flushTimer = null;
    if (costs === null) return;
    const ids = [...dirtySessions];
    dirtySessions = new Set();
    if (ids.length === 0) return;
    Promise.resolve()
      .then(() => costs.poll(ids))
      .catch((error) => {
        logger.warn?.(`workspace-organizer: 成本批量水位检查失败（下次快照兜底）: ${errorMessage(error)}`);
      });
  };

  const markCostDirty = (value) => {
    if (costs === null) return;
    const id = typeof value === 'string' ? value : String(value?.id ?? '');
    if (id === '') return;
    dirtySessions.add(id);
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flushDirtySessions, COST_DEBOUNCE_MS);
    if (typeof flushTimer?.unref === 'function') flushTimer.unref();
  };

  const watchCosts = () => {
    if (costs === null || costs.source?.available !== true) return;
    const listen = (name, handler) => {
      if (typeof ctx.on !== 'function') return;
      try {
        const dispose = ctx.on(name, handler);
        if (typeof dispose === 'function') watchCleanups.push(dispose);
      } catch (error) {
        logger.warn?.(`workspace-organizer: 订阅 ${name} 失败（成本改走惰性快照）: ${errorMessage(error)}`);
      }
    };
    // 会话产生新用量 / 被销毁时，只记脏，不立刻算。
    listen('session/event', (session) => markCostDirty(session));
    listen('session/disposed', (session) => markCostDirty(session));

    sweepTimer = setInterval(() => {
      if (costs === null) return;
      Promise.resolve()
        .then(() => costs.poll())
        .catch((error) => {
          logger.warn?.(`workspace-organizer: 成本定时水位检查失败: ${errorMessage(error)}`);
        });
    }, COST_SWEEP_MS);
    if (typeof sweepTimer?.unref === 'function') sweepTimer.unref();
    // 定时器挂着不阻止进程退出；卸载时一并清掉。
    watchCleanups.push(() => {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      dirtySessions = new Set();
    });

    try {
      ctx.effect?.(
        () => () => {
          for (const dispose of watchCleanups.splice(0)) {
            try {
              dispose();
            } catch {
              /* 卸载期失败无妨 */
            }
          }
        },
        'workspace-organizer: cost watcher'
      );
    } catch (error) {
      logger.warn?.(`workspace-organizer: 成本触发器注册失败（改走惰性快照）: ${errorMessage(error)}`);
    }
  };
  watchCosts();
  // #endregion

  const disposeRef = { fn: null };

  const mount = (owner) => {
    const connection = owner?.connection;
    if (connection === undefined || connection === null || typeof connection.rpc?.handle !== 'function') {
      logger.warn?.('workspace-organizer: connection.rpc 不可用，跨工作区功能未挂载');
      return;
    }
    // DSH 0.1.x 的 rpc getter 保留的是 Connection 服务上下文；重绑到注入的
    // web 上下文后 rpc.handle() 才会注册到 webServer 上。
    const rawConnection = connection[Symbol.for('cordis.original')] ?? connection;
    const scopedConnection = rawConnection?.[Symbol.for('cordis.extend')]?.({ ctx: owner }) ?? connection;
    const dispatch = createDispatch(ctx, host, groups, costs, () => ({
      debounceMs: COST_DEBOUNCE_MS,
      sweepMs: COST_SWEEP_MS,
      active: sweepTimer !== null,
      dirty: dirtySessions.size
    }));
    let dispose;
    try {
      dispose = scopedConnection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
        try {
          return ok(await dispatch(endpoint, payload, signal));
        } catch (error) {
          if (error?.name === 'AbortError' || error?.code === 'cancelled') return fail('cancelled', '请求已取消');
          logger.warn?.(`workspace-organizer: ${String(endpoint)} 失败: ${errorMessage(error)}`);
          return mapError(error);
        }
      }, { authority: 'loopback' });
    } catch (error) {
      logger.warn?.(`workspace-organizer: RPC 挂载失败: ${errorMessage(error)}`);
      return;
    }
    disposeRef.fn = dispose;
    owner.effect?.(() => () => {
      try {
        dispose?.();
      } catch {
        /* 卸载期失败无妨 */
      }
    }, 'workspace-organizer: rpc dispose');
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection', 'webServer'], (webCtx) => mount(webCtx));
  } else {
    mount(ctx);
  }
}
