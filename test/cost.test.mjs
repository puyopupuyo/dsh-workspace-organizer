/**
 * 文件夹总计花费（成本聚合）数据层测试 —— M1。
 *
 * 覆盖：
 *  1) FolderCostRollup 落盘到**独立**的 folder-cost-rollups.json；
 *  2) 水位不变时复用缓存 cost（不再问数据源）；
 *  3) 增删成员后只重算受影响的文件夹（未变化会话不重复取成本）；
 *  4) 缺失会话被标 missing，且不把不完整汇总当精确值；
 *  5) 删除文件夹不删成本记录；成本缓存损坏可重建；
 *  6) sessionToFolderIndex 与归属原子维护（删会话能一步定位文件夹）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createFolderStore, foldersOfSession, registerFolderStore } from '../src/folders.mjs';
import { COST_FILE, costFilePath, createCostRollups, normalizeCostState } from '../src/cost.mjs';
import { foldersFilePath } from '../src/folders.mjs';

const previousHome = process.env.DSH_HOME;
let root;

const silentLogger = { info() {}, warn() {} };

before(async () => {
	root = await mkdtemp(join(tmpdir(), 'wso-cost-'));
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

/** 一套可控的“外部成本数据源”：记录每次被问到的会话。 */
function makeHarness(options = {}) {
	const calls = [];
	const costs = new Map(Object.entries(options.costs ?? {}));
	const stamps = new Map();
	const source = {
		id: 'fake',
		label: 'fake source',
		estimated: true,
		available: options.available !== false,
		stamp: () => ({}),
		readSession(sessionId) {
			calls.push(sessionId);
			const known = costs.get(sessionId);
			return known === undefined ? { cost: undefined } : known;
		}
	};
	const store = createFolderStore({ logger: silentLogger });
	registerFolderStore(store);
	// 工作区记账：workspaceId → 成员 sessionId[]（可被测试改写）
	const workspaces = new Map(Object.entries(options.workspaces ?? {}).map(([id, ids]) => [id, [...ids]]));
	const costsRollups = createCostRollups({
		logger: silentLogger,
		source,
		sessionIdsOfFolder: (folderId) => store.getSessionsInFolder(folderId),
		foldersOfSession: (sessionId) => foldersOfSession(sessionId),
		folderIds: () => store.folderIds(),
		sessionIdsOfWorkspace: (workspaceId) => workspaces.get(String(workspaceId)) ?? [],
		workspaceIds: () => [...workspaces.keys()],
		workspacesOfSession: (sessionId) =>
			[...workspaces.entries()].filter(([, ids]) => ids.includes(String(sessionId))).map(([id]) => id),
		stampOf: async (sessionIds) =>
			Object.fromEntries(
				sessionIds.map((sessionId) => [sessionId, stamps.get(sessionId) ?? { logMtime: 1000, logSize: 100 }])
			)
	});
	return { calls, costs, stamps, store, costsRollups, workspaces };
}

/** 让某个会话的日志水位前进一格。 */
function bump(stamps, sessionId, mtime = 2000) {
	stamps.set(sessionId, { logMtime: mtime, logSize: 100 + mtime });
}

