/**
 * apply() 接线测试：用最小的 cordis ctx 替身，验证 RPC 通道注册、权限选项、
 * 参数校验与错误映射，不依赖真实 DSH 运行时。
 */
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { apply, inject, name } from '../src/index.mjs';

const previousHome = process.env.DSH_HOME;
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wso-apply-'));
  process.env.DSH_HOME = root;
});

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

/** 搭一个够用的 ctx：slots 不参与（host 半不注册 slot），connection.rpc 捕获注册。 */
function makeCtx() {
  const captured = { channel: null, dispatch: null, options: null };
  const entity = {
    id: 'w-a',
    title: 'A',
    path: '/tmp/a',
    record: { path: '/tmp/a', title: 'A', sessionIds: [] },
    sessionIds: [],
    attachSession: async () => {},
    detachSession: async () => {},
    insertSessionBefore: async () => {}
  };
  const registry = {
    archivedSessionIds: [],
    list: () => [entity],
    insertBefore: async () => ['w-a'],
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
    unarchiveSession: async () => {}
  };
  const persistence = {
    list: async () => [],
    locate: () => undefined,
    tracker: { writers: new Map() },
    coordinator: { serialize: async (_id, operation) => await operation() }
  };
  const connection = {
    rpc: {
      handle: (channel, dispatch, options) => {
        captured.channel = channel;
        captured.dispatch = dispatch;
        captured.options = options;
        return () => {};
      }
    }
  };
  const listeners = new Map();
  const ctx = {
    logger: { info() {}, warn() {} },
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    sessions: { get: () => undefined, list: () => [], flush: async () => {} },
    agents: { get: () => undefined },
    connection,
    webServer: {},
    slots: { inject() {}, register() {} },
    get: () => undefined,
    emit: () => {},
    on: (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    inject: (_names, callback) => callback({ connection, webServer: {}, effect: () => {} }),
    effect: (fn) => {
      const dispose = fn();
      return dispose;
    }
  };
  return { ctx, captured, listeners };
}

test('插件元信息与四同步一致', () => {
  assert.equal(name, 'dsh-workspace-organizer');
  assert.deepEqual(inject, ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents', 'connection', 'webServer']);
});

test('apply 注册回环 RPC 通道', () => {
  const { ctx, captured } = makeCtx();
  apply(ctx);
  assert.equal(captured.channel, '/workspace-organizer');
  assert.equal(typeof captured.dispatch, 'function');
  assert.equal(captured.options?.authority, 'loopback');
});

test('status/tree 端点返回 ok 包装', async () => {
  const { ctx, captured } = makeCtx();
  apply(ctx);
  const status = await captured.dispatch('organizer.status', {});
  assert.equal(status.ok, true);
  assert.equal(status.value.plugin, 'dsh-workspace-organizer');
  assert.equal(status.value.capabilities.insertSessionBefore, true);

  const tree = await captured.dispatch('organizer.tree', {});
  assert.equal(tree.ok, true);
  assert.equal(tree.value.workspaces.length, 1);
});

test('端点参数缺失与未知端点被映射成错误码', async () => {
  const { ctx, captured } = makeCtx();
  apply(ctx);
  const missing = await captured.dispatch('organizer.move', { sessionId: 'session-x' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'invalid-input');

  const unknown = await captured.dispatch('organizer.nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'bad-endpoint');
});

test('删除未知会话返回 not-found', async () => {
  const { ctx, captured } = makeCtx();
  apply(ctx);
  const result = await captured.dispatch('organizer.delete', { sessionId: 'session-missing', mode: 'unregister' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not-found');
});

test('回收站列表在空目录下是空数组', async () => {
  const { ctx, captured } = makeCtx();
  apply(ctx);
  const trash = await captured.dispatch('organizer.trash.list', {});
  assert.equal(trash.ok, true);
  assert.deepEqual(trash.value.items, []);
});

test('成本端点：无数据源时快照标明不可用，不抛', async () => {
  const { ctx, captured } = makeCtx();
  apply(ctx);
  // 临时 DSH_HOME 里没有投影缓存/喵账单账本 → 数据源不可用
  const snapshot = await captured.dispatch('organizer.cost.snapshot', {});
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.available, false);
  assert.deepEqual(snapshot.value.folders, {});

  const status = await captured.dispatch('organizer.cost.status', {});
  assert.equal(status.ok, true);
  assert.equal(status.value.available, false);
  assert.equal(typeof status.value.file, 'string');
});

test('M4 有成本数据源时订阅会话事件，事件只记脏不抛', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const projectionDir = join(root, 'storages', 'session_projcache', 'sessions');
  await mkdir(projectionDir, { recursive: true });
  await writeFile(
    join(projectionDir, 'session-x.json'),
    JSON.stringify({ record: { rows: { cacheBilling: { val: { totals: { cacheHitCost: 1, missCost: 0, outputCost: 0 } } } } } })
  );
  try {
    const { ctx, captured, listeners } = makeCtx();
    apply(ctx);
    assert.equal(listeners.has('session/event'), true, '应订阅 session/event');
    assert.equal(listeners.has('session/disposed'), true, '应订阅 session/disposed');

    const status = await captured.dispatch('organizer.cost.status', {});
    assert.equal(status.value.available, true);
    assert.equal(status.value.source, 'projcache');
    assert.equal(status.value.watcher?.debounceMs, 2000);
    assert.equal(status.value.watcher?.active, true, '定时兜底应已挂上');

    // 事件处理只记脏（合并 2 秒），不抛
    assert.doesNotThrow(() => listeners.get('session/event')?.({ id: 'session-x' }));
    assert.doesNotThrow(() => listeners.get('session/disposed')?.({ id: 'session-x' }));
    assert.equal(listeners.get('session/event')?.(undefined), undefined, '容错：无 id 的事件也要安全');
  } finally {
    await rm(join(root, 'storages'), { recursive: true, force: true });
  }
});
