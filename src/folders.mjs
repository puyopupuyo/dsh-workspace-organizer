/**
 * dsh-workspace-organizer — 工作区内部虚拟文件夹（收纳）数据层。
 *
 * 定位（用户拍板）：文件夹是**工作区内部的视图层容器** ——
 *   - 只改渲染与元数据，不改 `header.cwd`、不移动磁盘文件、不删除会话；
 *   - 未收纳会话与文件夹在工作区内**同级交错**，顺序由 WorkspaceItemOrder 决定；
 *   - 关掉插件后侧边栏回到官方行为，数据留在 sidecar 里。
 *
 * 三个实体写在**同一个** sidecar（`$DSH_HOME/workspace-organizer/folders.v1.json`），
 * 写入走 `atomicWrite`（临时文件 + fsync + rename），不会留下半个文件。
 * sidecar 损坏时**回退到「全部未收纳」**（空状态），而不是抛错让界面白屏；
 * 坏文件先改名为 `.corrupt-<时间戳>` 留档，再以空状态继续。
 *
 *   WorkspaceFolder  { id, workspaceId, name, color?, icon?, collapsed?, order }
 *   FolderMembership { folderId, sessionId, orderInFolder }
 *   WorkspaceItemOrder { workspaceId, items: [{ type: 'folder' | 'session', id }] }
 *
 * workspaceId 必填是层级正确的前提；sessionId 直接用 Session ID（与成本/状态
 * 数据同一把钥匙）。一个会话在同一时刻最多属于一个文件夹。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, codedError, errorMessage, pluginDataDir } from './util.mjs';

/** sidecar 文件名（单文件，三个实体同存）。 */
export const FOLDERS_FILE = 'folders.v1.json';

/** sidecar 结构版本；未来格式迁移靠它识别。 */
export const FOLDERS_VERSION = 2;

/** 文件夹名长度上限。 */
export const MAX_FOLDER_NAME = 60;

/** 文件夹数量上限（防御异常写入，不是产品限制）。 */
export const MAX_FOLDERS = 500;

/** 图标字段长度上限（emoji 或短名）。 */
export const MAX_ICON_LENGTH = 8;

/** 颜色只接受 #rrggbb，避免把任意 CSS 写进样式。 */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 文件夹 ID 形态：`f_` + 短随机串；校验一次防止脏数据进 DOM。 */
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** sidecar 绝对路径。 */
export function foldersFilePath(env = process.env) {
  return join(pluginDataDir(env), FOLDERS_FILE);
}

/** 空状态：全部未收纳。 */
export function emptyFoldersState() {
  return { version: FOLDERS_VERSION, folders: [], memberships: [], orders: {} };
}