test('快照：按文件夹求和，空文件夹为 0 且不显示成本', async () => {
	const { store, costsRollups } = makeHarness({ costs: { s1: { cost: 1.5, tokens: 1000 }, s2: { cost: 2.25, tokens: 2000 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: '客户项目 A' });
	const b = await store.createFolder({ workspaceId: 'ws-a', name: '空文件夹' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(a.folderId, 's2');

	const snapshot = await costsRollups.snapshot();
	assert.equal(snapshot.available, true);
	assert.equal(snapshot.folders[a.folderId].totalCost, 3.75);
	assert.equal(snapshot.folders[a.folderId].sessionCount, 2);
	assert.equal(snapshot.folders[a.folderId].missingCount, 0);
	assert.equal(snapshot.folders[a.folderId].totalTokens, 3000);
	// 逐会话明细求和等于小计
	const sum = snapshot.folders[a.folderId].sessions.reduce((total, item) => total + (item.cost ?? 0), 0);
	assert.equal(Number(sum.toFixed(6)), snapshot.folders[a.folderId].totalCost);

	assert.equal(snapshot.folders[b.folderId].sessionCount, 0);
	assert.equal(snapshot.folders[b.folderId].totalCost, 0);
});

test('水位不变时复用缓存：第二次快照不再问数据源', async () => {
	const { calls, store, costsRollups } = makeHarness({ costs: { s1: { cost: 1.5 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');

	await costsRollups.snapshot();
	assert.deepEqual(calls, ['s1']);
	await costsRollups.snapshot();
	await costsRollups.snapshot();
	assert.deepEqual(calls, ['s1'], '水位没变就不该重复取成本');
});

test('水位变化后只重取那一个会话', async () => {
	const { calls, stamps, store, costsRollups, costs } = makeHarness({
		costs: { s1: { cost: 1 }, s2: { cost: 2 } }
	});
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(a.folderId, 's2');
	await costsRollups.snapshot();
	assert.deepEqual(calls.sort(), ['s1', 's2']);

	costs.set('s1', { cost: 5 });
	bump(stamps, 's1');
	calls.length = 0;
	const snapshot = await costsRollups.snapshot();
	assert.deepEqual(calls, ['s1'], '只有水位变了的 s1 需要重取');
	assert.equal(snapshot.folders[a.folderId].totalCost, 7);
});

test('增删成员只重算受影响文件夹，其余文件夹的会话不重取', async () => {
	const { calls, store, costsRollups } = makeHarness({
		costs: { s1: { cost: 1 }, s2: { cost: 2 }, s3: { cost: 3 } }
	});
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	const b = await store.createFolder({ workspaceId: 'ws-a', name: 'B' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(b.folderId, 's2');
	await store.addToFolder(b.folderId, 's3');
	await costsRollups.snapshot();

	calls.length = 0;
	await store.addToFolder(a.folderId, 's3'); // s3 从 B 移到 A
	await costsRollups.snapshot();
	// 会话级缓存统一后：s3 的成本已在缓存里（水位没变），换文件夹不重取。
	// 这条断言同时锁住「不允许文件夹/工作区各自再算一遍」的约束。
	assert.deepEqual(calls, [], '会话成本已缓存，跨文件夹移动不需要重取');
	const state = await store.state();
	const folderA = state.folders.find((folder) => folder.id === a.folderId);
	assert.equal(folderA.name, 'A');

	const snapshot = await costsRollups.snapshot();
	assert.equal(snapshot.folders[a.folderId].totalCost, 4);
	assert.equal(snapshot.folders[a.folderId].sessionCount, 2);
	assert.equal(snapshot.folders[b.folderId].totalCost, 2);
	assert.equal(snapshot.folders[b.folderId].sessionCount, 1);

	calls.length = 0;
	await store.removeFromFolder('s3');
	await costsRollups.snapshot();
	assert.deepEqual(calls, [], '移出成员不需要重新取任何成本');
});

test('缺失会话标 missing，不从总计里假装精确', async () => {
	const { store, costsRollups } = makeHarness({ costs: { s1: { cost: 2 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(a.folderId, 's-missing');

	const snapshot = await costsRollups.snapshot();
	const view = snapshot.folders[a.folderId];
	assert.equal(view.totalCost, 2, '缺失会话不计入总计');
	assert.equal(view.sessionCount, 2);
	assert.equal(view.missingCount, 1);
	const missing = view.sessions.find((item) => item.sessionId === 's-missing');
	assert.equal(missing.missing, true);
	assert.equal(missing.cost, undefined);
	const priced = view.sessions.find((item) => item.sessionId === 's1');
	assert.equal(priced.missing, false);
});

test('M4 批量水位检查：无变化时不读数据源、不写盘', async () => {
	const { calls, store, costsRollups } = makeHarness({ costs: { s1: { cost: 1 }, s2: { cost: 2 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	const b = await store.createFolder({ workspaceId: 'ws-a', name: 'B' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(b.folderId, 's2');
	await costsRollups.snapshot();

	calls.length = 0;
	const first = await costsRollups.poll();
	assert.deepEqual(first.changed, [], '水位没变就不该重算任何文件夹');
	assert.deepEqual(calls, [], '水位没变就不该读数据源');
	const second = await costsRollups.poll();
	assert.deepEqual(second.changed, []);
	assert.equal(second.checked, 2, '应检查到 2 个已有水位的会话');
});

test('M4 批量水位检查：只重算有变化的文件夹', async () => {
	const { calls, stamps, store, costsRollups, costs } = makeHarness({
		costs: { s1: { cost: 1 }, s2: { cost: 2 } }
	});
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	const b = await store.createFolder({ workspaceId: 'ws-a', name: 'B' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(b.folderId, 's2');
	await costsRollups.snapshot();

	// 合并两次变更：s2 涨到 5，s1 不动
	costs.set('s2', { cost: 5 });
	bump(stamps, 's2');
	calls.length = 0;
	const result = await costsRollups.poll();
	assert.deepEqual(result.changed, [b.folderId], '只有 b 变了');
	assert.deepEqual(calls, ['s2'], '只该重取 s2 的成本');
	assert.equal(result.checked, 2);

	const snapshot = await costsRollups.snapshot();
	assert.equal(snapshot.folders[a.folderId].totalCost, 1);
	assert.equal(snapshot.folders[b.folderId].totalCost, 5);
	assert.deepEqual(calls, ['s2'], '快照不该再取一次成本');
});

test('M4 批量水位检查：可只检查给定的脏会话', async () => {
	const { calls, stamps, store, costsRollups } = makeHarness({ costs: { s1: { cost: 1 }, s2: { cost: 2 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(a.folderId, 's2');
	await costsRollups.snapshot();

	bump(stamps, 's1');
	bump(stamps, 's2');
	calls.length = 0;
	const result = await costsRollups.poll(['s1']);
	assert.equal(result.checked, 1, '只检查给定会话');
	assert.deepEqual(result.changed, [a.folderId]);
	// 重算这个文件夹时会顺带把它其它脏成员也更新掉（s2 同属 a，水位也变了）
	assert.deepEqual(calls.sort(), ['s1', 's2']);
});

test('M4 会话被移出/删除：批量重算把旧成员从总计里清掉', async () => {
	const { store, costsRollups } = makeHarness({ costs: { s1: { cost: 1 }, s2: { cost: 2 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(a.folderId, 's2');
	await costsRollups.snapshot();
	assert.equal((await costsRollups.peekFolder(a.folderId)).totalCost, 3);

	// 模拟删除会话：先取受影响的文件夹（反向索引），再 prune，再按文件夹重算
	const affected = store.foldersOfSession('s2');
	await store.pruneSession('s2');
	assert.deepEqual(store.foldersOfSession('s2'), []);
	assert.deepEqual(affected, [a.folderId], '删除前必须能定位到原文件夹');
	await costsRollups.recomputeFolders(affected);
	const view = await costsRollups.peekFolder(a.folderId);
	assert.equal(view.totalCost, 1, '被删会话不得继续计入总计');
	assert.equal(view.sessionCount, 1);
});

test('子代理成本单独汇总', async () => {
	const { store, costsRollups } = makeHarness({
		costs: { s1: { cost: 1, subagent: false }, sub: { cost: 0.5, subagent: true } }
	});
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(a.folderId, 'sub');
	const view = (await costsRollups.snapshot()).folders[a.folderId];
	assert.equal(view.totalCost, 1.5);
	assert.equal(view.subagentCost, 0.5);
});

test('成本缓存与归属分开落盘；删文件夹不删成本记录', async () => {
	const { store, costsRollups } = makeHarness({ costs: { s1: { cost: 1.25 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await costsRollups.snapshot();

	const costPath = costFilePath();
	assert.equal(costPath, join(root, 'workspace-organizer', COST_FILE));
	assert.ok(existsSync(costPath), '成本缓存应独立落盘');
	assert.ok(existsSync(foldersFilePath()), '归属仍在 folders.v1.json');
	const costRaw = JSON.parse(await readFile(costPath, 'utf8'));
	assert.equal(costRaw.rollups[a.folderId].totalCost, 1.25);
	assert.ok(costRaw.rollups[a.folderId].sessionWatermarks.s1, '应记录会话水位');

	await store.deleteFolder(a.folderId);
	const after = JSON.parse(await readFile(costPath, 'utf8'));
	assert.ok(after.rollups[a.folderId] !== undefined, '删除文件夹不得删掉成本历史');
});

test('成本缓存损坏：留档重建，不抛错', async () => {
	const { store, costsRollups } = makeHarness({ costs: { s1: { cost: 1 } } });
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await costsRollups.snapshot();

	const path = costFilePath();
	await readFile(path, 'utf8').then(() => rm(path, { force: true }));
	// 写一份坏 JSON，模拟磁盘损坏
	const { writeFile } = await import('node:fs/promises');
	await writeFile(path, '{ broken', 'utf8');

	const rebuilt = createCostRollups({
		logger: silentLogger,
		source: { id: 'fake', label: 'fake', available: true, stamp: () => ({}), readSession: () => ({ cost: 9 }) },
		sessionIdsOfFolder: (folderId) => store.getSessionsInFolder(folderId),
		foldersOfSession: (sessionId) => foldersOfSession(sessionId),
		folderIds: () => store.folderIds(),
		stampOf: async () => ({})
	});
	const snapshot = await rebuilt.snapshot();
	assert.equal(snapshot.available, true);
	assert.equal(snapshot.folders[a.folderId].totalCost, 9, '重建后应重新算一次');
});

test('数据源不可用：快照标明不可用且不产生任何 rollup', async () => {
	const { store, costsRollups } = makeHarness({ available: false });
	await store.warm();
	await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	const snapshot = await costsRollups.snapshot();
	assert.equal(snapshot.available, false);
	assert.deepEqual(snapshot.folders, {});
});

test('normalizeCostState 丢弃脏数据但保留合法 rollup', () => {
	const state = normalizeCostState({
		rollups: {
			f_1: {
				totalCost: 3,
				totalTokens: 10,
				sessionCount: 1,
				lastComputedAt: '2026-01-01T00:00:00.000Z',
				sessionWatermarks: { s1: { logMtime: 1, logSize: 2, cost: 3, missing: false }, bad: 'nope' }
			},
			f_bad: 'nope'
		}
	});
	assert.deepEqual(Object.keys(state.rollups), ['f_1']);
	assert.equal(state.rollups.f_1.totalCost, 3);
	assert.equal(state.rollups.f_1.sessionWatermarks.s1.cost, 3);
	assert.equal(Object.keys(state.rollups.f_1.sessionWatermarks).length, 1);
});

test('sessionToFolderIndex 与归属原子维护：删会话能一步定位文件夹', async () => {
	const store = createFolderStore({ logger: silentLogger });
	registerFolderStore(store);
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	const b = await store.createFolder({ workspaceId: 'ws-a', name: 'B' });
	await store.addToFolder(a.folderId, 's1');
	await store.addToFolder(b.folderId, 's2');
	assert.deepEqual(store.foldersOfSession('s1'), [a.folderId]);
	assert.deepEqual(store.foldersOfSession('s2'), [b.folderId]);
	assert.deepEqual(foldersOfSession('s1'), [a.folderId], '模块级接口应与实例一致');

	// 同一会话挪到另一个文件夹：旧关系必须一起消失
	await store.addToFolder(b.folderId, 's1');
	assert.deepEqual(store.foldersOfSession('s1'), [b.folderId]);

	await store.pruneSession('s1');
	assert.deepEqual(store.foldersOfSession('s1'), []);
	assert.deepEqual(store.getSessionsInFolder(b.folderId), ['s2']);

	// 磁盘重载后索引依然正确（重建自 memberships，不是只在内存里增量拼）
	const reloaded = createFolderStore({ logger: silentLogger });
	registerFolderStore(reloaded);
	await reloaded.warm();
	assert.deepEqual(reloaded.foldersOfSession('s2'), [b.folderId]);
	assert.deepEqual(reloaded.folderIds().sort(), [a.folderId, b.folderId].sort());
});


// #region 工作区总计 + 统一会话级缓存（M6）
test('工作区总计包含未收纳会话，并与文件夹小计共用同一份会话级缓存', async () => {
	const { calls, store, costsRollups } = makeHarness({
		costs: { s1: { cost: 1 }, s2: { cost: 2 }, s3: { cost: 3 } },
		workspaces: { 'ws-a': ['s1', 's2', 's3'] }
	});
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');

	const snapshot = await costsRollups.snapshot();
	assert.equal(snapshot.available, true);
	assert.equal(snapshot.workspaces['ws-a'].totalCost, 6, '工作区总计必须包含未收纳的 s2/s3');
	assert.equal(snapshot.workspaces['ws-a'].sessionCount, 3);
	assert.equal(snapshot.workspaces['ws-a'].missingCount, 0);
	assert.deepEqual([...snapshot.workspaces['ws-a'].sessionIds].sort(), ['s1', 's2', 's3']);
	assert.equal(snapshot.folders[a.folderId].totalCost, 1, '文件夹小计只算自己的成员');
	// 三个会话各读一次（s1 先被文件夹问到，之后工作区复用缓存）
	assert.deepEqual(calls.sort(), ['s1', 's2', 's3']);
	// 底栏可直接读会话级缓存
	assert.equal(snapshot.sessions.s1.cost, 1);
	assert.equal(snapshot.sessions.s2.cost, 2);
	assert.equal(snapshot.sessions.s3.cost, 3);

	calls.length = 0;
	await costsRollups.snapshot();
	assert.deepEqual(calls, [], '水位没变时工作区总计也不得重读数据源');
});

test('工作区水位变化：只重取那一个会话并同步刷新工作区', async () => {
	const { calls, costs, stamps, store, costsRollups } = makeHarness({
		costs: { s1: { cost: 1 }, s2: { cost: 2 } },
		workspaces: { 'ws-a': ['s1', 's2'] }
	});
	await store.warm();
	await costsRollups.snapshot();
	assert.equal((await costsRollups.peekWorkspace('ws-a')).totalCost, 3);

	costs.set('s2', { cost: 5 });
	bump(stamps, 's2');
	calls.length = 0;
	const result = await costsRollups.poll(['s2']);
	assert.deepEqual(calls, ['s2'], '只重取水位变了的会话');
	assert.deepEqual(result.workspaces, ['ws-a'], 'poll 必须回报受影响的工作区');
	assert.equal((await costsRollups.peekWorkspace('ws-a')).totalCost, 6);
});

test('recomputeWorkspace 与 recomputeFolder 同一套增量：重复调用不读数据源', async () => {
	const { calls, store, costsRollups } = makeHarness({
		costs: { s1: { cost: 2 } },
		workspaces: { 'ws-a': ['s1'] }
	});
	await store.warm();
	const first = await costsRollups.recomputeWorkspace('ws-a');
	assert.equal(first.available, true);
	assert.equal(first.totalCost, 2);
	assert.deepEqual(calls, ['s1']);
	calls.length = 0;
	const second = await costsRollups.recomputeWorkspace('ws-a');
	assert.equal(second.totalCost, 2);
	assert.deepEqual(calls, [], '水位没变就不该再问数据源');
});

test('成员/成本变化：invalidateSessions 同时重算文件夹与工作区；删会话走全量工作区', async () => {
	const { calls, costs, stamps, workspaces, store, costsRollups } = makeHarness({
		costs: { s1: { cost: 1 }, s2: { cost: 2 } },
		workspaces: { 'ws-a': ['s1', 's2'] }
	});
	await store.warm();
	const a = await store.createFolder({ workspaceId: 'ws-a', name: 'A' });
	await store.addToFolder(a.folderId, 's1');
	await costsRollups.snapshot();
	assert.equal((await costsRollups.peekWorkspace('ws-a')).totalCost, 3);

	// s2 成本变了（归属没变）：invalidateSessions 必须同时刷新工作区
	costs.set('s2', { cost: 5 });
	bump(stamps, 's2');
	calls.length = 0;
	const changed = await costsRollups.invalidateSessions(['s2']);
	assert.deepEqual(changed.workspaces, ['ws-a']);
	assert.deepEqual(calls, ['s2'], '只重取水位变了的 s2');
	assert.equal((await costsRollups.peekWorkspace('ws-a')).totalCost, 6);

	// s2 已被移出工作区（反查不到归属）：只能全量重算工作区
	workspaces.set('ws-a', ['s1']);
	const result = await costsRollups.recomputeAllWorkspaces();
	assert.deepEqual(result.workspaces, ['ws-a']);
	assert.equal((await costsRollups.peekWorkspace('ws-a')).totalCost, 1, '工作区总计必须跟着成员收敛');
});

test('底栏当前会话：即使不在任何文件夹/工作区也能拿到成本，且遵守水位增量', async () => {
	const { calls, costs, stamps, store, costsRollups } = makeHarness({
		costs: { solo: { cost: 1.25 } }
	});
	await store.warm();
	const first = await costsRollups.snapshot({ sessionIds: ['solo'] });
	assert.equal(first.sessions.solo.cost, 1.25);
	assert.ok(stamps !== undefined);
	assert.deepEqual(calls, ['solo']);

	calls.length = 0;
	const second = await costsRollups.snapshot({ sessionIds: ['solo'] });
	assert.equal(second.sessions.solo.cost, 1.25);
	assert.deepEqual(calls, [], '水位没变时底栏会话也不重取');

	costs.set('solo', { cost: 4 });
	bump(stamps, 'solo');
	const third = await costsRollups.snapshot({ sessionIds: ['solo'] });
	assert.equal(third.sessions.solo.cost, 4);
});

test('无成本记录的会话：sessions 视图标 missing，绝不当作 0', async () => {
	const { store, costsRollups } = makeHarness({ costs: {}, workspaces: { 'ws-a': ['ghost'] } });
	await store.warm();
	const snapshot = await costsRollups.snapshot();
	assert.equal(snapshot.workspaces['ws-a'].totalCost, 0);
	assert.equal(snapshot.workspaces['ws-a'].missingCount, 1);
	assert.equal(snapshot.sessions.ghost.missing, true);
	assert.equal(snapshot.sessions.ghost.cost, undefined, '未计价不得写成 0');
});

test('v1 缓存的文件夹水位会迁移进会话级缓存（升级不重读数据源）', () => {
	const state = normalizeCostState({
		rollups: {
			f_1: {
				totalCost: 3,
				totalTokens: 10,
				sessionCount: 1,
				lastComputedAt: '2026-01-01T00:00:00.000Z',
				sessionWatermarks: { s1: { logMtime: 1, logSize: 2, cost: 3, missing: false } }
			}
		},
		workspaces: {
			'ws-a': { totalCost: 3, totalTokens: 10, sessionCount: 1, missingCount: 0, sessionIds: ['s1'] }
		}
	});
	assert.equal(state.sessions.s1.cost, 3, '旧格式的会话成本应迁移到 sessions');
	assert.equal(state.workspaces['ws-a'].totalCost, 3);
	assert.deepEqual(state.workspaces['ws-a'].sessionIds, ['s1']);
});
// #endregion
