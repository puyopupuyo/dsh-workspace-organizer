/**
 * dsh-workspace-organizer — 共享常量与无依赖工具。
 *
 * 命名四同步（改动时必须一起改）：
 *   1. package.json 的 name
 *   2. cordis.patch.yml 的 name
 *   3. 本文件的 NAME
 *   4. client.js 的 loader id 与 exports.name
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 插件名（四同步之一）。 */
export const NAME = 'dsh-workspace-organizer';

/** Client ⇄ Host 的 RPC 通道名。 */
export const CHANNEL = '/workspace-organizer';

/** 插件数据目录名（$DSH_HOME 下）。 */
export const DATA_DIR_NAME = 'workspace-organizer';

/** 回收站条目的清单文件名。 */
export const TRASH_MANIFEST = 'manifest.json';

/** 每个会话保留的彻底删除备份份数。 */
export const BACKUP_KEEP = 20;

/** 单次请求体上限。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 会话 ID 合法性：只允许安全单段字符，禁止路径穿越与保留名。 */
export function assertSafeId(value, label = 'sessionId') {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 400
    || value === '.' || value === '..'
    || /[\\/\x00-\x1f<>"|?*]/.test(value) || /[. ]$/.test(value)) {
    throw Object.assign(new Error(`${label} 不合法，不能包含路径或特殊目录名`), { code: 'invalid-input' });
  }
  return value;
}

/** 工作区 ID 比会话 ID 宽松（UUID），但仍拒绝路径字符。 */
export function assertWorkspaceId(value) {
  return assertSafeId(value, 'workspaceId');
}

/** 失败但可安全重试于其他分支的统一错误。 */
export function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** 消息归一化，日志/Toast 都用它，不泄漏 undefined。 */
export function errorMessage(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** DSH 家目录：优先 $DSH_HOME，其次 $HOME/.dsh。 */
export function dshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : undefined;
  if (explicit !== undefined) return resolve(explicit);
  const home = env.USERPROFILE ?? env.HOME;
  if (typeof home !== 'string' || home === '') throw codedError('unsupported', '无法确定 DSH 家目录（$DSH_HOME / $USERPROFILE 均未设置）');
  return join(home, '.dsh');
}

/** 插件数据目录。 */
export function pluginDataDir(env = process.env) {
  return join(dshHome(env), DATA_DIR_NAME);
}

/** 会话根目录。 */
export function sessionsRoot(env = process.env) {
  return join(dshHome(env), 'sessions');
}

/** 回收站目录。 */
export function recycleDir(env = process.env) {
  return join(pluginDataDir(env), 'recycle');
}

/** 备份目录。 */
export function backupDir(env = process.env) {
  return join(pluginDataDir(env), 'backups');
}

/** 目录是否存在（不抛错）。 */
export function dirExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 递归目录大小（字节），失败部分按 0 计。 */
export function dirSize(path) {
  let total = 0;
  let names = [];
  try {
    names = readdirSync(path);
  } catch {
    return 0;
  }
  for (const name of names) {
    const child = join(path, name);
    let info;
    try {
      info = statSync(child);
    } catch {
      continue;
    }
    if (info.isDirectory()) total += dirSize(child);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

/** 逐层校验一个目录确实是 root 之下、不含符号链接/junction 的普通目录链。 */
export async function assertInsideNoLink(root, target, { allowMissing = false } = {}) {
  const canonicalRoot = await realpath(resolve(root));
  const absoluteTarget = resolve(target);
  const rel = relative(canonicalRoot, absoluteTarget);
  const parts = rel.split(sep);
  if (rel === '' || isAbsolute(rel) || parts.some((part) => part === '..' || part === '.' || part === '')) {
    throw codedError('bad-path', `目标目录不在允许范围内: ${absoluteTarget}`);
  }
  let current = canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = await stat(current);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return absoluteTarget;
      throw error;
    }
    if (!info.isDirectory()) throw codedError('bad-path', `目标路径不是普通目录: ${current}`);
    const canonical = await realpath(current);
    const child = relative(canonicalRoot, canonical);
    if (child === '' || isAbsolute(child) || child.split(sep).includes('..')) {
      throw codedError('bad-path', `目标目录解析到了允许范围之外: ${current}`);
    }
  }
  return absoluteTarget;
}

/** 同盘 rename，跨盘（EXDEV）时退化为「复制整目录 + 删除源」。 */
export async function moveDirectory(from, to) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
    return 'rename';
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyDirectory(from, to);
    await rm(from, { recursive: true, force: true });
    return 'copy';
  }
}

/** 递归复制目录（保留符号链接为失败，避免把 link 带出沙箱）。 */
export async function copyDirectory(from, to) {
  const info = await stat(from);
  if (!info.isDirectory()) throw codedError('bad-path', `源路径不是目录: ${from}`);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isSymbolicLink()) throw codedError('bad-path', `拒绝复制符号链接: ${source}`);
    if (entry.isDirectory()) await copyDirectory(source, dest);
    else if (entry.isFile()) await copyFileDurable(source, dest);
  }
}

/** 复制单文件并 fsync，用于备份完整性。 */
async function copyFileDurable(from, to) {
  const { copyFile } = await import('node:fs/promises');
  await copyFile(from, to);
}

/** 原子写：临时文件 + fsync + rename。 */
export async function atomicWrite(finalPath, data) {
  await mkdir(dirname(finalPath), { recursive: true });
  const temp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
  } catch (error) {
    try {
      await handle.close();
    } catch {
      /* 保持原始错误 */
    }
    try {
      await rm(temp, { force: true });
    } catch {
      /* 未提交的临时文件 */
    }
    throw error;
  }
  try {
    await rename(temp, finalPath);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch {
      /* 保持原始错误 */
    }
    throw error;
  }
}

/** 内容指纹（备份去重用）。 */
export function fingerprint(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 24);
}

/** 生成一个不会与既有目录冲突的条目名。 */
export function uniqueEntryName(prefix, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `${Date.now()}-${safe}`;
}

/** 清理目录但保留第一个错误（用于回滚，不吞掉根因）。 */
export function bestEffortRemove(path) {
  try {
    rmSync(path, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return error;
  }
}
