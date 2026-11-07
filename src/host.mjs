/**
 * dsh-workspace-organizer — Host 侧业务层。
 *
 * 职责边界：
 *   - 跨工作区移动会话：改写工件头行的 `cwd`、把档案搬到新目录、更新
 *     Workspace 记账；活跃会话不销毁，只重绑持久化 writer + 补记
 *     `working-directory/change`，客户端不需要刷新页面。
 *   - 排序：调用 Workspace registry 的官方 `insertBefore` /
 *     `insertSessionBefore`，顺序写进 registry（现版本字段是
 *     `workspaceIds`；旧宿主的 `workspaceOrder.__topLevel__` 由兼容层兜底）。
 *   - 删除：回收站（可恢复）/ 仅移除注册 / 彻底删除；彻底删除前必须备份成功。
 *
 * 所有破坏性操作都遵守同一条顺序：**先把可回滚的物理动作做完，再改账目**；
 * 任一步失败都回滚并把错误交给调用方（Client 负责 Toast）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ARTIFACT_NAMES,
  assertSessionDirectory,
  encodeArtifact,
  encodeFsSessionSegment,
  encodeProjectSegment,
  findArtifactIn,
  readSessionFile,
  readSessionHeader
} from './session-files.mjs';
import {
  BACKUP_KEEP,
  TRASH_MANIFEST,
  assertSafeId,
  assertWorkspaceId,
  atomicWrite,
  backupDir,
  codedError,
  copyDirectory,
  dirExists,
  dirSize,
  errorMessage,
  moveDirectory,
  pluginDataDir,
  recycleDir,
  sessionsRoot,
  uniqueEntryName
} from './util.mjs';

const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取一个可选服务，不抛错。 */
function peek(ctx, name) {
  try {
    return ctx.get?.(name);
  } catch {
    return undefined;
  }
}

/** 工作区实体上的**原始**记账名单（含 cwd 已失效的幽灵项）。 */
function rawSessionIds(entity) {
  try {
    const ids = entity?.record?.sessionIds;
    if (Array.isArray(ids)) return ids.map(String);
    if (ids !== undefined && ids !== null) return [...ids].map(String);
  } catch {
    /* 私有结构变化时退回公开 getter */
  }
  try {
    return (entity?.sessionIds ?? []).map(String);
  } catch {
    return [];
  }
}

/** 某会话当前被哪些工作区记账。 */
function ownerEntities(registry, sessionId) {
  let entities = [];
  try {
    entities = registry?.list?.() ?? [];
  } catch {
    return [];
  }
  return entities.filter((entity) => rawSessionIds(entity).includes(String(sessionId)));
}

/**
 * 规范化持久化层返回的 header。
 *
 * `sessionPersistence.list()` 在当前宿主返回的是 `{ header, revision, sizeBytes }`
 * 包装（见 dsh-session-persistence-jsonl 的 list 实现），不是裸 header；
 * 老版本/其他后端可能直接返回裸 header，这里两种都认。
 */
function normalizeHeader(row) {
  if (row === null || typeof row !== 'object') return undefined;
  const nested = row.header !== null && typeof row.header === 'object' ? row.header : undefined;
  const source = (typeof row.id === 'string' && row.id !== '' ? row : nested);
  if (source === undefined) return undefined;
  const id = source.id;
  if (typeof id !== 'string' || id === '') return undefined;
  return source;
}

