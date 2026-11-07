/**
 * Host 业务层测试：用真实的临时目录 + 内存版 registry/persistence，
 * 覆盖移动、三种删除、回收站恢复、彻底删除与排序。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createHost } from '../src/host.mjs';
import { encodeFsSessionSegment, encodeProjectSegment } from '../src/session-files.mjs';
import { compressArtifact } from '../src/zstd.mjs';
import { backupDir, recycleDir } from '../src/util.mjs';

let root;
const previousHome = process.env.DSH_HOME;

function makeEntity(id, title, path) {
  return {
    id,
    title,
    path,
    record: { path, title, sessionIds: [] },
    get sessionIds() {
      return [...this.record.sessionIds];
    },
    async attachSession(sessionId) {
      if (!this.record.sessionIds.includes(sessionId)) this.record.sessionIds = [sessionId, ...this.record.sessionIds];
    },
    async detachSession(sessionId) {
      this.record.sessionIds = this.record.sessionIds.filter((value) => value !== sessionId);
    },
    async insertSessionBefore(sessionId, beforeSessionId) {
      const without = this.record.sessionIds.filter((value) => value !== sessionId);
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId);
      without.splice(at < 0 ? without.length : at, 0, sessionId);
      this.record.sessionIds = without;
    }
  };
}

function makeRegistry(entities) {
  let order = entities.map((entity) => entity.id);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return {
    archivedSessionIds: [],
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
    list: () => order.map((id) => byId.get(id)).filter(Boolean),
    insertBefore: async (id, beforeId) => {
      const without = order.filter((value) => value !== id);
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId);
      without.splice(at < 0 ? without.length : at, 0, id);
      order = without;
      return [...order];
    },
    unarchiveSession: async () => {},
    archiveSession: async () => {}
  };
}

function makeCtx(entities, headers) {
  const registry = makeRegistry(entities);
  const persistence = {
    list: async () => headers.map((header) => ({ ...header })),
    locate: (header) => ({
      path: join(root, 'sessions', encodeProjectSegment(header.cwd), encodeFsSessionSegment(String(header.id)), 'session.v4.jsonl.zstd')
    }),
    tracker: { writers: new Map() },
    coordinator: { serialize: async (_sessionId, operation) => await operation() }
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    sessions: {
      get: () => undefined,
      list: () => [],
      flush: async () => {}
    },
    agents: { get: () => undefined },
    get: () => undefined,
    emit: () => {}
  };
  return { ctx, registry, persistence };
}

async function writeSession({ sessionId, cwd, events = 2 }) {
  const dir = join(root, 'sessions', encodeProjectSegment(cwd), encodeFsSessionSegment(sessionId));
  await mkdir(dir, { recursive: true });
  const header = { id: sessionId, cwd, version: 4, createdAt: new Date().toISOString() };
  let body = '';
  for (let index = 0; index < events; index += 1) body += `${JSON.stringify({ type: 'user', seq: index })}\n`;
  const bytes = await compressArtifact(JSON.stringify(header), body);
  const path = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(path, bytes);
  return { dir, path, header, body };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wso-host-'));
  process.env.DSH_HOME = root;
});

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(root, 'sessions'), { recursive: true, force: true }).catch(() => {});
  await rm(join(root, 'workspace-organizer'), { recursive: true, force: true }).catch(() => {});
  await mkdir(join(root, 'ws-a'), { recursive: true });
  await mkdir(join(root, 'ws-b'), { recursive: true });
});

test('persistence.list 返回 {header} 包装时仍能定位会话（真实宿主形态）', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const wsB = await realpath(join(root, 'ws-b'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const entityB = makeEntity('w-b', 'B', wsB);
  const sessionId = 'session-wrapped-1';
  const { header } = await writeSession({ sessionId, cwd: wsA });
  entityA.record.sessionIds = [sessionId];
  // dsh-session-persistence-jsonl 的 list() 返回 { header, revision, sizeBytes }
  const wrapped = [{ header: { ...header }, revision: 'r1', sizeBytes: 123 }];
  const { ctx } = makeCtx([entityA, entityB], wrapped);

  const host = createHost(ctx);
  const result = await host.moveSession(sessionId, 'w-b');
  assert.equal(result.moved, true);
  assert.equal(result.toCwd, wsB);
  assert.ok(entityB.record.sessionIds.includes(sessionId));
});

test('跨工作区移动：改写 cwd、搬档案、换记账、保留历史', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const wsB = await realpath(join(root, 'ws-b'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const entityB = makeEntity('w-b', 'B', wsB);
  const sessionId = 'session-move-1';
  const { path, header, body } = await writeSession({ sessionId, cwd: wsA });
  entityA.record.sessionIds = [sessionId];
  const headers = [{ ...header }];
  const { ctx } = makeCtx([entityA, makeEntity('w-b', 'B', wsB)], headers);

  const host = createHost(ctx);
  const result = await host.moveSession(sessionId, 'w-b');

  assert.equal(result.moved, true);
  assert.equal(result.toCwd, wsB);
  const moved = await readFile(result.artifactTo);
  assert.ok(moved.length > 0);
  const { decompressAllZstdFrames } = await import('../src/zstd.mjs');
  const decoded = (await decompressAllZstdFrames(moved)).content.toString('utf8');
  assert.match(decoded, /"cwd":"[^"]*ws-b"/);
  assert.ok(decoded.endsWith(body), '历史事件必须原样保留');
  assert.deepEqual(entityA.record.sessionIds, []);
  assert.deepEqual(entityA.record.sessionIds.includes(sessionId), false);
});

test('移动到同一工作区只补记账、不搬文件', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const sessionId = 'session-same-1';
  const { header } = await writeSession({ sessionId, cwd: wsA });
  const { ctx } = makeCtx([entityA], [{ ...header }]);
  const host = createHost(ctx);
  const result = await host.moveSession(sessionId, 'w-a');
  assert.equal(result.moved, false);
  assert.equal(result.attached, true);
  assert.ok(entityA.record.sessionIds.includes(sessionId));
});

test('移入回收站 → 恢复：文件与记账都回来', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const sessionId = 'session-trash-1';
  const { path, header } = await writeSession({ sessionId, cwd: wsA });
  entityA.record.sessionIds = [sessionId];
  const { ctx } = makeCtx([entityA], [{ ...header }]);
  const host = createHost(ctx);

  const deletion = await host.deleteSession(sessionId, 'recycle');
  assert.equal(deletion.mode, 'recycle');
  assert.equal(deletion.filesRemoved, true);
  assert.equal(entityA.record.sessionIds.length, 0);
  await assert.rejects(() => readFile(path), /ENOENT/);

  const trash = await host.listTrash();
  assert.equal(trash.items.length, 1);
  assert.equal(trash.items[0].sessionId, sessionId);
  assert.ok(trash.dir.startsWith(recycleDir()));

  const restored = await host.restoreFromTrash(sessionId);
  assert.equal(restored.restored, true);
  const back = await readFile(path);
  assert.ok(back.length > 0);
  assert.ok(entityA.record.sessionIds.includes(sessionId));
  assert.equal((await host.listTrash()).items.length, 0);
});

test('仅移除注册：磁盘档案不动', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const sessionId = 'session-unregister-1';
  const { path, header } = await writeSession({ sessionId, cwd: wsA });
  entityA.record.sessionIds = [sessionId];
  const { ctx } = makeCtx([entityA], [{ ...header }]);
  const host = createHost(ctx);

  const result = await host.deleteSession(sessionId, 'unregister');
  assert.equal(result.filesRemoved, false);
  assert.equal(entityA.record.sessionIds.length, 0);
  assert.ok((await readFile(path)).length > 0);
});

test('彻底删除：先备份再删文件', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const sessionId = 'session-purge-1';
  const { path, header } = await writeSession({ sessionId, cwd: wsA });
  entityA.record.sessionIds = [sessionId];
  const { ctx } = makeCtx([entityA], [{ ...header }]);
  const host = createHost(ctx);

  const result = await host.deleteSession(sessionId, 'purge');
  assert.equal(result.mode, 'purge');
  assert.ok(result.backupPath.startsWith(backupDir()));
  const backedUp = await readFile(join(result.backupPath, 'session', 'session.v4.jsonl.zstd'));
  assert.ok(backedUp.length > 0);
  await assert.rejects(() => readFile(path), /ENOENT/);
  assert.equal(entityA.record.sessionIds.length, 0);
});

test('回收站彻底删除同样先备份', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const sessionId = 'session-trash-purge-1';
  const { header } = await writeSession({ sessionId, cwd: wsA });
  entityA.record.sessionIds = [sessionId];
  const { ctx } = makeCtx([entityA], [{ ...header }]);
  const host = createHost(ctx);

  await host.deleteSession(sessionId, 'recycle');
  const result = await host.purgeTrashEntry(sessionId);
  assert.equal(result.purged, true);
  assert.ok(result.backupPath !== undefined);
  assert.equal((await host.listTrash()).items.length, 0);
});

test('备份失败即拒绝彻底删除（零副作用）', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const sessionId = 'session-no-backup-1';
  const { path, header } = await writeSession({ sessionId, cwd: wsA });
  entityA.record.sessionIds = [sessionId];
  const { ctx } = makeCtx([entityA], [{ ...header }]);
  const host = createHost(ctx);
  // 备份目录位置先放一个普通文件：mkdir 必然失败，备份一定失败
  await mkdir(join(root, 'workspace-organizer'), { recursive: true });
  await writeFile(join(root, 'workspace-organizer', 'backups'), 'not-a-directory', 'utf8');

  await assert.rejects(() => host.deleteSession(sessionId, 'purge'), (error) => error.code === 'backup-failed');
  // 文件、记账都必须原样保留
  assert.ok((await readFile(path)).length > 0);
  assert.equal(entityA.record.sessionIds.includes(sessionId), true);
});

test('工作区与会话排序走官方 registry', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const wsB = await realpath(join(root, 'ws-b'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const entityB = makeEntity('w-b', 'B', wsB);
  const headers = [];
  entityA.record.sessionIds = [];
  const first = 'session-sort-1';
  const second = 'session-sort-2';
  for (const [index, sessionId] of [first, second].entries()) {
    const { header } = await writeSession({ sessionId, cwd: wsA, events: index + 1 });
    headers.push(header);
    entityA.record.sessionIds.push(sessionId);
  }
  const { ctx, registry } = makeCtx([entityA, entityB], headers);
  const host = createHost(ctx);

  const workspaceOrder = await host.reorderWorkspace('w-b', 'w-a');
  assert.deepEqual(workspaceOrder.workspaceIds, ['w-b', 'w-a']);
  assert.deepEqual(registry.list().map((entity) => entity.id), ['w-b', 'w-a']);

  entityA.record.sessionIds = [first, second];
  const reordered = await host.reorderSession(second, first);
  assert.deepEqual(reordered.sessionIds, [second, first]);
});

test('status 暴露宿主能力位', async () => {
  const wsA = await realpath(join(root, 'ws-a'));
  const entityA = makeEntity('w-a', 'A', wsA);
  const { ctx } = makeCtx([entityA], []);
  const host = createHost(ctx);
  const status = await host.status();
  assert.equal(status.ready, true);
  assert.equal(status.capabilities.insertSessionBefore, true);
  assert.equal(status.storage.sessionsRoot, join(root, 'sessions'));
});