/** 生成一个不会重复的文件夹 ID。 */
function newFolderId(existing) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `f_${randomBytes(4).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
  throw codedError('conflict', '无法生成唯一的文件夹 ID');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toOrder(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/** 规范化文件夹名，顺带给出可读的失败原因。 */
function normalizeName(value) {
  const name = trimText(value);
  if (name === '') throw codedError('invalid-input', '文件夹名不能为空');
  if (name.length > MAX_FOLDER_NAME) {
    throw codedError('invalid-input', `文件夹名最多 ${MAX_FOLDER_NAME} 个字符`);
  }
  return name;
}

/** workspaceId 是层级正确的前提：必填、非空、不含控制字符。 */
function normalizeWorkspaceId(value) {
  const id = trimText(value);
  if (id === '') throw codedError('invalid-input', 'workspaceId 必填');
  if (id.length > 400) throw codedError('invalid-input', 'workspaceId 过长');
  if (/[\u0000-\u001f]/.test(id)) throw codedError('invalid-input', 'workspaceId 不合法');
  return id;
}

function normalizeColor(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const color = String(value).trim();
  if (!COLOR_PATTERN.test(color)) throw codedError('invalid-input', '颜色必须是 #rrggbb 形式');
  return color.toLowerCase();
}

function normalizeIcon(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const icon = String(value).trim();
  if (icon.length > MAX_ICON_LENGTH) throw codedError('invalid-input', `图标最多 ${MAX_ICON_LENGTH} 个字符`);
  return icon;
}

/** 把任意原始对象收敛成合法状态；非法条目丢弃而不是整体失败。 */
export function normalizeFoldersState(raw, logger = console) {
  const state = emptyFoldersState();
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) logger?.warn?.('workspace-organizer: folders sidecar 结构异常，已按全部未收纳处理');
    return state;
  }

  const rawFolders = Array.isArray(raw.folders) ? raw.folders : [];
  const seenFolders = new Set();
  const draft = [];
  for (const item of rawFolders) {
    if (!isPlainObject(item)) continue;
    const id = trimText(item.id);
    if (!FOLDER_ID_PATTERN.test(id) || seenFolders.has(id)) continue;
    const name = trimText(item.name).slice(0, MAX_FOLDER_NAME);
    const workspaceId = trimText(item.workspaceId);
    // 没有归属工作区的文件夹是脏数据：层级无从谈起，丢弃。
    if (name === '' || workspaceId === '') continue;
    seenFolders.add(id);
    draft.push({
      id,
      workspaceId,
      name,
      color: typeof item.color === 'string' && COLOR_PATTERN.test(item.color) ? item.color.toLowerCase() : undefined,
      icon: typeof item.icon === 'string' && item.icon !== '' ? item.icon.slice(0, MAX_ICON_LENGTH) : undefined,
      collapsed: item.collapsed === true,
      order: toOrder(item.order, draft.length)
    });
  }
  draft.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (draft.length > MAX_FOLDERS) draft.length = MAX_FOLDERS;
  state.folders = draft.map((folder, index) => ({ ...folder, order: index }));

  const folderIds = new Set(state.folders.map((folder) => folder.id));
  const rawMemberships = Array.isArray(raw.memberships) ? raw.memberships : [];
  const seenSessions = new Set();
  const memberships = [];
  for (const item of rawMemberships) {
    if (!isPlainObject(item)) continue;
    const folderId = trimText(item.folderId);
    // 兼容旧版字段名 projectId（它本来就是 Session ID）。
    const sessionId = trimText(item.sessionId) || trimText(item.projectId);
    if (!folderIds.has(folderId) || sessionId === '' || seenSessions.has(sessionId)) continue;
    seenSessions.add(sessionId);
    memberships.push({ folderId, sessionId, orderInFolder: toOrder(item.orderInFolder, memberships.length) });
  }
  memberships.sort((a, b) => a.orderInFolder - b.orderInFolder);
  // 每个文件夹内部重新编号，保证顺序字段连续且互不重叠。
  const perFolder = new Map();
  for (const membership of memberships) {
    const next = perFolder.get(membership.folderId) ?? 0;
    membership.orderInFolder = next;
    perFolder.set(membership.folderId, next + 1);
  }
  state.memberships = memberships;

  const memberOf = new Set(state.memberships.map((membership) => membership.sessionId));
  const folderById = new Map(state.folders.map((folder) => [folder.id, folder]));
  const rawOrders = isPlainObject(raw.orders) ? raw.orders : {};
  for (const workspaceId of Object.keys(rawOrders)) {
    const key = trimText(workspaceId);
    if (key === '') continue;
    const items = Array.isArray(rawOrders[workspaceId]) ? rawOrders[workspaceId] : [];
    const seenItems = new Set();
    const normalized = [];
    for (const item of items) {
      if (!isPlainObject(item)) continue;
      const type = item.type === 'folder' ? 'folder' : item.type === 'session' ? 'session' : item.type === 'project' ? 'session' : undefined;
      const id = trimText(item.id);
      if (type === undefined || id === '') continue;
      if (type === 'folder') {
        const folder = folderById.get(id);
        // 文件夹只能出现在自己所属工作区的顺序表里。
        if (folder === undefined || folder.workspaceId !== key) continue;
      } else if (memberOf.has(id)) {
        // 已经收进文件夹的会话不占工作区顶层槽位。
        continue;
      }
      const itemKey = `${type}:${id}`;
      if (seenItems.has(itemKey)) continue;
      seenItems.add(itemKey);
      normalized.push({ type, id });
    }
    if (normalized.length === 0) continue;
    state.orders[key] = normalized;
  }

  // 每个工作区里，未出现在顺序表里的文件夹补到末尾（按 order）。
  for (const folder of state.folders) {
    const key = folder.workspaceId;
    if (state.orders[key] === undefined) state.orders[key] = [];
    const present = state.orders[key].some((item) => item.type === 'folder' && item.id === folder.id);
    if (!present) state.orders[key].push({ type: 'folder', id: folder.id });
  }

  return state;
}

/** 深拷贝状态，避免写入中途的脏读。 */
function cloneState(state) {
  const orders = {};
  for (const key of Object.keys(state.orders)) {
    orders[key] = state.orders[key].map((item) => ({ ...item }));
  }
  return {
    version: FOLDERS_VERSION,
    folders: state.folders.map((folder) => ({ ...folder })),
    memberships: state.memberships.map((membership) => ({ ...membership })),
    orders
  };
}

/**
 * sessionId → 所属文件夹集合（成本聚合用的反向索引）。
 *
 * 删会话 / 归档 / 水位变化时，靠它一步定位受影响文件夹，而不是遍历全部文件夹
 * （更不遍历 DOM）。它必须与 memberships 是同一份事实，所以只在 `mutate()` 里
 * 随状态一起重建，并与 cache 同时生效——两者不会出现半更新。
 */
export function buildSessionIndex(state) {
  const index = new Map();
  for (const membership of state?.memberships ?? []) {
    let set = index.get(membership.sessionId);
    if (set === undefined) {
      set = new Set();
      index.set(membership.sessionId, set);
    }
    set.add(membership.folderId);
  }
  return index;
}

/**
 * 建立绑定当前插件实例的文件夹数据门面。
 *
 * 所有写操作走同一条串行链：读 → 改副本 → 原子落盘 → 更新缓存。
 * 落盘失败时缓存不变，本次操作**整体回滚**（调用方收到异常）。
 */
export function createFolderStore(ctx = {}) {
  const logger = ctx.logger ?? console;
  const filePath = () => foldersFilePath();

  let cache = null;
  let loading = null;
  let chain = Promise.resolve();
  /** 与 cache 同生共死的反向索引（见 buildSessionIndex）。 */
  let sessionIndex = new Map();

  /** 读 sidecar；坏文件留档后按空状态继续。 */
  function readState() {
    const path = filePath();
    if (!existsSync(path)) return emptyFoldersState();
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      logger?.warn?.(`workspace-organizer: 文件夹文件读取失败，已按全部未收纳处理: ${errorMessage(error)}`);
      return emptyFoldersState();
    }
    if (text.trim() === '') return emptyFoldersState();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      quarantine(path, error);
      return emptyFoldersState();
    }
    if (!isPlainObject(parsed)) {
      quarantine(path, new Error('顶层不是对象'));
      return emptyFoldersState();
    }
    return normalizeFoldersState(parsed, logger);
  }

  /** 坏文件改名为 .corrupt-<时间戳>，绝不就地覆盖用户数据。 */
  function quarantine(path, error) {
    const target = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, target);
      logger?.warn?.(`workspace-organizer: 文件夹文件损坏（${errorMessage(error)}），已留档到 ${target}，当前按全部未收纳处理`);
    } catch (renameError) {
      logger?.warn?.(`workspace-organizer: 文件夹文件损坏且留档失败（${errorMessage(renameError)}），当前按全部未收纳处理`);
    }
  }

  /** 保证缓存已加载（并发调用共享同一次读取）。 */
  function ensureLoaded() {
    if (cache !== null) return Promise.resolve(cache);
    if (loading === null) {
      loading = Promise.resolve()
        .then(() => {
          cache = readState();
          sessionIndex = buildSessionIndex(cache);
          return cache;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  /** 预热：插件装载时读一次，之后 getSessionsInFolder 才有同步数据可答。 */
  function warm() {
    return ensureLoaded();
  }

  /** 落盘（原子写）。 */
  async function writeState(state) {
    const payload = {
      version: FOLDERS_VERSION,
      updatedAt: new Date().toISOString(),
      folders: state.folders,
      memberships: state.memberships,
      orders: state.orders
    };
    await atomicWrite(filePath(), Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
  }

  /** 串行化一次写入事务。 */
  function mutate(operation) {
    const run = async () => {
      const current = await ensureLoaded();
      const draft = cloneState(current);
      const extra = operation(draft) ?? {};
      const next = normalizeFoldersState(draft, logger);
      await writeState(next);
      cache = next;
      // 归属与反向索引一起翻页：add/remove/prune 之后立刻能定位受影响文件夹。
      sessionIndex = buildSessionIndex(next);
      return { ...publicState(next), ...extra };
    };
    const task = chain.then(run, run);
    chain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /** 对外状态（只读快照）。 */
  function publicState(state) {
    const orders = {};
    for (const key of Object.keys(state.orders)) {
      orders[key] = state.orders[key].map((item) => ({ ...item }));
    }
    return {
      version: state.version,
      folders: state.folders.map((folder) => ({ ...folder })),
      memberships: state.memberships.map((membership) => ({ ...membership })),
      orders,
      file: filePath()
    };
  }

  function findFolder(state, folderId) {
    const id = trimText(folderId);
    if (!FOLDER_ID_PATTERN.test(id)) throw codedError('invalid-input', 'folderId 不合法');
    const folder = state.folders.find((item) => item.id === id);
    if (folder === undefined) throw codedError('not-found', `文件夹不存在: ${id}`);
    return folder;
  }

  function assertSessionId(sessionId) {
    const id = trimText(sessionId);
    if (id === '') throw codedError('invalid-input', 'sessionId 必填');
    if (id.length > 400 || /[\\/\u0000-\u001f]/.test(id)) throw codedError('invalid-input', 'sessionId 不合法');
    return id;
  }

  /** 读取当前文件夹状态。 */
  async function state() {
    return publicState(await ensureLoaded());
  }

  /** 新建文件夹（必须落在某个工作区里）。 */
  async function createFolder(input = {}) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const name = normalizeName(input.name);
    const color = normalizeColor(input.color);
    const icon = normalizeIcon(input.icon);
    return await mutate((draft) => {
      if (draft.folders.length >= MAX_FOLDERS) throw codedError('conflict', `文件夹数量已达上限 ${MAX_FOLDERS}`);
      const lower = name.toLowerCase();
      if (draft.folders.some((folder) => folder.workspaceId === workspaceId && folder.name.toLowerCase() === lower)) {
        throw codedError('conflict', `该工作区已存在同名文件夹：${name}`);
      }
      const id = newFolderId(new Set(draft.folders.map((folder) => folder.id)));
      draft.folders.push({ id, workspaceId, name, color, icon, collapsed: false, order: draft.folders.length });
      if (draft.orders[workspaceId] === undefined) draft.orders[workspaceId] = [];
      draft.orders[workspaceId].push({ type: 'folder', id });
      return { folderId: id, workspaceId };
    });
  }

  /** 改文件夹属性（名称 / 颜色 / 图标 / 折叠态）。 */
  async function updateFolder(folderId, patch = {}) {
    return await mutate((draft) => {
      const folder = findFolder(draft, folderId);
      if (Object.hasOwn(patch, 'name')) {
        const name = normalizeName(patch.name);
        const lower = name.toLowerCase();
        if (
          draft.folders.some(
            (item) => item.id !== folder.id && item.workspaceId === folder.workspaceId && item.name.toLowerCase() === lower
          )
        ) {
          throw codedError('conflict', `该工作区已存在同名文件夹：${name}`);
        }
        folder.name = name;
      }
      if (Object.hasOwn(patch, 'color')) folder.color = normalizeColor(patch.color);
      if (Object.hasOwn(patch, 'icon')) folder.icon = normalizeIcon(patch.icon);
      if (Object.hasOwn(patch, 'collapsed')) folder.collapsed = patch.collapsed === true;
      return { folderId: folder.id };
    });
  }

  /**
   * 删除文件夹：只删分组关系，**绝不**碰会话/磁盘。
   * 内部会话回退到同级未收纳区（顺序表里移除文件夹项即可）。
   */
  async function deleteFolder(folderId) {
    return await mutate((draft) => {
      const folder = findFolder(draft, folderId);
      const released = draft.memberships.filter((membership) => membership.folderId === folder.id).map((membership) => membership.sessionId);
      draft.folders = draft.folders.filter((item) => item.id !== folder.id);
      draft.memberships = draft.memberships.filter((membership) => membership.folderId !== folder.id);
      for (const key of Object.keys(draft.orders)) {
        draft.orders[key] = draft.orders[key].filter((item) => !(item.type === 'folder' && item.id === folder.id));
        if (draft.orders[key].length === 0) delete draft.orders[key];
      }
      draft.folders.forEach((item, index) => {
        item.order = index;
      });
      return { folderId: folder.id, releasedSessions: released };
    });
  }

  /** 收纳会话到文件夹（已在别的文件夹时是「移动」）。收纳会从工作区顶层顺序里摘掉它。 */
  async function addToFolder(folderId, sessionId, options = {}) {
    const id = assertSessionId(sessionId);
    const before =
      options.beforeSessionId === undefined || options.beforeSessionId === null ? undefined : assertSessionId(options.beforeSessionId);
    return await mutate((draft) => {
      const folder = findFolder(draft, folderId);
      if (before !== undefined && before === id) return { folderId: folder.id, sessionId: id, changed: false };
      const siblings = draft.memberships
        .filter((membership) => membership.folderId === folder.id && membership.sessionId !== id)
        .sort((a, b) => a.orderInFolder - b.orderInFolder)
        .map((membership) => membership.sessionId);
      if (before !== undefined && !siblings.includes(before)) {
        throw codedError('not-found', '锚点会话不在该文件夹里');
      }
      const position = before === undefined ? siblings.length : siblings.indexOf(before);
      siblings.splice(position, 0, id);
      const rest = draft.memberships.filter((membership) => membership.sessionId !== id && membership.folderId !== folder.id);
      const rebuilt = siblings.map((session, index) => ({ folderId: folder.id, sessionId: session, orderInFolder: index }));
      draft.memberships = [...rest, ...rebuilt];
      const workspaceId = folder.workspaceId;
      if (draft.orders[workspaceId] !== undefined) {
        draft.orders[workspaceId] = draft.orders[workspaceId].filter((item) => !(item.type === 'session' && item.id === id));
      }
      return { folderId: folder.id, sessionId: id, workspaceId };
    });
  }

  /** 移出文件夹 → 回到同级未收纳区（默认排在末尾）。 */
  async function removeFromFolder(sessionId, options = {}) {
    const id = assertSessionId(sessionId);
    return await mutate((draft) => {
      const existing = draft.memberships.find((membership) => membership.sessionId === id);
      if (existing === undefined) return { sessionId: id, changed: false };
      const folder = draft.folders.find((item) => item.id === existing.folderId);
      const workspaceId = folder === undefined ? undefined : folder.workspaceId;
      draft.memberships = draft.memberships.filter((membership) => membership.sessionId !== id);
      draft.memberships
        .filter((membership) => membership.folderId === existing.folderId)
        .sort((a, b) => a.orderInFolder - b.orderInFolder)
        .forEach((membership, index) => {
          membership.orderInFolder = index;
        });
      if (workspaceId !== undefined && options.placeAtTop === true) {
        if (draft.orders[workspaceId] === undefined) draft.orders[workspaceId] = [];
        draft.orders[workspaceId].push({ type: 'session', id });
      }
      return { sessionId: id, folderId: existing.folderId, workspaceId, changed: true };
    });
  }

  /** 组内排序：把会话放到同组锚点之前（无锚点则末尾）。 */
  async function reorderInFolder(folderId, sessionId, beforeSessionId) {
    const id = assertSessionId(sessionId);
    const before = beforeSessionId === undefined || beforeSessionId === null ? undefined : assertSessionId(beforeSessionId);
    return await mutate((draft) => {
      const folder = findFolder(draft, folderId);
      const membership = draft.memberships.find((item) => item.sessionId === id);
      if (membership === undefined || membership.folderId !== folder.id) {
        throw codedError('not-found', '该会话不在指定文件夹里');
      }
      if (before === id) return { folderId: folder.id, changed: false };
      const ordered = draft.memberships
        .filter((item) => item.folderId === folder.id && item.sessionId !== id)
        .sort((a, b) => a.orderInFolder - b.orderInFolder)
        .map((item) => item.sessionId);
      if (before !== undefined && !ordered.includes(before)) {
        throw codedError('not-found', '锚点会话不在该文件夹里');
      }
      const position = before === undefined ? ordered.length : ordered.indexOf(before);
      ordered.splice(position, 0, id);
      for (const candidate of draft.memberships) {
        if (candidate.folderId !== folder.id) continue;
        const index = ordered.indexOf(candidate.sessionId);
        if (index >= 0) candidate.orderInFolder = index;
      }
      return { folderId: folder.id, changed: true };
    });
  }

  /** 工作区顶层顺序：items 全量替换（非法项丢弃、跨区文件夹忽略、已收纳会话不算顶层）。 */
  async function setOrder(workspaceId, items) {
    const key = normalizeWorkspaceId(workspaceId);
    if (!Array.isArray(items)) throw codedError('invalid-input', 'items 必须是数组');
    return await mutate((draft) => {
      draft.orders[key] = items.map((item) => ({ type: item?.type, id: item?.id }));
      return { workspaceId: key, changed: true };
    });
  }

  /** 删除会话时清理它的归属（不触发任何文件操作）。 */
  async function pruneSession(sessionId) {
    const id = assertSessionId(sessionId);
    return await mutate((draft) => {
      const existed = draft.memberships.some((membership) => membership.sessionId === id);
      draft.memberships = draft.memberships.filter((membership) => membership.sessionId !== id);
      for (const key of Object.keys(draft.orders)) {
        draft.orders[key] = draft.orders[key].filter((item) => !(item.type === 'session' && item.id === id));
        if (draft.orders[key].length === 0) delete draft.orders[key];
      }
      return { sessionId: id, changed: existed };
    });
  }

  /**
   * 文件夹下所有会话 ID（按组内顺序）。
   *
   * 这是给「文件夹总计花费」预留的只读接口：成本聚合模块直接调用它，
   * 不需要遍历 DOM，也不靠猜归属关系。同步返回，前提是 warm()/state() 已跑过。
   */
  function getSessionsInFolder(folderId) {
    if (cache === null) return [];
    const id = trimText(folderId);
    return cache.memberships
      .filter((membership) => membership.folderId === id)
      .sort((a, b) => a.orderInFolder - b.orderInFolder)
      .map((membership) => membership.sessionId);
  }

  /** 某会话当前在哪些文件夹里（反向索引，同步；成本聚合按它定位受影响文件夹）。 */
  function foldersOfSession(sessionId) {
    const set = sessionIndex.get(trimText(sessionId));
    return set === undefined ? [] : [...set];
  }

  /** 当前全部文件夹 ID（成本快照按它遍历；只读，不落盘）。 */
  function folderIds() {
    if (cache === null) return [];
    return cache.folders.map((folder) => folder.id);
  }

  return {
    file: filePath,
    warm,
    state,
    createFolder,
    updateFolder,
    deleteFolder,
    addToFolder,
    removeFromFolder,
    reorderInFolder,
    setOrder,
    pruneSession,
    getSessionsInFolder,
    foldersOfSession,
    folderIds
  };
}

/**
 * 最近一次装载的文件夹门面。`getSessionsInFolder` / `foldersOfSession` 是模块级
 * 导出的同步接口，供同进程内的其他 Host 模块（成本聚合）直接调用。
 */
let activeStore = null;

/** 插件 apply 时挂上当前实例的门面。 */
export function registerFolderStore(store) {
  activeStore = store;
}

/** 模块级只读接口：某文件夹下所有会话 ID（无插件实例时返回空数组）。 */
export function getSessionsInFolder(folderId) {
  return activeStore === null ? [] : activeStore.getSessionsInFolder(folderId);
}

/** 模块级只读接口：某会话所属的文件夹 ID 列表（无插件实例时返回空数组）。 */
export function foldersOfSession(sessionId) {
  return activeStore === null ? [] : activeStore.foldersOfSession(sessionId);
}