/** 会话 ID → 安全目录名。 */
function safeDirName(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * 建立一个绑定当前 ctx 的 Host 门面。
 * @param {object} ctx cordis 上下文
 */
export function createHost(ctx) {
  const logger = ctx.logger ?? console;
  const registryOf = () => ctx.workspaceRegistry ?? peek(ctx, 'workspaceRegistry');
  const persistenceOf = () => ctx.sessionPersistence ?? peek(ctx, 'sessionPersistence');

  /** 同 id 串行：并发破坏性操作直接排队，不会互相踩文件。 */
  const locks = new Map();
  async function withSessionLock(sessionId, operation) {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    locks.set(sessionId, run.then(() => {}, () => {}));
    try {
      return await run;
    } finally {
      const current = locks.get(sessionId);
      if (current !== undefined) {
        current.finally(() => {
          if (locks.get(sessionId) === current) locks.delete(sessionId);
        });
      }
    }
  }

  // #region 查询
  /** persistence 索引里的全部 header（不可用时退回磁盘扫描）。 */
  async function listStoredHeaders() {
    const persistence = persistenceOf();
    const headers = [];
    const seen = new Set();
    let listed = false;
    if (typeof persistence?.list === 'function') {
      try {
        const rows = await persistence.list();
        for (const row of Array.isArray(rows) ? rows : []) {
          const header = normalizeHeader(row);
          if (header === undefined || seen.has(header.id)) continue;
          seen.add(header.id);
          headers.push(header);
        }
        listed = true;
      } catch (error) {
        logger.warn?.(`workspace-organizer: 会话索引读取失败，改用磁盘扫描: ${errorMessage(error)}`);
      }
    }
    if (listed) return headers;

    const root = sessionsRoot();
    let projects = [];
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return headers;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectPath = join(root, project.name);
      let dirs = [];
      try {
        dirs = await readdir(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const artifact = await findArtifactIn(join(projectPath, dir.name));
        if (artifact === undefined) continue;
        try {
          const header = await readSessionHeader(artifact);
          if (seen.has(header.id)) continue;
          seen.add(header.id);
          headers.push(header);
        } catch {
          /* 一条坏档案不应让只读查询整体失败 */
        }
      }
    }
    return headers;
  }

  async function findHeader(sessionId) {
    const headers = await listStoredHeaders();
    return headers.find((header) => String(header.id) === String(sessionId));
  }

  /** 扫描磁盘：某会话 ID 的所有候选目录。 */
  async function findSessionDirs(sessionId) {
    const root = sessionsRoot();
    const segments = [...new Set([encodeFsSessionSegment(sessionId), sessionId])];
    const out = [];
    let projects = [];
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      for (const segment of segments) {
        const candidate = join(root, project.name, segment);
        if (dirExists(candidate)) out.push(candidate);
      }
    }
    return out;
  }

  /** 由 header 定位工件的绝对路径（官方 locate 优先，磁盘兜底）。 */
  async function locateArtifact(header) {
    const persistence = persistenceOf();
    if (typeof persistence?.locate === 'function') {
      try {
        const location = persistence.locate(header);
        if (typeof location?.path === 'string' && location.path !== '') return location.path;
      } catch {
        /* 退回磁盘推算 */
      }
    }
    const root = sessionsRoot();
    if (typeof header?.cwd === 'string' && header.cwd !== '') {
      const direct = join(root, encodeProjectSegment(header.cwd), encodeFsSessionSegment(String(header.id)));
      const artifact = await findArtifactIn(direct);
      if (artifact !== undefined) return artifact;
    }
    for (const dir of await findSessionDirs(String(header?.id))) {
      const artifact = await findArtifactIn(dir);
      if (artifact !== undefined) return artifact;
    }
    return undefined;
  }

  /** 会话在工作区树里的完整视图（Client 兜底用；正常 UI 走原生快照）。 */
  async function tree() {
    const registry = registryOf();
    const headers = await listStoredHeaders();
    const archived = new Set((registry?.archivedSessionIds ?? []).map(String));
    const liveIds = new Set((ctx.sessions?.list?.() ?? []).map((session) => String(session.id)));
    return {
      workspaces: (registry?.list?.() ?? []).map((entity) => ({
        workspaceId: String(entity.id),
        title: entity.title,
        path: entity.path,
        sessionIds: rawSessionIds(entity)
      })),
      sessions: headers.map((header) => ({
        sessionId: String(header.id),
        // 标题只给虚拟分组面板做行标签用；原生侧边栏仍走它自己的投影。
        title: typeof header.title === 'string' && header.title.trim() !== '' ? header.title.trim() : undefined,
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        updatedAt: typeof header.updatedAt === 'string' ? header.updatedAt : undefined,
        archived: archived.has(String(header.id)),
        live: liveIds.has(String(header.id))
      }))
    };
  }

  /**
   * 全部工作区及其成员会话（成本聚合按工作区求和的唯一入口）。
   *
   * 工作区花费必须包含**全部**成员会话（含未收纳、已归档），所以这里只看
   * workspaceRegistry 的原始记账名单，不经过侧边栏的可见性过滤。
   */
  function workspaceViews() {
    const registry = registryOf();
    let entities = [];
    try {
      entities = registry?.list?.() ?? [];
    } catch {
      entities = [];
    }
    return entities.map((entity) => ({ workspaceId: String(entity.id), sessionIds: rawSessionIds(entity) }));
  }

  /** 当前全部工作区 ID（成本快照按它遍历）。 */
  function workspaceIds() {
    return workspaceViews().map((view) => view.workspaceId);
  }

  /** 某工作区的成员会话（含未收纳；未知工作区返回空数组）。 */
  function sessionIdsOfWorkspace(workspaceId) {
    const id = String(workspaceId ?? '');
    const found = workspaceViews().find((view) => view.workspaceId === id);
    return found === undefined ? [] : found.sessionIds;
  }

  /** 某会话被哪些工作区记账（成员变化后只重算受影响的工作区）。 */
  function workspacesOfSession(sessionId) {
    const id = String(sessionId ?? '');
    return workspaceViews()
      .filter((view) => view.sessionIds.includes(id))
      .map((view) => view.workspaceId);
  }

  /**
   * 批量取会话日志水位（mtime + size），成本聚合的增量校验用它。
   *
   * 一次 `listStoredHeaders()` + N 次 stat：只读、不改任何东西。找不到档案
   * （会话已被删 / 还没落盘）时不给水位，调用方按“无日志”处理。
   * @param {string[]} sessionIds
   * @returns {Promise<Record<string, { logMtime: number, logSize: number }>>}
   */
  async function sessionStamps(sessionIds) {
    const wanted = (Array.isArray(sessionIds) ? sessionIds : []).map(String);
    const out = {};
    if (wanted.length === 0) return out;
    const headers = await listStoredHeaders();
    const byId = new Map(headers.map((header) => [String(header.id), header]));
    for (const sessionId of wanted) {
      const header = byId.get(sessionId);
      if (header === undefined) continue;
      const artifact = await locateArtifact(header);
      if (artifact === undefined) continue;
      try {
        const stat = statSync(artifact);
        out[sessionId] = { logMtime: stat.mtimeMs, logSize: stat.size };
      } catch {
        /* 单条读不到就算没有水位，不拖垮整批 */
      }
    }
    return out;
  }

  /**
   * 当前宿主认识的**全部**会话 ID：已落盘的 header + 运行中的会话 + 工作区记账。
   * 收纳校验用它，避免把未落盘的空白会话当成不存在的项目拒掉。
   */
  async function knownSessionIds() {
    const ids = new Set();
    for (const header of await listStoredHeaders()) ids.add(String(header.id));
    try {
      for (const session of ctx.sessions?.list?.() ?? []) ids.add(String(session.id));
    } catch {
      /* 运行时快照不可用时只看 header */
    }
    for (const entity of registryOf()?.list?.() ?? []) {
      for (const id of rawSessionIds(entity)) ids.add(String(id));
    }
    return ids;
  }
  // #endregion

  // #region 排序
  /** 工作区排序：官方 insertBefore，并兼容旧宿主的 workspaceOrder 账本。 */
  async function reorderWorkspace(workspaceId, beforeWorkspaceId) {
    assertWorkspaceId(workspaceId);
    const registry = registryOf();
    if (registry === undefined) throw codedError('unsupported', 'workspaceRegistry 服务不可用');
    if (typeof registry.insertBefore !== 'function') throw codedError('unsupported', '该宿主未提供 insertBefore');
    const ids = (registry.list?.() ?? []).map((entity) => String(entity.id));
    if (!ids.includes(workspaceId)) throw codedError('not-found', `工作区不存在: ${workspaceId}`);
    const anchor = toOptionalId(beforeWorkspaceId);
    if (anchor !== undefined) {
      assertWorkspaceId(anchor);
      if (!ids.includes(anchor)) throw codedError('not-found', `锚点工作区不存在: ${anchor}`);
    }
    if (anchor === workspaceId) return { workspaceIds: ids, changed: false };

    const result = await registry.insertBefore(workspaceId, anchor);
    const order = Array.isArray(result)
      ? result.map(String)
      : (registry.list?.() ?? []).map((entity) => String(entity.id));
    await persistLegacyWorkspaceOrder(registry, order);
    return { workspaceIds: order, changed: true };
  }

  /** 旧版 DSH 把顶层顺序记在 workspaceOrder["__topLevel__"]；能写就顺手写一份。 */
  async function persistLegacyWorkspaceOrder(registry, order) {
    try {
      const book = registry.workspaceOrder;
      if (book === null || typeof book !== 'object') return;
      book.__topLevel__ = order;
      if (typeof registry.persistWorkspaceOrder === 'function') await registry.persistWorkspaceOrder(book);
    } catch {
      /* 兼容层写不进去不影响官方顺序 */
    }
  }

  /** 工作区内会话排序：官方 insertSessionBefore。 */
  async function reorderSession(sessionId, beforeSessionId) {
    assertSafeId(sessionId);
    const anchor = toOptionalId(beforeSessionId);
    if (anchor !== undefined) assertSafeId(anchor);
    const registry = registryOf();
    if (registry === undefined) throw codedError('unsupported', 'workspaceRegistry 服务不可用');
    if (anchor === sessionId) return { changed: false };

    const owners = ownerEntities(registry, sessionId);
    if (owners.length === 0) throw codedError('not-found', `会话 ${sessionId} 未归属任何工作区`);
    const owner = owners[0];
    if (anchor !== undefined && !rawSessionIds(owner).includes(anchor)) {
      throw codedError('conflict', '锚点会话不在同一工作区；跨区请使用移动');
    }
    if (typeof owner.insertSessionBefore !== 'function') throw codedError('unsupported', '该宿主未提供 insertSessionBefore');
    await owner.insertSessionBefore(sessionId, anchor);
    return { changed: true, workspaceId: String(owner.id), sessionIds: rawSessionIds(owner) };
  }
  // #endregion

  // #region 移动
  /** 活跃会话的持久化 writer（用于原地重绑）。 */
  function liveWriterOf(persistence, sessionId) {
    const writers = persistence?.tracker?.writers;
    if (writers === undefined || writers === null) return undefined;
    return typeof writers.get === 'function' ? writers.get(sessionId) : undefined;
  }

  function rebindLiveWriter(persistence, sessionId, newHeader) {
    const writer = liveWriterOf(persistence, sessionId);
    if (writer === undefined || writer === null || typeof writer.header !== 'object' || writer.header === null) {
      throw codedError('unsupported', '当前运行时未暴露可重绑定的 live writer，无法安全迁移运行中的会话；请先关闭该会话后重试');
    }
    writer.header = Object.freeze({ ...newHeader });
    return writer;
  }

  /**
   * 冷会话正文里若已有 `working-directory/change` 历史，必须补一条新记录，
   * 否则下次恢复时旧事件会把 cwd 折回迁移前的位置。含压缩行/非连续 seq 的
   * 日志无法安全追加，直接拒绝移动而不是留下不一致。
   */
  function rehomeColdWorkingDirectory(rest, targetPath) {
    const terminated = rest.endsWith(NL);
    const body = terminated ? rest.slice(0, -1) : rest;
    if (body === '') return { rest, status: 'header-only' };
    const lines = body.split(NL);
    let lastChange;
    let unsafe = false;
    for (let index = 0; index < lines.length; index += 1) {
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch {
        unsafe = true;
        continue;
      }
      if (event === null || typeof event !== 'object' || event.seq !== index) unsafe = true;
      if (event?.type === 'working-directory/change') lastChange = event.data?.cwd;
    }
    if (lastChange === undefined) return { rest, status: 'header-only' };
    if (lastChange === targetPath) return { rest, status: 'already-target' };
    if (unsafe) {
      throw codedError('working-directory-sync-unsafe', '会话日志包含压缩行或非连续序号，且已有工作目录变更历史；为防止目录不一致已取消移动');
    }
    const appended = JSON.stringify({
      type: 'working-directory/change',
      seq: lines.length,
      time: Date.now(),
      data: { cwd: targetPath }
    });
    return { rest: `${body}${NL}${appended}${NL}`, status: 'recorded' };
  }

  /** 活跃会话补记工作目录变更（官方 service 优先，其次直接 append）。 */
  async function rehomeLiveWorkingDirectory({ agent, session, targetPath }) {
    const service = peek(ctx, 'sessionWorkingDirectory') ?? peek(ctx, 'workingDirectory');
    if (service !== undefined && typeof service.set === 'function' && agent !== undefined) {
      try {
        const cwd = await service.set(agent, targetPath);
        return { status: 'synced', cwd: typeof cwd === 'string' && cwd !== '' ? cwd : targetPath };
      } catch (error) {
        logger.warn?.(`workspace-organizer: 工作目录服务拒绝了变更，改为直接记录事件: ${errorMessage(error)}`);
      }
    }
    if (session !== undefined && typeof session.append === 'function') {
      try {
        session.append('working-directory/change', { cwd: targetPath });
        return { status: 'recorded', cwd: targetPath };
      } catch (error) {
        logger.warn?.(`workspace-organizer: 记录工作目录变更失败: ${errorMessage(error)}`);
      }
    }
    return { status: 'restart-required', reason: '没有可用的工作目录记录通道' };
  }

  /**
   * 跨工作区移动一个会话。
   * @param {string} sessionId
   * @param {string} targetWorkspaceId
   * @param {{beforeSessionId?: string}} [options]
   */
  async function moveSession(sessionId, targetWorkspaceId, options = {}) {
    assertSafeId(sessionId);
    assertWorkspaceId(targetWorkspaceId);
    const registry = registryOf();
    const persistence = persistenceOf();
    if (registry === undefined) throw codedError('unsupported', 'workspaceRegistry 服务不可用');
    const target = (registry.list?.() ?? []).find((entity) => String(entity.id) === String(targetWorkspaceId));
    if (target === undefined) throw codedError('not-found', `目标工作区不存在: ${targetWorkspaceId}`);
    const targetPath = target.path;

    const storedHeader = await findHeader(sessionId);
    if (storedHeader === undefined) {
      throw codedError('session-not-found', `会话 ${sessionId} 没有磁盘记录（可能是尚未发送任何消息的空白会话），无法移动`);
    }
    if (storedHeader.origin === 'subagent') throw codedError('unsupported', '子代理（subagent）会话不支持跨工作区移动');

    // 已经在该目录：只补账目，不动文件。
    if (typeof storedHeader.cwd === 'string' && storedHeader.cwd !== '') {
      let canonical;
      try {
        canonical = await realpath(storedHeader.cwd);
      } catch {
        canonical = undefined;
      }
      if (canonical === targetPath) {
        const alreadyOwned = ownerEntities(registry, sessionId).some((entity) => String(entity.id) === String(targetWorkspaceId));
        if (alreadyOwned) {
          return { moved: false, attached: false, workspaceId: String(target.id), workspaceTitle: target.title };
        }
        if (typeof target.attachSession !== 'function') throw codedError('unsupported', '工作区实体未提供 attachSession');
        await target.attachSession(sessionId);
        return { moved: false, attached: true, workspaceId: String(target.id), workspaceTitle: target.title };
      }
    }

    const liveSession = ctx.sessions?.get?.(sessionId);
    let liveAgent;
    try {
      liveAgent = ctx.agents?.get?.(sessionId);
    } catch {
      liveAgent = undefined;
    }
    if (liveSession !== undefined && liveWriterOf(persistence, sessionId) === undefined) {
      throw codedError('unsupported', '当前运行时未暴露可重绑定的 live persistence writer，无法安全迁移运行中的会话；请先关闭该会话后重试');
    }
    if (liveSession !== undefined) {
      try {
        await ctx.sessions.flush(liveSession);
      } catch {
        /* 尽力落盘 */
      }
    }

    const coordinator = persistence?.coordinator;
    const serialize = typeof coordinator?.serialize === 'function'
      ? (operation) => coordinator.serialize(sessionId, operation)
      : (operation) => operation();

    return await serialize(async () => {
      const oldPath = await locateArtifact(storedHeader);
      if (oldPath === undefined) throw codedError('not-found', '读取会话工件失败：未找到会话文件');
      const oldDir = dirname(oldPath);
      const root = sessionsRoot();
      await assertSessionDirectory(root, oldDir, sessionId);

      const raw = await readSessionFile(oldPath);
      const newlineAt = raw.content.indexOf(NL);
      if (newlineAt < 0) throw codedError('corrupt-artifact', '会话工件缺少头行，数据可能损坏');
      const oldHeader = JSON.parse(raw.content.slice(0, newlineAt));
      if (String(oldHeader.id) !== String(sessionId)) throw codedError('corrupt-artifact', '会话工件头行 id 与请求不符，拒绝移动');
      const rest = raw.content.slice(newlineAt + 1);

      const newHeader = { ...oldHeader, cwd: targetPath };
      const located = typeof persistence?.locate === 'function' ? persistence.locate(newHeader) : undefined;
      const targetFilename = (liveSession !== undefined && located?.path !== undefined)
        ? basename(located.path)
        : (raw.filename ?? basename(oldPath));
      const newPath = located?.path !== undefined
        ? join(dirname(located.path), targetFilename)
        : join(root, encodeProjectSegment(targetPath), encodeFsSessionSegment(sessionId), targetFilename);
      const generation = (() => {
        const match = targetFilename.match(/^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/);
        return match === null ? undefined : (match[1] === undefined ? 0 : Number(match[1]));
      })();
      if (generation !== undefined) newHeader.version = generation;
      const newDir = dirname(newPath);
      if (oldPath === newPath) throw codedError('conflict', '会话源路径与目标路径相同，但 cwd 不一致，拒绝覆盖');
      await assertSessionDirectory(root, newDir, sessionId, { allowMissing: true });
      if (existsSync(newPath)) throw codedError('conflict', '目标位置已有同名会话工件，拒绝覆盖');

      const rehomed = liveSession === undefined
        ? rehomeColdWorkingDirectory(rest, targetPath)
        : { rest, status: 'live' };
      const bytes = await encodeArtifact(JSON.stringify(newHeader), rehomed.rest, newPath);

      // 新档案先落临时位，旧档案藏起来，再原子发布；任一步失败都还原。
      await mkdir(newDir, { recursive: true });
      const token = `${process.pid.toString(36)}${Date.now().toString(36)}`;
      const tempNew = `${newPath}.${token}.tmp`;
      const oldHidden = `${oldPath}.${token}.hidden`;
      const handle = await (await import('node:fs/promises')).open(tempNew, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
      } catch (error) {
        try {
          await handle.close();
        } catch {
          /* 保持原始错误 */
        }
        await rm(tempNew, { force: true }).catch(() => {});
        throw error;
      }
      try {
        await rename(oldPath, oldHidden);
      } catch (error) {
        await rm(tempNew, { force: true }).catch(() => {});
        throw codedError('move-failed', `移动失败（无法隐藏旧会话工件，已取消，会话保持原状）: ${errorMessage(error)}`);
      }
      try {
        await rename(tempNew, newPath);
      } catch (error) {
        try {
          await rename(oldHidden, oldPath);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `移动发布失败且回滚失败；原始会话保留在 ${oldHidden}，新文件保留在 ${tempNew}`);
        }
        await rm(tempNew, { force: true }).catch(() => {});
        throw codedError('move-failed', `移动发布失败，原始会话已恢复: ${errorMessage(error)}`);
      }

      // 内存与索引状态快照，失败时整体还原。
      const state = coordinator?.states?.get?.(sessionId);
      const oldStateMeta = state?.meta;
      const oldLiveHeader = liveSession?.header;
      const writer = liveSession === undefined ? undefined : liveWriterOf(persistence, sessionId);
      const oldWriterHeader = writer?.header;
      const oldIndexedHeader = registry.headers?.get?.(sessionId);
      const oldIndexedPath = registry.sessionPaths?.get?.(sessionId);
      const oldInvalidPath = registry.invalidSessionPaths?.get?.(sessionId);
      const detachedFrom = [];
      let targetAttached = false;
      try {
        if (state !== undefined) {
          state.meta = { ...state.meta, ...newHeader, cwd: targetPath };
          state.materialized = true;
        }
        coordinator?.preparations?.invalidate?.(sessionId);
        if (liveSession !== undefined) {
          liveSession.header = Object.freeze({ ...newHeader });
          rebindLiveWriter(persistence, sessionId, newHeader);
        }
        registry.headers?.set?.(sessionId, { ...newHeader });
        registry.sessionPaths?.set?.(sessionId, targetPath);
        registry.invalidSessionPaths?.delete?.(sessionId);

        for (const entity of ownerEntities(registry, sessionId)) {
          if (String(entity.id) === String(targetWorkspaceId)) continue;
          await entity.detachSession(sessionId);
          detachedFrom.push(entity);
        }
        await target.attachSession(sessionId);
        targetAttached = true;
        const beforeSessionId = toOptionalId(options.beforeSessionId);
        if (beforeSessionId !== undefined && beforeSessionId !== sessionId && rawSessionIds(target).includes(beforeSessionId)
          && typeof target.insertSessionBefore === 'function') {
          await target.insertSessionBefore(sessionId, beforeSessionId);
        }
      } catch (error) {
        if (state !== undefined && oldStateMeta !== undefined) state.meta = oldStateMeta;
        coordinator?.preparations?.invalidate?.(sessionId);
        if (liveSession !== undefined && oldLiveHeader !== undefined) liveSession.header = oldLiveHeader;
        if (writer !== undefined && oldWriterHeader !== undefined) writer.header = oldWriterHeader;
        if (oldIndexedHeader === undefined) registry.headers?.delete?.(sessionId);
        else registry.headers?.set?.(sessionId, oldIndexedHeader);
        if (oldIndexedPath === undefined) registry.sessionPaths?.delete?.(sessionId);
        else registry.sessionPaths?.set?.(sessionId, oldIndexedPath);
        if (oldInvalidPath === undefined) registry.invalidSessionPaths?.delete?.(sessionId);
        else registry.invalidSessionPaths?.set?.(sessionId, oldInvalidPath);

        const rollbackErrors = [];
        if (targetAttached) {
          try {
            await target.detachSession(sessionId);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        for (const entity of detachedFrom) {
          try {
            await entity.attachSession(sessionId);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          await rm(newPath, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await rename(oldHidden, oldPath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], '移动失败且回滚不完整');
        }
        throw error;
      }

      // 收尾：删隐藏的旧档案与旧目录（失败只记日志，数据已在新位置）。
      await rm(oldHidden, { force: true }).catch(() => {});
      try {
        await assertSessionDirectory(root, oldDir, sessionId);
        await rm(oldDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn?.(`workspace-organizer: 旧会话目录未能清理: ${errorMessage(error)}`);
      }

      let workingDirectory = rehomed.status;
      let restartRequired = false;
      if (liveSession !== undefined) {
        const result = await rehomeLiveWorkingDirectory({ agent: liveAgent, session: liveSession, targetPath });
        workingDirectory = result.status;
        if (result.status === 'restart-required') restartRequired = true;
      } else if (workingDirectory === 'restart-required') {
        restartRequired = true;
      }

      // 投影缓存失效，避免侧边栏继续用旧 cwd 归组。
      try {
        peek(ctx, 'sessionProjectionCache')?.table?.delete?.(sessionId);
      } catch {
        /* 陈旧投影会在下次打开时重建 */
      }

      logger.info?.(`workspace-organizer: 已把 ${sessionId} 移动到工作区 ${target.id}`);
      return {
        moved: true,
        sessionId,
        workspaceId: String(target.id),
        workspaceTitle: target.title,
        fromCwd: oldHeader.cwd,
        toCwd: targetPath,
        artifactFrom: oldPath,
        artifactTo: newPath,
        wasLive: liveSession !== undefined || liveAgent !== undefined,
        workingDirectory,
        restartRequired
      };
    });
  }
  // #endregion

  // #region 删除
  /** 只把内存里缓冲的事件落盘，不动任何内存状态。 */
  async function flushSession(sessionId) {
    const session = ctx.sessions?.get?.(sessionId);
    if (session === undefined) return;
    try {
      await ctx.sessions.flush(session);
    } catch {
      /* 尽力落盘：失败由后续 quiesce 再 flush 一次 */
    }
  }

  /** 让一个会话从内存层退出（不删文件）。 */
  async function quiesceSession(sessionId) {
    let agent;
    try {
      agent = ctx.agents?.get?.(sessionId);
    } catch {
      agent = undefined;
    }
    if (agent?.status === 'running' || agent?.busy === true) {
      throw codedError('busy', '会话正在运行中，请先停止再删除');
    }
    const session = ctx.sessions?.get?.(sessionId);
    let detached = false;
    if (agent !== undefined) {
      try {
        agent.cancel?.({ kind: 'disposed' });
      } catch {
        /* 已停止 */
      }
      try {
        if (typeof agent.scope?.dispose === 'function') await Promise.race([agent.scope.dispose(), sleep(3000)]);
      } catch (error) {
        logger.warn?.(`workspace-organizer: 会话 agent 释放失败: ${errorMessage(error)}`);
      }
      try {
        ctx.agents?.store?.delete?.(sessionId);
      } catch {
        /* 僵尸条目后面 detach 还会兜底 */
      }
    }
    if (session !== undefined) {
      try {
        await ctx.sessions.flush(session);
      } catch {
        /* 尽力落盘 */
      }
      try {
        const entry = ctx.sessions?.store?.get?.(sessionId);
        if (entry !== undefined && typeof entry.detach === 'function') {
          entry.detach();
          await sleep(200);
          detached = true;
        }
      } catch (error) {
        logger.warn?.(`workspace-organizer: 会话 store 分离失败: ${errorMessage(error)}`);
      }
    }
    if (!detached) {
      try {
        ctx.emit?.('session/disposed', { id: sessionId });
      } catch {
        /* 通知失败不影响文件操作 */
      }
    }
    return { wasLive: session !== undefined || agent !== undefined };
  }

  /** 清掉工作区记账与注册表内存索引。 */
  async function forgetSession(sessionId) {
    const registry = registryOf();
    const detachedFrom = [];
    for (const entity of ownerEntities(registry, sessionId)) {
      try {
        await entity.detachSession(sessionId);
        detachedFrom.push(String(entity.id));
      } catch (error) {
        logger.warn?.(`workspace-organizer: 分离 ${sessionId} 的记账失败: ${errorMessage(error)}`);
      }
    }
    try {
      registry?.headers?.delete?.(sessionId);
    } catch {
      /* ignore */
    }
    try {
      registry?.sessionPaths?.delete?.(sessionId);
    } catch {
      /* ignore */
    }
    try {
      registry?.invalidSessionPaths?.delete?.(sessionId);
    } catch {
      /* ignore */
    }
    try {
      if (typeof registry?.unarchiveSession === 'function') await registry.unarchiveSession(sessionId);
    } catch {
      /* 归档集清理失败只影响可见性 */
    }
    try {
      peek(ctx, 'sessionProjectionCache')?.table?.delete?.(sessionId);
    } catch {
      /* 陈旧投影无害 */
    }
    return detachedFrom;
  }

  /** 备份一个会话目录；失败抛出（调用方据此拒绝彻底删除）。 */
  async function backupSessionDirectory(sessionId, sourceDir) {
    if (!dirExists(sourceDir)) throw codedError('not-found', `会话目录不存在，无法备份: ${sourceDir}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(backupDir(), safeDirName(sessionId), stamp);
    try {
      await mkdir(dest, { recursive: true });
      await copyDirectory(sourceDir, join(dest, 'session'));
      const manifest = {
        version: 1,
        sessionId: String(sessionId),
        sourceDir,
        createdAt: new Date().toISOString(),
        files: readdirSync(sourceDir)
      };
      await atomicWrite(join(dest, TRASH_MANIFEST), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      await pruneBackups(sessionId);
      return dest;
    } catch (error) {
      await rm(dest, { recursive: true, force: true }).catch(() => {});
      throw codedError('backup-failed', `备份失败，已取消彻底删除: ${errorMessage(error)}`);
    }
  }

  /** 每个会话只保留最近 BACKUP_KEEP 份备份。 */
  async function pruneBackups(sessionId) {
    const dir = join(backupDir(), safeDirName(sessionId));
    let entries = [];
    try {
      entries = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return;
    }
    while (entries.length > BACKUP_KEEP) {
      const oldest = entries.shift();
      await rm(join(dir, oldest), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 删除会话：recycle / unregister / purge。 */
  async function deleteSession(sessionId, mode = 'recycle') {
    assertSafeId(sessionId);
    if (!['recycle', 'unregister', 'purge'].includes(mode)) throw codedError('invalid-input', `未知的删除方式: ${mode}`);

    return await withSessionLock(sessionId, async () => {
      const registry = registryOf();
      if (registry === undefined) throw codedError('unsupported', 'workspaceRegistry 服务不可用');
      const header = await findHeader(sessionId);
      let sessionDir;
      if (header !== undefined) {
        const artifact = await locateArtifact(header);
        if (artifact !== undefined) sessionDir = dirname(artifact);
      }
      if (sessionDir === undefined) sessionDir = (await findSessionDirs(sessionId))[0];

      // 仅移除注册：不动磁盘。
      if (mode === 'unregister') {
        if (header === undefined && ownerEntities(registry, sessionId).length === 0) {
          throw codedError('not-found', `会话 ${sessionId} 不存在`);
        }
        await quiesceSession(sessionId);
        const detachedFrom = await forgetSession(sessionId);
        return { mode, sessionId, filesRemoved: false, detachedFrom };
      }

      // 没有磁盘档案（未落盘的空白会话）：回收站退化为「仅移除注册」，彻底删除则无文件可删。
      if (sessionDir === undefined) {
        if (mode === 'purge') throw codedError('not-found', `会话 ${sessionId} 没有对应的磁盘档案`);
        await quiesceSession(sessionId);
        const detachedFrom = await forgetSession(sessionId);
        return { mode: 'unregister', sessionId, filesRemoved: false, detachedFrom, degraded: 'no-artifact' };
      }
      await assertSessionDirectory(sessionsRoot(), sessionDir, sessionId);

      if (mode === 'purge') {
        // 先 flush 再备份：备份必须是包含最新事件的完整档案。
        await flushSession(sessionId);
        const backupPath = await backupSessionDirectory(sessionId, sessionDir);
        await quiesceSession(sessionId);
        try {
          await rm(sessionDir, { recursive: true, force: true });
        } catch (error) {
          throw codedError('purge-failed', `备份已保留在 ${backupPath}，但删除文件失败: ${errorMessage(error)}`);
        }
        await forgetSession(sessionId);
        return { mode, sessionId, filesRemoved: true, backupPath };
      }

      // recycle：物理移动先行。
      const entryName = uniqueEntryName('', sessionId);
      const entryDir = join(recycleDir(), entryName);
      const archived = new Set((registry.archivedSessionIds ?? []).map(String)).has(String(sessionId));
      const owners = ownerEntities(registry, sessionId);
      await quiesceSession(sessionId);
      await mkdir(entryDir, { recursive: true });
      try {
        await moveDirectory(sessionDir, join(entryDir, 'session'));
      } catch (error) {
        await rm(entryDir, { recursive: true, force: true }).catch(() => {});
        throw codedError('trash-failed', `移入回收站失败（未做任何改动）: ${errorMessage(error)}`);
      }
      const manifest = {
        version: 1,
        sessionId: String(sessionId),
        title: typeof header?.title === 'string' && header.title.trim() !== '' ? header.title.trim() : null,
        cwd: typeof header?.cwd === 'string' ? header.cwd : null,
        ownerWorkspaceId: owners[0] === undefined ? null : String(owners[0].id),
        ownerTitle: owners[0]?.title ?? null,
        archived,
        deletedAt: new Date().toISOString(),
        sizeBytes: dirSize(join(entryDir, 'session'))
      };
      try {
        await atomicWrite(join(entryDir, TRASH_MANIFEST), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      } catch (error) {
        // 清单写不进去就原样搬回，回收站里绝不留不可见条目。
        try {
          await moveDirectory(join(entryDir, 'session'), sessionDir);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `回收站清单写入失败且回滚失败；档案保留在 ${entryDir}`);
        }
        await rm(entryDir, { recursive: true, force: true }).catch(() => {});
        throw codedError('trash-failed', `回收站清单写入失败，会话已还原: ${errorMessage(error)}`);
      }
      await forgetSession(sessionId);
      return { mode, sessionId, filesRemoved: true, entry: entryName, manifest };
    });
  }
  // #endregion

  // #region 回收站
  function readTrashManifest(entryDir) {
    const path = join(entryDir, TRASH_MANIFEST);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async function listTrash() {
    const dir = recycleDir();
    if (!dirExists(dir)) return { items: [], dir };
    const items = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryDir = join(dir, entry.name);
      const manifest = readTrashManifest(entryDir);
      if (manifest === undefined || typeof manifest.sessionId !== 'string') continue;
      items.push({
        entry: entry.name,
        sessionId: manifest.sessionId,
        title: manifest.title ?? null,
        cwd: manifest.cwd ?? null,
        ownerWorkspaceId: manifest.ownerWorkspaceId ?? null,
        ownerTitle: manifest.ownerTitle ?? null,
        archived: Boolean(manifest.archived),
        deletedAt: manifest.deletedAt ?? null,
        hasFiles: dirExists(join(entryDir, 'session'))
      });
    }
    items.sort((left, right) => String(right.deletedAt ?? '').localeCompare(String(left.deletedAt ?? '')));
    return { items, dir };
  }

  /** 在回收站里按会话 ID 找条目。 */
  async function findTrashEntry(sessionId) {
    const dir = recycleDir();
    if (!dirExists(dir)) return undefined;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryDir = join(dir, entry.name);
      const manifest = readTrashManifest(entryDir);
      if (manifest !== undefined && String(manifest.sessionId) === String(sessionId)) {
        return { entryDir, manifest };
      }
    }
    return undefined;
  }

  /** 从回收站恢复（可指定恢复到另一个工作区）。 */
  async function restoreFromTrash(sessionId, targetWorkspaceId) {
    assertSafeId(sessionId);
    const targetWs = toOptionalId(targetWorkspaceId);
    if (targetWs !== undefined) assertWorkspaceId(targetWs);
    return await withSessionLock(sessionId, async () => {
      const registry = registryOf();
      const found = await findTrashEntry(sessionId);
      if (found === undefined) throw codedError('not-found', `回收站里没有会话 ${sessionId}`);
      const { entryDir, manifest } = found;
      const sessionDirInTrash = join(entryDir, 'session');
      const artifactInTrash = await findArtifactIn(sessionDirInTrash);
      if (artifactInTrash === undefined) throw codedError('corrupt-artifact', `回收站条目缺少会话档案: ${entryDir}`);
      const header = await readSessionHeader(artifactInTrash);
      const originalCwd = typeof header.cwd === 'string' ? header.cwd : (typeof manifest.cwd === 'string' ? manifest.cwd : undefined);
      if (originalCwd === undefined) throw codedError('corrupt-artifact', '会话头行没有 cwd，无法确定恢复位置');

      const persistence = persistenceOf();
      const located = typeof persistence?.locate === 'function' ? persistence.locate({ ...header, cwd: originalCwd }) : undefined;
      const targetDir = located?.path !== undefined
        ? dirname(located.path)
        : join(sessionsRoot(), encodeProjectSegment(originalCwd), encodeFsSessionSegment(sessionId));
      await assertSessionDirectory(sessionsRoot(), targetDir, sessionId, { allowMissing: true });
      if (dirExists(targetDir)) {
        const existing = await findArtifactIn(targetDir);
        if (existing !== undefined) throw codedError('conflict', `恢复目标已存在会话档案，拒绝覆盖: ${existing}`);
        // 空目录可以直接沿用；非空又不含工件则视为异常，避免混入别的文件。
        let names = [];
        try {
          names = await readdir(targetDir);
        } catch {
          names = [];
        }
        if (names.length > 0) throw codedError('conflict', `恢复目标目录非空，拒绝覆盖: ${targetDir}`);
        await rm(targetDir, { recursive: true, force: true });
      }
      try {
        await moveDirectory(sessionDirInTrash, targetDir);
      } catch (error) {
        throw codedError('restore-failed', `恢复失败（档案仍在回收站）: ${errorMessage(error)}`);
      }

      let attachError;
      let workspaceId;
      try {
        const owner = (registry?.list?.() ?? []).find((entity) => {
          try {
            return entity.path === originalCwd;
          } catch {
            return false;
          }
        });
        if (owner !== undefined) {
          await owner.attachSession(sessionId);
          workspaceId = String(owner.id);
        }
      } catch (error) {
        attachError = errorMessage(error);
      }

      // 归档标记还原
      if (manifest.archived === true) {
        try {
          await registry?.archiveSession?.(sessionId);
        } catch {
          /* 归档集写不回去只影响可见性 */
        }
      }

      await rm(entryDir, { recursive: true, force: true }).catch(() => {});

      // 需要换工作区时，恢复到原位置后走完整移动管线。
      if (targetWs !== undefined) {
        const moved = await moveSession(sessionId, targetWs);
        return { restored: true, sessionId, workspaceId: moved.workspaceId ?? workspaceId, moved: moved.moved, attachError };
      }
      return { restored: true, sessionId, workspaceId, attachError, artifact: join(targetDir, basename(artifactInTrash)) };
    });
  }

  /** 彻底删除回收站条目（先备份，备份失败禁止删除）。 */
  async function purgeTrashEntry(sessionId) {
    assertSafeId(sessionId);
    return await withSessionLock(sessionId, async () => {
      const found = await findTrashEntry(sessionId);
      if (found === undefined) throw codedError('not-found', `回收站里没有会话 ${sessionId}`);
      const { entryDir } = found;
      const sessionDir = join(entryDir, 'session');
      let backupPath;
      if (dirExists(sessionDir)) backupPath = await backupSessionDirectory(sessionId, sessionDir);
      try {
        await rm(entryDir, { recursive: true, force: true });
      } catch (error) {
        throw codedError('purge-failed', `备份已保留在 ${backupPath}，但删除回收站条目失败: ${errorMessage(error)}`);
      }
      await forgetSession(sessionId);
      return { purged: true, sessionId, backupPath };
    });
  }
  // #endregion

  // #region 备份查询
  async function listBackups() {
    const dir = backupDir();
    if (!dirExists(dir)) return { items: [], dir };
    const items = [];
    for (const sessionEntry of await readdir(dir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = join(dir, sessionEntry.name);
      const stamps = [];
      for (const stamp of await readdir(sessionDir, { withFileTypes: true })) {
        if (!stamp.isDirectory()) continue;
        stamps.push({ stamp: stamp.name, sizeBytes: dirSize(join(sessionDir, stamp.name)) });
      }
      stamps.sort((left, right) => right.stamp.localeCompare(left.stamp));
      if (stamps.length === 0) continue;
      items.push({ sessionId: sessionEntry.name, count: stamps.length, latest: stamps[0].stamp, backups: stamps });
    }
    return { items, dir };
  }
  // #endregion


  /** 能力自检：宿主版本差异在这里显式暴露，而不是静默降级。 */
  async function status() {
    const registry = registryOf();
    const persistence = persistenceOf();
    const firstEntity = registry?.list?.()?.[0];
    return {
      plugin: 'dsh-workspace-organizer',
      ready: registry !== undefined && persistence !== undefined,
      capabilities: {
        registry: registry !== undefined,
        persistence: persistence !== undefined,
        locate: typeof persistence?.locate === 'function',
        liveWriter: persistence?.tracker?.writers !== undefined,
        coordinator: typeof persistence?.coordinator?.serialize === 'function',
        // 方法在实体原型上：任意实体的探测结果即该版本的能力位
        insertSessionBefore: typeof firstEntity?.insertSessionBefore === 'function',
        insertBefore: typeof registry?.insertBefore === 'function',
        attachSession: typeof firstEntity?.attachSession === 'function',
        unarchiveSession: typeof registry?.unarchiveSession === 'function'
      },
      artifactNames: ARTIFACT_NAMES,
      storage: {
        sessionsRoot: sessionsRoot(),
        pluginDataDir: pluginDataDir(),
        recycleDir: recycleDir(),
        backupDir: backupDir()
      },
      counts: {
        workspaces: registry?.list?.()?.length ?? 0,
        sessions: (await listStoredHeaders()).length
      }
    };
  }

  return {
    ctx,
    status,
    tree,
    knownSessionIds,
    listStoredHeaders,
    sessionStamps,
    workspaceIds,
    sessionIdsOfWorkspace,
    workspacesOfSession,
    moveSession,
    reorderWorkspace,
    reorderSession,
    deleteSession,
    listTrash,
    restoreFromTrash,
    purgeTrashEntry,
    listBackups,
    backupSessionDirectory,
    forgetSession,
    quiesceSession,
  };
}

/** 空串/undefined/null 统一成 undefined，其余转字符串。 */
function toOptionalId(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}
