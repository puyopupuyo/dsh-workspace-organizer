/**
 * 只依赖文件系统的单元测试：编码、目录校验、Zstandard 往返、原子替换。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  candidateSessionDirs,
  encodeFsSessionSegment,
  encodeProjectSegment,
  findArtifactIn,
  parseGenerationFromFilename,
  readSessionFile,
  readSessionHeader,
  replaceSessionFile
} from '../src/session-files.mjs';
import { compressArtifact, decompressAllZstdFrames, scanZstdFrames } from '../src/zstd.mjs';
import { assertSafeId, dshHome, dirSize, moveDirectory } from '../src/util.mjs';

let root;
const previousHome = process.env.DSH_HOME;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wso-test-'));
  process.env.DSH_HOME = root;
});

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

test('dshHome 使用 DSH_HOME', () => {
  assert.equal(dshHome(), root);
});

test('会话/项目目录编码与 DSH 约定一致', () => {
  assert.equal(encodeFsSessionSegment('session-abc'), 'session-abc');
  assert.equal(encodeFsSessionSegment('session:1'), 'session~003A1');
  assert.equal(encodeProjectSegment('C:\\Users\\x\\proj'), '--C-Users-x-proj--');
  // 官方目录名在前；老插件留下的 `--id--` 布局作为兼容候选保留。
  const candidates = candidateSessionDirs('session-abc');
  assert.equal(candidates[0], 'session-abc');
  assert.ok(candidates.includes('--session-abc--'));
});

test('代次解析', () => {
  assert.equal(parseGenerationFromFilename('session.v4.jsonl.zstd'), 4);
  assert.equal(parseGenerationFromFilename('session.jsonl'), 0);
  assert.equal(parseGenerationFromFilename('notes.txt'), undefined);
});

test('非法 id 被拒绝', () => {
  assert.throws(() => assertSafeId('../etc'), /不合法/);
  assert.throws(() => assertSafeId('a/b'), /不合法/);
  assert.throws(() => assertSafeId(''), /不合法/);
  assert.equal(assertSafeId('session-ok'), 'session-ok');
});

test('zstd 多帧扫描与往返', async () => {
  const header = JSON.stringify({ id: 'session-x', cwd: 'C:\\a', version: 4 });
  const body = '{"type":"user","seq":0}\n{"type":"assistant","seq":1}\n';
  const bytes = await compressArtifact(header, body);
  const scan = scanZstdFrames(bytes);
  assert.equal(scan.frames.length, 2);
  const decoded = await decompressAllZstdFrames(bytes);
  assert.equal(decoded.content.toString('utf8'), `${header}\n${body}`);
  assert.equal(decoded.torn, false);
});

test('纯文本工件读写与原子替换', async () => {
  const dir = join(root, 'sessions', '--proj--', 'session-x');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'session.jsonl');
  const content = '{"id":"session-x","cwd":"C:\\\\a","version":0}\n{"type":"user","seq":0}\n';
  await writeFile(path, content, 'utf8');

  const header = await readSessionHeader(path);
  assert.equal(header.id, 'session-x');

  const file = await readSessionFile(path);
  assert.equal(file.meta.cwd, 'C:\\a');
  assert.equal(file.content, content);

  const next = content.replace('C:\\\\a', 'C:\\\\b');
  await replaceSessionFile(path, Buffer.from(next, 'utf8'));
  const reread = await readFile(path, 'utf8');
  assert.equal(reread, next);
  assert.equal(await findArtifactIn(dir), join(dir, 'session.jsonl'));
});

test('截断的 zstd 帧被拒绝写入', async () => {
  const dir = join(root, 'sessions', '--proj2--', 'session-y');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'session.v4.jsonl.zstd');
  const bytes = await compressArtifact('{"id":"session-y","cwd":"C:\\\\a","version":4}', '{"type":"user","seq":0}\n');
  await writeFile(path, bytes.subarray(0, bytes.length - 3));
  await assert.rejects(() => readSessionFile(path), /空|损坏|截断|缺少/);
});

test('目录大小与跨盘搬移回退路径', async () => {
  const from = join(root, 'move-from');
  const to = join(root, 'move-to');
  await mkdir(from, { recursive: true });
  await writeFile(join(from, 'a.txt'), 'hello', 'utf8');
  assert.ok(dirSize(from) > 0);
  await moveDirectory(from, to);
  assert.equal(await readFile(join(to, 'a.txt'), 'utf8'), 'hello');
});
