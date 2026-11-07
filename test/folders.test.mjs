/**
 * 工作区内虚拟文件夹（收纳）测试：数据层 + RPC 端点。
 *
 * 覆盖 sidecar（folders.v1.json）的创建/改名/配色/删除回退、收纳与组内排序、
 * 工作区顶层交错顺序、损坏回退、写入失败回滚，以及 getSessionsInFolder 的
 * 同步接口与 RPC 端点。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import {
	createFolderStore,
	getSessionsInFolder,
	foldersFilePath,
	normalizeFoldersState,
	registerFolderStore
} from '../src/folders.mjs';
import { apply } from '../src/index.mjs';

const previousHome = process.env.DSH_HOME;
let root;

const silentLogger = { info() {}, warn() {} };

before(async () => {
	root = await mkdtemp(join(tmpdir(), 'wso-folders-'));
	process.env.DSH_HOME = root;
});

after(async () => {
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
	await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(join(root, 'workspace-organizer'), { recursive: true, force: true }).catch(() => {});
});

function makeStore() {
	const store = createFolderStore({ logger: silentLogger });
	registerFolderStore(store);
	return store;
}

test('新建文件夹：workspaceId 必填，写入 sidecar 并出现在该工作区顺序里', async () => {
	const store = makeStore();
	await store.warm();
	await assert.rejects(() => store.createFolder({ name: '缺工作区' }), /workspaceId/);

	const created = await store.createFolder({ workspaceId: 'ws-a', name: '前端项目', color: '#4F7CF5' });
	assert.match(created.folderId, /^f_[0-9a-f]{8}$/);

	const state = await store.state();
	assert.equal(state.folders.length, 1);
	assert.equal(state.folders[0].name, '前端项目');
	assert.equal(state.folders[0].workspaceId, 'ws-a');
	assert.equal(state.folders[0].color, '#4f7cf5');
	assert.deepEqual(state.orders['ws-a'], [{ type: 'folder', id: created.folderId }]);

	// 落盘内容可被重新读回（不是只在内存里）。
	const raw = JSON.parse(await readFile(foldersFilePath(), 'utf8'));
	assert.equal(raw.version, 2);
	assert.equal(raw.folders.length, 1);
	assert.equal(raw.folders[0].workspaceId, 'ws-a');
});

test('重名限制在同工作区内；不同工作区可以同名', async () => {
	const store = makeStore();
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: '后端' });
	await assert.rejects(() => store.createFolder({ workspaceId: 'ws-a', name: '后端' }), /同名/);
	await assert.rejects(() => store.createFolder({ workspaceId: 'ws-a', name: '   ' }), /不能为空/);
	await assert.rejects(() => store.updateFolder(a.folderId, { color: 'red' }), /#rrggbb/);
	const b = await store.createFolder({ workspaceId: 'ws-b', name: '后端' });
	assert.notEqual(a.folderId, b.folderId);
});

test('改名/配色/折叠态可更新', async () => {
	const store = makeStore();
	await store.warm();
	const { folderId } = await store.createFolder({ workspaceId: 'ws-a', name: '服务' });
	await store.updateFolder(folderId, { name: '服务端', color: '#2fb37a', icon: '📦', collapsed: true });
	let folder = (await store.state()).folders.find((item) => item.id === folderId);
	assert.equal(folder.name, '服务端');
	assert.equal(folder.color, '#2fb37a');
	assert.equal(folder.icon, '📦');
	assert.equal(folder.collapsed, true);

	// 清空颜色/图标走空串。
	await store.updateFolder(folderId, { color: '', icon: '' });
	folder = (await store.state()).folders.find((item) => item.id === folderId);
	assert.equal(folder.color, undefined);
	assert.equal(folder.icon, undefined);
});

test('收纳 / 组内排序 / 移出：orderInFolder 连续且唯一，收纳后不占工作区顶层槽位', async () => {
	const store = makeStore();
	await store.warm();
	const { folderId } = await store.createFolder({ workspaceId: 'ws-a', name: '收纳箱' });

	await store.addToFolder(folderId, 's-1');
	await store.addToFolder(folderId, 's-2');
	await store.addToFolder(folderId, 's-3');
	assert.deepEqual(store.getSessionsInFolder(folderId), ['s-1', 's-2', 's-3']);

	await store.reorderInFolder(folderId, 's-3', 's-1');
	assert.deepEqual(store.getSessionsInFolder(folderId), ['s-3', 's-1', 's-2']);

	await store.addToFolder(folderId, 's-4', { beforeSessionId: 's-2' });
	assert.deepEqual(store.getSessionsInFolder(folderId), ['s-3', 's-1', 's-4', 's-2']);

	const state = await store.state();
	const orders = state.orders['ws-a'];
	assert.deepEqual(orders, [{ type: 'folder', id: folderId }], '已收纳的会话不应出现在工作区顶层顺序里');

	await store.removeFromFolder('s-1');
	assert.deepEqual(store.getSessionsInFolder(folderId), ['s-3', 's-4', 's-2']);
});

test('工作区顶层交错顺序：folder 与未收纳 session 可混排，跨区 folder 被丢弃', async () => {
	const store = makeStore();
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A 组' });
	const b = await store.createFolder({ workspaceId: 'ws-b', name: 'B 组' });
	await store.addToFolder(a.folderId, 's-9');

	await store.setOrder('ws-a', [
		{ type: 'session', id: 's-1' },
		{ type: 'folder', id: a.folderId },
		{ type: 'session', id: 's-2' },
		{ type: 'folder', id: b.folderId },
		{ type: 'session', id: 's-9' }
	]);
	const state = await store.state();
	assert.deepEqual(state.orders['ws-a'], [
		{ type: 'session', id: 's-1' },
		{ type: 'folder', id: a.folderId },
		{ type: 'session', id: 's-2' }
	]);

	// 未出现过的文件夹自动补到该工作区末尾。
	await store.setOrder('ws-a', [{ type: 'session', id: 's-1' }]);
	const after = await store.state();
	assert.deepEqual(after.orders['ws-a'], [
		{ type: 'session', id: 's-1' },
		{ type: 'folder', id: a.folderId }
	]);
});

test('删除文件夹：只删关系，会话安全回退（不删除会话、不碰磁盘）', async () => {
	const store = makeStore();
	await store.warm();
	const { folderId } = await store.createFolder({ workspaceId: 'ws-a', name: '临时' });
	await store.addToFolder(folderId, 's-1');
	await store.addToFolder(folderId, 's-2');
	const removed = await store.deleteFolder(folderId);
	assert.deepEqual([...removed.releasedSessions].sort(), ['s-1', 's-2']);

	const state = await store.state();
	assert.deepEqual(state.folders, []);
	assert.deepEqual(state.memberships, []);
	assert.equal(state.orders['ws-a'], undefined);
	assert.deepEqual(store.getSessionsInFolder(folderId), []);
});

test('sidecar 损坏：留档 .corrupt-* 并回退到全部未收纳', async () => {
	const store = makeStore();
	await store.warm();
	await store.createFolder({ workspaceId: 'ws-a', name: '会坏掉' });
	const path = foldersFilePath();
	await writeFile(path, '{ 这不是 JSON', 'utf8');

	const fresh = makeStore();
	await fresh.warm();
	const state = await fresh.state();
	assert.deepEqual(state.folders, []);
	assert.deepEqual(state.memberships, []);
	assert.deepEqual(state.orders, {});
	const quarantined = readdirSync(join(root, 'workspace-organizer')).filter((name) => name.includes('.corrupt-'));
	assert.equal(quarantined.length, 1, '坏文件应留档');
});

test('规范化：非法条目丢弃而不是整体失败', () => {
	const state = normalizeFoldersState(
		{
			folders: [
				{ id: 'f_ok', workspaceId: 'ws-a', name: '合法' },
				{ id: 'f_no_ws', name: '缺工作区' },
				{ id: 'bad id!', workspaceId: 'ws-a', name: '坏 id' },
				{ id: 'f_ok', workspaceId: 'ws-a', name: '重复 id' }
			],
			memberships: [
				{ folderId: 'f_ok', sessionId: 's-1', orderInFolder: 0 },
				{ folderId: 'f_missing', sessionId: 's-2', orderInFolder: 1 },
				{ folderId: 'f_ok', sessionId: 's-1', orderInFolder: 2 }
			],
			orders: { 'ws-a': [{ type: 'folder', id: 'f_ok' }, { type: 'session', id: 's-1' }, { type: 'nonsense', id: 'x' }] }
		},
		silentLogger
	);
	assert.deepEqual(state.folders.map((folder) => folder.id), ['f_ok']);
	assert.deepEqual(state.memberships.map((membership) => membership.sessionId), ['s-1']);
	assert.deepEqual(state.orders['ws-a'], [{ type: 'folder', id: 'f_ok' }]);
});

test('落盘失败时本次操作整体回滚（缓存不变）', async () => {
	// 让插件数据目录无法创建：在 DSH_HOME 下放一个同名普通文件。
	await rm(join(root, 'workspace-organizer'), { recursive: true, force: true }).catch(() => {});
	await writeFile(join(root, 'workspace-organizer'), 'not a directory', 'utf8');
	try {
		const store = makeStore();
		await store.warm();
		await assert.rejects(() => store.createFolder({ workspaceId: 'ws-a', name: '写不进去' }));
		const state = await store.state();
		assert.deepEqual(state.folders, []);
		assert.equal(existsSync(foldersFilePath()), false);
	} finally {
		await rm(join(root, 'workspace-organizer'), { force: true }).catch(() => {});
	}
});

test('写入串行化：并发新建不会互相覆盖', async () => {
	const store = makeStore();
	await store.warm();
	const results = await Promise.all(
		Array.from({ length: 6 }, (_unused, index) => store.createFolder({ workspaceId: 'ws-a', name: `并发-${index}` }))
	);
	const state = await store.state();
	assert.equal(state.folders.length, 6);
	assert.equal(new Set(results.map((item) => item.folderId)).size, 6);
});

test('getSessionsInFolder 是模块级同步接口（成本聚合的接口）', async () => {
	const store = makeStore();
	await store.warm();
	const { folderId } = await store.createFolder({ workspaceId: 'ws-a', name: '给成本聚合用' });
	await store.addToFolder(folderId, 'session-a');
	await store.addToFolder(folderId, 'session-b');
	assert.deepEqual(getSessionsInFolder(folderId), ['session-a', 'session-b']);
	assert.deepEqual(getSessionsInFolder('f_unknown'), []);
});

// #region RPC 端点
function makeRpcCtx(sessionIds) {
	const captured = { channel: null, dispatch: null };
	const entity = {
		id: 'ws-a',
		title: '工作区 A',
		path: '/tmp/ws-a',
		record: { path: '/tmp/ws-a', title: '工作区 A', sessionIds: [...sessionIds] },
		sessionIds: [...sessionIds],
		attachSession: async () => {},
		detachSession: async () => {},
		insertSessionBefore: async () => {}
	};
	const registry = {
		archivedSessionIds: [],
		list: () => [entity],
		insertBefore: async () => ['ws-a'],
		headers: new Map(),
		sessionPaths: new Map(),
		invalidSessionPaths: new Map(),
		unarchiveSession: async () => {}
	};
	const headers = sessionIds.map((id) => ({ id, cwd: '/tmp/ws-a', title: `标题 ${id}`, updatedAt: '2026-01-01T00:00:00.000Z' }));
	const persistence = {
		list: async () => headers.map((header) => ({ header: { ...header }, revision: 1 })),
		locate: () => undefined,
		tracker: { writers: new Map() },
		coordinator: { serialize: async (_id, operation) => await operation() }
	};
	const connection = {
		rpc: {
			handle: (channel, dispatch) => {
				captured.channel = channel;
				captured.dispatch = dispatch;
				return () => {};
			}
		}
	};
	const ctx = {
		logger: silentLogger,
		workspaceRegistry: registry,
		sessionPersistence: persistence,
		sessions: { get: () => undefined, list: () => [], flush: async () => {} },
		agents: { get: () => undefined },
		connection,
		webServer: {},
		slots: { inject() {}, register() {} },
		get: () => undefined,
		emit: () => {},
		inject: (_names, callback) => callback({ connection, webServer: {}, effect: () => {} }),
		effect: (fn) => fn()
	};
	return { ctx, captured };
}

test('RPC：创建文件夹、收纳已知会话、顶层顺序、列出会话 ID', async () => {
	const { ctx, captured } = makeRpcCtx(['s-1', 's-2']);
	apply(ctx);

	await assert.rejects(async () => {
		const missing = await captured.dispatch('organizer.folders.create', { name: '缺工作区' });
		if (missing.ok === false) throw new Error(missing.error.message);
	}, /workspaceId/);

	const created = await captured.dispatch('organizer.folders.create', { workspaceId: 'ws-a', name: 'RPC 分组' });
	assert.equal(created.ok, true);
	const folderId = created.value.folderId;

	const added = await captured.dispatch('organizer.folders.add', { folderId, sessionId: 's-1' });
	assert.equal(added.ok, true);

	const sessions = await captured.dispatch('organizer.folders.sessions', { folderId });
	assert.equal(sessions.ok, true);
	assert.deepEqual(sessions.value.sessionIds, ['s-1']);

	const order = await captured.dispatch('organizer.folders.order', {
		workspaceId: 'ws-a',
		items: [{ type: 'session', id: 's-2' }, { type: 'folder', id: folderId }]
	});
	assert.equal(order.ok, true);
	assert.deepEqual(order.value.orders['ws-a'], [{ type: 'session', id: 's-2' }, { type: 'folder', id: folderId }]);

	const state = await captured.dispatch('organizer.folders.state', {});
	assert.equal(state.ok, true);
	assert.equal(state.value.folders.length, 1);
});

test('RPC：收纳不存在的会话返回 not-found；未知端点仍是 bad-endpoint', async () => {
	const { ctx, captured } = makeRpcCtx(['s-1']);
	apply(ctx);
	const created = await captured.dispatch('organizer.folders.create', { workspaceId: 'ws-a', name: 'A' });
	const folderId = created.value.folderId;

	const missing = await captured.dispatch('organizer.folders.add', { folderId, sessionId: 's-ghost' });
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, 'not-found');

	const badFolder = await captured.dispatch('organizer.folders.add', { folderId: 'f_nope', sessionId: 's-1' });
	assert.equal(badFolder.ok, false);
	assert.equal(badFolder.error.code, 'not-found');

	const missingName = await captured.dispatch('organizer.folders.create', { workspaceId: 'ws-a' });
	assert.equal(missingName.ok, false);
	assert.equal(missingName.error.code, 'invalid-input');

	const unknown = await captured.dispatch('organizer.nope', {});
	assert.equal(unknown.ok, false);
	assert.equal(unknown.error.code, 'bad-endpoint');
});

test('RPC：删除项目时同步清理归属（回收站退化成仅移除注册也清理）', async () => {
	const { ctx, captured } = makeRpcCtx(['s-1']);
	apply(ctx);
	const created = await captured.dispatch('organizer.folders.create', { workspaceId: 'ws-a', name: '清理测试' });
	const folderId = created.value.folderId;
	await captured.dispatch('organizer.folders.add', { folderId, sessionId: 's-1' });
	assert.deepEqual((await captured.dispatch('organizer.folders.sessions', { folderId })).value.sessionIds, ['s-1']);

	// 没有磁盘档案时 recycle 退化成 unregister —— 归属同样要被清理。
	const deleted = await captured.dispatch('organizer.delete', { sessionId: 's-1', mode: 'recycle' });
	assert.equal(deleted.ok, true);
	assert.equal(deleted.value.mode, 'unregister');
	assert.equal(deleted.value.degraded, 'no-artifact');
	assert.deepEqual((await captured.dispatch('organizer.folders.sessions', { folderId })).value.sessionIds, []);
});
// #endregion
