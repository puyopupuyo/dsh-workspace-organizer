/**
 * 会话工件（`$DSH_HOME/sessions/<projectKey>/<sessionSegment>/session*.jsonl[.zstd]`）
 * 的定位、读取、原子改写与目录校验。
 *
 * 这里只做**档案层**的事：任何写操作都先校验目标确实是一个会话目录，绝不
 * 顺着调用方给的任意路径删东西。
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { decompressAllZstdFrames, scanZstdFrames, compressArtifact } from './zstd.mjs';
import { assertSafeId, codedError } from './util.mjs';

/** 读取工件时依次尝试的文件名（新格式在前，老格式仍可读）。 */
export const ARTIFACT_NAMES = [
  'session.v4.jsonl.zstd',
  'session.v3.jsonl.zstd',
  'session.v2.jsonl.zstd',
  'session.jsonl.zstd',
  'session.jsonl'
];

/** 头行读取上限。 */
const MAX_HEADER_BYTES = 1024 * 1024;

/** 与 DSH `encodeSegment` 一致的会话目录名编码。 */
export function encodeFsSessionSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('不能编码空的路径片段');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) out += char;
    else out += `~${raw.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** 目录名解码回会话 ID（修复/诊断用）。 */
export function decodeFsSessionSegment(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return encoded;
  if (encoded === '~002E') return '.';
  if (encoded === '~002E~002E') return '..';
  return encoded.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 与 DSH `projectKey` 一致的工作目录目录名编码。 */
export function encodeProjectSegment(path) {
  if (typeof path !== 'string') return '--root--';
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${path.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** 一个会话目录允许的目录名（新编码 / 原始 ID / 老 projectKey 形式）。 */
export function candidateSessionDirs(id) {
  assertSafeId(id);
  const primary = encodeFsSessionSegment(id);
  const candidates = [primary];
  if (id !== primary) candidates.push(id);
  const legacy = encodeProjectSegment(id);
  if (legacy !== primary && legacy !== id) candidates.push(legacy);
  return candidates;
}

/** 从工件文件名解析日志代次；非规范名返回 undefined。 */
export function parseGenerationFromFilename(filename) {
  if (typeof filename !== 'string') return undefined;
  const match = filename.match(/^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/);
  if (match === null) return undefined;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/**
 * 校验 `directory` 确实是一个合法会话目录：
 * 位于 `root` 下恰好两层，第二层 ∈ candidateSessionDirs(id)，且整条链上没有链接。
 */
export async function assertSessionDirectory(root, directory, id, { allowMissing = false } = {}) {
  assertSafeId(id);
  if (typeof root !== 'string' || typeof directory !== 'string') {
    throw codedError('bad-path', '无法验证会话目录，已停止文件操作');
  }
  const base = resolve(root);
  const target = resolve(directory);
  const rel = relative(base, target);
  const parts = rel.split(sep);
  const valid = candidateSessionDirs(id);
  if (rel === '' || /^([A-Za-z]:|\/|\\)/.test(rel) || parts.length !== 2
    || parts.some((part) => part === '..' || part === '.' || part === '')
    || !valid.includes(parts[1])) {
    throw codedError('bad-path', `会话目录超出允许范围，已停止文件操作: ${target}`);
  }
  const canonicalRoot = await realpath(base);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return target;
      throw error;
    }
    if (info.isSymbolicLink()) throw codedError('bad-path', `会话目录不能是符号链接: ${current}`);
    if (!info.isDirectory()) throw codedError('bad-path', `会话目录链上出现普通文件: ${current}`);
    const canonical = await realpath(current);
    const child = relative(canonicalRoot, canonical);
    if (child === '' || relative(canonicalRoot, canonical).startsWith('..')) {
      throw codedError('bad-path', `会话目录解析到了允许范围之外: ${current}`);
    }
  }
  return target;
}

/** 在目录里找最高代的会话工件。 */
export async function findArtifactIn(directory) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  for (const name of ARTIFACT_NAMES) {
    if (names.includes(name)) return join(directory, name);
  }
  const legacy = names.filter((name) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name));
  return legacy.length > 0 ? join(directory, legacy[0]) : undefined;
}

function parseHeaderLine(content) {
  const newline = content.indexOf('\n');
  if (newline < 0) throw new Error('会话工件缺少完整的头行');
  const header = JSON.parse(content.slice(0, newline));
  assertSafeId(header?.id, 'header.id');
  return header;
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw codedError('bad-path', '会话工件必须是普通文件，不能是符号链接');
}

/** 只读头行（不解压整个历史）。 */
export async function readSessionHeader(path) {
  await assertRegularFile(path);
  const handle = await open(path, 'r');
  try {
    let buffer = Buffer.alloc(0);
    while (buffer.length < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - buffer.length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, buffer.length);
      if (bytesRead === 0) break;
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      if (path.endsWith('.zstd')) {
        const { frames } = scanZstdFrames(buffer, 1);
        if (frames.length > 0) {
          const { content } = await decompressAllZstdFrames(buffer.subarray(frames[0].start, frames[0].end));
          return parseHeaderLine(content.toString('utf8'));
        }
      } else if (buffer.includes(10)) {
        return parseHeaderLine(buffer.toString('utf8'));
      }
    }
    throw new Error('会话头行不完整或超过大小限制');
  } finally {
    await handle.close();
  }
}

/**
 * 读完整工件。
 * @returns {Promise<{meta: object, content: string, path: string, filename: string}>}
 */
export async function readSessionFile(path) {
  await assertRegularFile(path);
  const bytes = await readFile(path);
  let content;
  if (path.endsWith('.zstd')) {
    const decoded = await decompressAllZstdFrames(bytes);
    if (decoded.torn) throw new Error('会话日志存在截断的 Zstandard 帧，拒绝重写；请先备份并修复');
    content = decoded.content.toString('utf8');
  } else {
    content = bytes.toString('utf8');
  }
  if (!content.endsWith('\n')) throw new Error('会话日志存在不完整的尾行，拒绝重写');
  return { meta: parseHeaderLine(content), content, path, filename: basename(path) };
}

/** 写临时文件并 fsync。 */
export async function writeTempFile(finalPath, data) {
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
  return temp;
}

/**
 * 原子替换：备份 → 发布 → 删除备份，任一步失败都回滚并报告。
 */
export async function replaceSessionFile(path, bytes) {
  const temp = await writeTempFile(path, bytes);
  const backup = `${path}.${randomBytes(6).toString('hex')}.bak`;
  try {
    await rename(path, backup);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch {
      /* 未提交的临时文件 */
    }
    throw new Error(`无法备份会话工件，未删除原文件: ${error.message}`, { cause: error });
  }
  try {
    await rename(temp, path);
  } catch (error) {
    try {
      await rename(backup, path);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `发布失败且回滚失败；原始会话保留在 ${backup}，新文件保留在 ${temp}`);
    }
    try {
      await rm(temp, { force: true });
    } catch {
      /* 原件已恢复 */
    }
    throw new Error(`发布失败，原始会话已恢复: ${error.message}`, { cause: error });
  }
  try {
    await rm(backup, { force: true });
  } catch {
    return { backupPath: backup };
  }
  return {};
}

/** 编码一次完整工件写入（按目标文件名决定是否 zstd）。 */
export async function encodeArtifact(headerLine, rest, targetPath) {
  if (!targetPath.endsWith('.zstd')) return Buffer.from(`${headerLine}\n${rest}`, 'utf8');
  return await compressArtifact(headerLine, rest);
}

/** 确保目录存在。 */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
  return path;
}
