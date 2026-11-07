/**
 * UI 冒烟验证（不入库）：侧边栏接管（M1）。
 *
 * 用 react-test-renderer 把 client.js 真正注册到 mock slots 的组件跑起来，
 * 覆盖：
 *  1) priority -1 影子渲染占位、disposer 后条目消失（官方 0 回位）；
 *  2) 工作区行 → 会话行的树与 data-row-key；
 *  3) 从 ledger 读回官方行座位并插回原位（menu.item / row.action / leading / hover）；
 *  4) 折叠、搜索过滤、归档过滤。
 *
 * 依赖本地 .tmp-ui/node_modules 里的 react / react-test-renderer（一次性安装，不进库）。
 * 运行： node test/ui-tree.test.mjs
 */
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(join(tmpdir(), 'wso-tree-'));
process.env.DSH_HOME = root;

// 成本数据源替身：会话投影缓存里给 s-1 一份“已计价”的账单投影（s-2 故意没有）。
// 这是 meow-cachebilling 落到磁盘的公开产物，成本模块只读不写、不复算单价。
const projectionDir = join(root, 'storages', 'session_projcache', 'sessions');
await mkdir(projectionDir, { recursive: true });
await writeFile(
	join(projectionDir, 's-1.json'),
	JSON.stringify({
		record: {
			rows: {
				cacheBilling: {
					ver: 9,
					val: { totals: { cacheHitCost: 1.2, missCost: 0.2, outputCost: 0.1, inputTokens: 500, cacheReadTokens: 900, outputTokens: 100 } }
				},
				tokenUsage: { ver: 2, val: { totals: { uncachedInputTokens: 500, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 100 } } }
			}
		}
	}),
	'utf8'
);

const req = createRequire(import.meta.url);
const React = req('../.tmp-ui/node_modules/react');
const TestRenderer = req('../.tmp-ui/node_modules/react-test-renderer');
const { act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// #region primitives 替身
const noopIcon = () => null;
const primitives = {
	Modal: ({ children, footer }) => React.createElement('div', { 'data-modal': 'true' }, footer, children),
	Button: ({ children, onClick, disabled }) => React.createElement('button', { onClick, disabled }, children),
	MenuItemButton: ({ children, onSelect }) => React.createElement('button', { onClick: onSelect }, children),
	Menu: ({ open, anchor, children, items, onSelect }) =>
		React.createElement(
			'div',
			null,
			anchor,
			open
				? React.createElement(
						'div',
						{ 'data-menu': 'true' },
						children !== undefined && children !== null
							? children
							: (items || []).map((item) => React.createElement('button', { key: item.id, onClick: () => onSelect?.(item.id) }, item.label))
					)
				: null
		),
	Tooltip: ({ children }) => children,
	HoverCard: ({ anchor, content }) => React.createElement('div', { 'data-hover-card': 'true' }, anchor, content),
	Toast: () => null,
	relativeTime: () => ({ unit: 'minute', n: 5 }),
	IconTrashOutlineRegular: noopIcon,
	IconWarningOutlineRegular: noopIcon,
	IconFolderOpenRegular: noopIcon,
	IconFolderCloseRegular: noopIcon,
	IconChevronDownOutlineRegular: noopIcon,
	IconChevronRightOutlineRegular: noopIcon,
	IconPlusOutlineRegular: noopIcon,
	IconEditOutlineRegular: noopIcon,
	IconCloseOutlineRegular: noopIcon,
	IconRefreshOutlineRegular: noopIcon,
	IconEllipsisOutlineRegular: noopIcon,
	IconNewChatOutlineRegular: noopIcon,
	IconArchiveOutlineRegular: noopIcon,
	IconUnarchiveOutlineRegular: noopIcon,
	IconSearchOutlineRegular: noopIcon,
	IconFlatListOutlineRegular: noopIcon,
	IconWorkspaceTreeOutlineRegular: noopIcon,
	IconTriangleRightFillRegular: noopIcon,
	IconPinOutlineRegular: noopIcon,
	IconPinFillRegular: noopIcon
};
// #endregion

// #region DOM / window 替身
const storage = new Map();
const domStub = () => {
	const listeners = new Map();
	return {
		dataset: {},
		style: {},
		classList: { add() {}, remove() {} },
		appendChild() {},
		remove() {},
		addEventListener: (type, handler) => listeners.set(`${type}:${String(handler)}`, handler),
		removeEventListener: (type, handler) => listeners.delete(`${type}:${String(handler)}`),
		dispatchEvent() {},
		querySelector: () => null,
		querySelectorAll: () => [],
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		matches: () => false,
		closest: () => null,
		animate: () => ({ cancel() {}, onfinish: null })
	};
};
const head = domStub();
globalThis.document = {
	head,
	body: domStub(),
	createElement: () => domStub(),
	querySelector: () => null,
	addEventListener: head.addEventListener,
	removeEventListener: head.removeEventListener,
	dispatchEvent: () => {}
};
globalThis.window = {
	localStorage: {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value))
	},
	matchMedia: () => ({ matches: false }),
	confirm: () => true
};
globalThis.PointerEvent = class PointerEventStub {
	constructor(type, init) {
		Object.assign(this, init || {});
		this.type = type;
	}
};
// #endregion

// #region mock slots（含官方条目与子座位）
const slotRecords = new Map();

function recordOf(name) {
	let record = slotRecords.get(name);
	if (record === undefined) {
		record = { spec: undefined, entries: [], waiters: [] };
		slotRecords.set(name, record);
	}
	return record;
}

function declare(name, spec) {
	const record = recordOf(name);
	record.spec = spec;
	for (const waiter of record.waiters.splice(0)) waiter.run();
}

const slots = {
	/**
	 * 真实 SlotRegistry 的语义：槽位已声明时**同步**执行 callback；未声明时挂起，
	 * 等声明出现再执行（声明折叠时调用 callback 返回的 disposer）。
	 * 本 mock 不含 specDynamic / subscribeDeclaration —— 真实服务面也没有它们。
	 */
	inject(name, callback) {
		const run = () => {
			const dispose = callback();
			return typeof dispose === 'function' ? dispose : () => {};
		};
		const record = recordOf(name);
		if (record.spec !== undefined) return run();
		const waiter = { run: null, dispose: null, active: true };
		waiter.run = () => {
			if (!waiter.active) return;
			waiter.dispose = run();
		};
		record.waiters.push(waiter);
		return () => {
			if (!waiter.active) return;
			waiter.active = false;
			if (typeof waiter.dispose === 'function') waiter.dispose();
		};
	},
	register(options, component) {
		const record = recordOf(options.name);
		if (record.spec === undefined) throw new Error(`slot "${options.name}" is not declared`);
		if (record.spec.kind === 'single') {
			const occupied = record.entries.some((entry) => (entry.options.priority ?? 0) === (options.priority ?? 0));
			if (occupied) throw new Error(`single slot "${options.name}" already has a registration at priority ${options.priority ?? 0}`);
		}
		const entry = {
			component,
			options: { id: options.id, order: options.order, priority: options.priority, label: options.label },
			inject: options.inject,
			locale: options.locale
		};
		const next = [...record.entries, entry];
		next.sort(
			record.spec.kind === 'list'
				? (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0) || (a.options.order ?? 0) - (b.options.order ?? 0)
				: (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)
		);
		record.entries = next;
		return () => {
			record.entries = record.entries.filter((candidate) => candidate !== entry);
		};
	},
	entries(name) {
		return recordOf(name).entries;
	},
	entriesOfSlot(name) {
		const record = recordOf(name);
		if (record.spec === undefined) return [];
		const seen = new Set();
		const out = [];
		for (const entry of record.entries) {
			const cell = record.spec.kind === 'list' ? entry.options.id : undefined;
			if (seen.has(cell)) continue;
			seen.add(cell);
			out.push(entry);
		}
		return out;
	},
	spec(name) {
		return recordOf(name).spec;
	}
};

// 声明：sidebar.workspaces（single，含官方子座位声明）
declare('sidebar.workspaces', { kind: 'single', scope: 'root' });
declare('sidebar.workspaces.session.menu.item', {
	kind: 'list',
	scope: 'root',
	inject: { hooks: { menuOpenState: () => () => [false, () => {}] } }
});
declare('sidebar.workspaces.session.row.action', { kind: 'list', scope: 'root' });
declare('sidebar.session.row.leading', { kind: 'list', scope: 'root' });
declare('sidebar.session.row.hover', { kind: 'list', scope: 'root' });
declare('shell.overlay', { kind: 'list', scope: 'root' });
declare('sidebar.footer.action', { kind: 'list', scope: 'root' });
// 底栏 dock：本插件影子官方 stats 条目（id 'stats' + priority -1）。
declare('conversation.composer.dock', { kind: 'list', scope: 'session' });
// #endregion

// #region 数据替身
function makeStore(initial) {
	let value = initial;
	const listeners = new Set();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot() {
			return value;
		},
		set(next) {
			value = next;
			for (const listener of [...listeners]) listener();
		}
	};
}

const now = Date.now();
const workspacesStore = makeStore({
	phase: 'ready',
	items: [
		{
			workspaceId: 'ws-a',
			title: '工作区 A',
			path: '/demo/a',
			createdAt: new Date(now - 86400000).toISOString(),
			sessionIds: ['s-1', 's-2']
		},
		{
			workspaceId: 'ws-b',
			title: '工作区 B',
			path: '/demo/b',
			createdAt: new Date(now - 43200000).toISOString(),
			sessionIds: ['s-3']
		}
	],
	archivedSessionIds: [],
	pinnedSessionIds: ['s-2']
});

const sessionsStore = makeStore({
	phase: 'ready',
	ids: ['s-1', 's-2', 's-3'],
	byId: {
		's-1': { id: 's-1', title: '会话一', cwd: '/demo/a', updatedAt: new Date(now - 60000).toISOString(), retainedBy: { mainView: 1 } },
		's-2': { id: 's-2', title: '会话二', cwd: '/demo/a', updatedAt: new Date(now - 120000).toISOString(), retainedBy: {} },
		's-3': { id: 's-3', title: '会话三', cwd: '/demo/b', updatedAt: new Date(now - 180000).toISOString(), retainedBy: {} }
	}
});

const calls = [];
const navService = {
	openSession: (id) => calls.push(['openSession', id]),
	startSession: (id) => calls.push(['startSession', id]),
	pinSession: (id) => calls.push(['pinSession', id]),
	unpinSession: (id) => calls.push(['unpinSession', id]),
	archiveSession: (id) => calls.push(['archiveSession', id]),
	unarchiveSession: (id) => calls.push(['unarchiveSession', id]),
	forkSession: (id) => calls.push(['forkSession', id]),
	rename: (id, title) => calls.push(['rename', id, title]),
	delete: (id) => calls.push(['delete', id]),
	create: (input) => calls.push(['create', input]),
	pickDirectory: async () => '/demo/c',
	selection: { getSnapshot: () => ({}) }
};

// #region 真实 Host dispatch（文件夹 sidecar 落盘）
const { apply: hostApply } = await import('../src/index.mjs');
let dispatch = null;
const hostEntity = {
	id: 'ws-a',
	title: '工作区 A',
	path: '/demo/a',
	record: { path: '/demo/a', title: '工作区 A', sessionIds: ['s-1', 's-2'] },
	sessionIds: ['s-1', 's-2'],
	attachSession: async () => {},
	detachSession: async () => {},
	insertSessionBefore: async () => {}
};
const hostHeaders = ['s-1', 's-2', 's-3'].map((id, index) => ({
	id,
	cwd: index < 2 ? '/demo/a' : '/demo/b',
	title: `标题 ${id}`,
	updatedAt: '2026-01-01T00:00:00.000Z'
}));
const hostRegistry = {
	archivedSessionIds: [],
	list: () => [hostEntity],
	insertBefore: async () => ['ws-a'],
	headers: new Map(),
	sessionPaths: new Map(),
	invalidSessionPaths: new Map(),
	unarchiveSession: async () => {}
};
const hostPersistence = {
	list: async () => hostHeaders.map((header) => ({ header: { ...header }, revision: 1 })),
	locate: () => undefined,
	tracker: { writers: new Map() },
	coordinator: { serialize: async (_id, operation) => await operation() }
};
const hostConnection = {
	rpc: {
		handle: (channel, handler) => {
			assert.equal(channel, '/workspace-organizer');
			dispatch = handler;
			return () => {};
		}
	}
};
hostApply({
	logger: { info() {}, warn() {} },
	workspaceRegistry: hostRegistry,
	sessionPersistence: hostPersistence,
	sessions: { get: () => undefined, list: () => [], flush: async () => {} },
	agents: { get: () => undefined },
	connection: hostConnection,
	webServer: {},
	slots: { inject() {}, register() {} },
	get: () => undefined,
	emit: () => {},
	inject: (_names, callback) => callback({ connection: hostConnection, webServer: {}, effect: () => {} }),
	effect: (fn) => fn()
});
assert.equal(typeof dispatch, 'function', 'Host dispatch 应已挂载');
await dispatch('organizer.folders.state', {}).catch(() => {});
// #endregion

const effectDisposers = [];
/** 开关：模拟成本 RPC 整体失败（M5 降级验证用）。 */
let failCostRpc = false;
const ctx = {
	connection: {
		rpc: {
			call: async (channel, endpoint, payload) => {
				assert.equal(channel, '/workspace-organizer');
				if (failCostRpc && String(endpoint).startsWith('organizer.cost.')) throw new Error('成本服务炸了');
				return await dispatch(endpoint, payload);
			}
		}
	},
	slots,
	effect: (fn) => {
		const dispose = fn();
		if (typeof dispose === 'function') effectDisposers.push(dispose);
		return dispose;
	},
	get(name) {
		if (name === 'workspaces') return { list: workspacesStore, rename: navService.rename, delete: navService.delete, create: navService.create };
		if (name === 'sessions') return { list: sessionsStore, using: async () => ({ ok: true }) };
		if (name === 'uiWorkspace') return navService;
		if (name === 'locale') return { bind: () => (key) => key };
		return undefined;
	}
};
// #endregion

// #region client.js 加载
let clientExports = null;
globalThis.window.__ModuleLoader__ = {
	load: ({ factory }) => {
		clientExports = factory((specifier) => {
			if (specifier === 'react') return React;
			if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
			throw new Error(`unexpected require: ${specifier}`);
		});
	}
};
await import('../client.js');
assert.ok(clientExports !== null, 'client.js 未调用 __ModuleLoader__.load');
assert.equal(typeof clientExports.getSessionsInFolder, 'function', '必须导出 getSessionsInFolder');
// #endregion

// #region apply + 官方条目
const officialCalls = [];
const OfficialBrowser = () => React.createElement('div', { 'data-official': 'true' }, '官方浏览器');
slots.register({ name: 'sidebar.workspaces', priority: 0 }, OfficialBrowser);
// 官方 stats 条目（ui-chat 的 StatsPills 替身）：不依赖 t / hooks，只验证渲染与位置。
const OfficialStats = () => React.createElement('span', { 'data-official-stats': 'true' }, '缓存命中 99%');
slots.register(
	{ name: 'conversation.composer.dock', id: 'stats', order: 0, locale: 'chat', inject: () => ({ hooks: {} }) },
	OfficialStats
);
// 官方子座位条目（模拟 ui-workspace 自己的 archive/pin/rename/fork + leading + hover）
const archived = makeStore(new Set());
const pinned = makeStore(new Set(['s-2']));
slots.register(
	{
		name: 'sidebar.workspaces.session.menu.item',
		id: 'pin',
		order: 100,
		inject: () => ({
			hooks: { pinned, archived },
			pinSession: (id) => officialCalls.push(['pin', id]),
			unpinSession: (id) => officialCalls.push(['unpin', id])
		})
	},
	(props) => {
		const isPinned = props.usePinned((set) => set.has(props.sessionId));
		return React.createElement(
			'button',
			{ onClick: () => (isPinned ? props.unpinSession(props.sessionId) : props.pinSession(props.sessionId)) },
			isPinned ? 'PINNED' : 'PIN'
		);
	}
);
slots.register(
	{
		name: 'sidebar.workspaces.session.menu.item',
		id: 'archive',
		order: 400,
		inject: () => ({
			hooks: { archived },
			archiveSession: (id) => officialCalls.push(['archive', id]),
			unarchiveSession: (id) => officialCalls.push(['unarchive', id])
		})
	},
	(props) => {
		const isArchived = props.useArchived((set) => set.has(props.sessionId));
		return React.createElement('button', null, isArchived ? 'UNARCHIVE' : 'ARCHIVE');
	}
);
slots.register(
	{
		name: 'sidebar.workspaces.session.row.action',
		id: 'archive-action',
		order: 100,
		inject: () => ({ hooks: { archived }, archiveSession: (id) => officialCalls.push(['rowArchive', id]) }),
		locale: 'workspace'
	},
	(props) => React.createElement('button', { 'data-action': 'archive' }, 'ACTION')
);
slots.register(
	{
		name: 'sidebar.session.row.leading',
		id: 'status-mark',
		inject: () => ({ hooks: { archived } })
	},
	() => React.createElement('span', { 'data-leading': 'true' }, 'LEAD')
);
slots.register(
	{
		name: 'sidebar.session.row.hover',
		id: 'hover-mark',
		inject: () => ({})
	},
	() => React.createElement('span', { 'data-hover': 'true' }, 'HOVER')
);

clientExports.apply(ctx);

const ledgerEntries = slots.entries('sidebar.workspaces');
assert.equal(ledgerEntries.length, 2, '应同时存在官方 0 与插件 -1 两个条目（ledger）');
const winners = slots.entriesOfSlot('sidebar.workspaces');
assert.equal(winners.length, 1, 'single 槽只投影一个 winner');
assert.equal(winners[0].options.priority, -1, '最低 priority 的条目（插件）赢得渲染位');
const BrowserComponent = winners[0].component;
assert.equal(ledgerEntries.find((entry) => entry.component === OfficialBrowser) !== undefined, true, '官方条目仍在 ledger 里');
// #endregion

// #region 渲染
const flush = async () => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
};

let renderer = null;
await act(async () => {
	renderer = TestRenderer.create(React.createElement(BrowserComponent));
});
await flush();

const all = () => renderer.root.findAll((node) => typeof node.type === 'string');
const textOf = (node) =>
	node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
const byClass = (className) =>
	all().filter((node) => {
		const value = node.props.className;
		return typeof value === 'string' && value.split(/\s+/).includes(className);
	});
const rowKeys = () => all().map((node) => node.props['data-row-key']).filter((key) => typeof key === 'string');
const click = async (node) => {
	assert.ok(node, '找不到要点击的节点');
	await act(async () => {
		node.props.onClick({ stopPropagation() {}, preventDefault() {} });
	});
	await flush();
};

// 1) 初始：两个工作区行，会话折叠
assert.deepEqual(rowKeys().filter((key) => key.startsWith('workspace:')), ['workspace:ws-a', 'workspace:ws-b']);
assert.equal(rowKeys().filter((key) => key.startsWith('session:')).length, 0, '默认折叠，不应有会话行');

// 2) 展开工作区 A：出现会话行，pinned 在前
await click(byClass('wso-chev')[0]);
const sessionKeys = rowKeys().filter((key) => key.startsWith('session:'));
assert.deepEqual(sessionKeys, ['session:s-2', 'session:s-1'], '置顶的 s-2 应在最前');
assert.equal(byClass('wso-row').filter((node) => node.props['data-selected'] === 'true').length, 1, '当前会话应有选中态');

// 3) 官方 row.action / leading 座位插回行内
assert.ok(all().some((node) => node.props['data-action'] === 'archive'), 'row.action 座位应渲染');
assert.ok(all().some((node) => node.props['data-leading'] === 'true'), 'leading 座位应渲染');
assert.ok(all().some((node) => node.props['data-hover'] === 'true'), 'hover 座位应渲染');

// 4) 会话菜单：打开后官方 pin/archive 座位与我们的删除项都在
const menuButton = all().find((node) => node.props['aria-label'] === '会话操作');
assert.ok(menuButton, '会话行应有「会话操作」按钮');
await click(menuButton);
const menuText = textOf(renderer.root);
assert.ok(menuText.includes('PIN') || menuText.includes('PINNED'), '官方 pin 菜单项应出现');
assert.ok(menuText.includes('ARCHIVE'), '官方归档菜单项应出现');
assert.ok(menuText.includes('删除项目…'), '本插件的删除菜单项应出现');

// 5) 点击 pin 座位：走官方 inject 提供的回调
const pinButton = all().find((node) => node.props.onClick && textOf(node).includes('PIN') && !textOf(node).includes('PINNED'));
if (pinButton) {
	await click(pinButton);
	assert.ok(officialCalls.some(([kind]) => kind === 'pin'), 'pin 应回调官方 inject 的 pinSession');
}

// 6) 打开会话：走 uiWorkspace
const sessionRow = byClass('wso-session-row')[1];
await click(sessionRow);
assert.ok(calls.some(([kind, id]) => kind === 'openSession' && id === 's-1'), '点击会话行应调用 uiWorkspace.openSession');

// 7) 搜索过滤
const searchInput = all().find((node) => node.props.className === 'wso-search-input');
await act(async () => {
	searchInput.props.onChange({ target: { value: '会话三' } });
});
await flush();
assert.deepEqual(rowKeys().filter((key) => key.startsWith('workspace:')), ['workspace:ws-b']);
assert.deepEqual(rowKeys().filter((key) => key.startsWith('session:')), ['session:s-3']);
await act(async () => {
	searchInput.props.onChange({ target: { value: '' } });
});
await flush();

// 8) 归档过滤：只显示归档
const viewButton = all().find((node) => node.props['aria-label'] === '视图选项');
await click(viewButton);
const onlyArchived = all().find((node) => node.props.onClick && textOf(node) === '仅已归档');
await click(onlyArchived);
assert.deepEqual(rowKeys().filter((key) => key.startsWith('workspace:')), [], '没有归档会话时仅归档视图为空');
const filterReset = all().find((node) => node.props['aria-label'] === '视图选项');
await click(filterReset);
const showAll = all().find((node) => node.props.onClick && textOf(node) === '隐藏已归档');
await click(showAll);
assert.ok(rowKeys().includes('workspace:ws-a'), '恢复默认后工作区重新出现');

// 9) 折叠回去
await click(byClass('wso-chev')[0]);
assert.equal(rowKeys().filter((key) => key.startsWith('session:')).length, 0, '折叠后会话行消失');

// #region M3：文件夹行
// 渲染 overlay（对话框 + 按钮）以便走真实的「新建文件夹」流程。
const overlayComponent = slots.entriesOfSlot('shell.overlay').map((entry) => entry.component).find(Boolean);
assert.ok(overlayComponent, '应注册 shell.overlay 座位');
let overlayRenderer = null;
await act(async () => {
	overlayRenderer = TestRenderer.create(React.createElement(overlayComponent));
});
const overlayAll = () => overlayRenderer.root.findAll((node) => typeof node.type === 'string');
const overlayText = () => overlayAll().map((node) => (typeof node.props.children === 'string' ? node.props.children : '')).join('|');

// 展开工作区 A（前面测试把它折叠了）
await click(byClass('wso-chev')[0]);

// 工作区菜单 → 新建文件夹
const wsMenuButton = all().find((node) => node.props['aria-label'] === '工作区操作');
assert.ok(wsMenuButton, '工作区行应有操作菜单');
await click(wsMenuButton);
const newFolderItem = all().find((node) => node.props.onClick && textOf(node) === '新建文件夹');
assert.ok(newFolderItem, '工作区菜单应有「新建文件夹」');
await click(newFolderItem);

const folderNameInput = overlayAll().find((node) => node.props.placeholder === '文件夹名称');
assert.ok(folderNameInput, '应弹出新建文件夹对话框');
await act(async () => {
	folderNameInput.props.onChange({ target: { value: '前端项目' } });
});
const saveButton = overlayAll().find((node) => node.props.onClick && textOf(node) === '保存');
assert.ok(saveButton, '对话框应有保存按钮');
await act(async () => {
	saveButton.props.onClick();
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});

const folderState = (await dispatch('organizer.folders.state', {})).value;
assert.equal(folderState.folders.length, 1, 'Host 应落盘一个文件夹');
const folderId = folderState.folders[0].id;
assert.equal(folderState.folders[0].workspaceId, 'ws-a');
assert.ok(rowKeys().includes(`folder:${folderId}`), '树里应出现文件夹行');

// 收纳 s-1（M3 里收纳走 RPC；拖拽在 M4）
const added = await dispatch('organizer.folders.add', { folderId, sessionId: 's-1' });
assert.equal(added.ok, true);
// 触发一次 reload：改文件夹颜色（同时验证颜色落盘）
await act(async () => {
	clientExports.ui.set({ dialog: { kind: 'rename-folder', folderId, name: '前端项目', color: '#4f7cf5' } });
});
await flush();
const colorSave = overlayAll().find((node) => node.props.onClick && textOf(node) === '保存');
await act(async () => {
	colorSave.props.onClick();
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});
assert.equal((await dispatch('organizer.folders.state', {})).value.folders[0].color, '#4f7cf5');

// 收纳后：s-1 不再出现在工作区顶层，展开文件夹才出现
assert.equal(rowKeys().includes('session:s-1'), false, '已收纳会话不应占工作区顶层');
const folderRowKey = `folder:${folderId}`;
const folderRow = all().find((node) => node.props['data-row-key'] === folderRowKey);
assert.ok(folderRow, '文件夹行应存在');
await click(folderRow);
assert.ok(rowKeys().includes('session:s-1'), '展开文件夹后应能看到内部会话');
assert.equal(rowKeys().indexOf(`folder:${folderId}`) < rowKeys().indexOf('session:s-1'), true, '文件夹行在内部会话之前');

// 交错顺序：把文件夹排到 s-2 前面
await dispatch('organizer.folders.order', {
	workspaceId: 'ws-a',
	items: [{ type: 'session', id: 's-2' }, { type: 'folder', id: folderId }]
});
await act(async () => {
	clientExports.ui.set({ dialog: { kind: 'rename-folder', folderId, name: '前端项目', color: '#4f7cf5' } });
});
await flush();
const saveAgain = overlayAll().find((node) => node.props.onClick && textOf(node) === '保存');
await act(async () => {
	saveAgain.props.onClick();
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});
const orderedKeys = rowKeys().filter((key) => key === 'session:s-2' || key === folderRowKey);
assert.deepEqual(orderedKeys, ['session:s-2', folderRowKey], '文件夹与未收纳会话应按 WorkspaceItemOrder 交错');

// 删除文件夹：内部会话回退到未收纳区，会话本身不消失
const folderRow2 = all().find((node) => node.props['data-row-key'] === folderRowKey);
await act(async () => {
	clientExports.ui.set({ dialog: null });
});
await click(folderRow2);
const folderMenuButton = all().find((node) => node.props['aria-label'] === '文件夹操作');
assert.ok(folderMenuButton, '文件夹行应有操作菜单');
await click(folderMenuButton);
const deleteItem = all().find((node) => node.props.onClick && textOf(node) === '删除文件夹');
assert.ok(deleteItem, '文件夹菜单应有删除项');
globalThis.window.confirm = () => true;
await click(deleteItem);
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});
const afterDelete = (await dispatch('organizer.folders.state', {})).value;
assert.equal(afterDelete.folders.length, 0, '文件夹应被删除');
assert.equal(afterDelete.memberships.length, 0, '成员关系应被清掉');
assert.ok(rowKeys().includes('session:s-1'), '被释放的会话应回到未收纳区');
// #endregion


// #region M4：拖拽收纳 / 拖出 / 同层排序
// 重新建一个文件夹（M3 末尾删掉了），并展开工作区。
const wsA = all().find((node) => node.props['aria-label'] === '工作区 A');
assert.ok(wsA, '工作区 A 行应存在');
if (wsA.props['aria-expanded'] !== true) {
	await click(wsA);
}
const wsMenu2 = all().find((node) => node.props['aria-label'] === '工作区操作');
await click(wsMenu2);
const newFolder2 = all().find((node) => node.props.onClick && textOf(node) === '新建文件夹');
await click(newFolder2);
const nameInput2 = overlayAll().find((node) => node.props.placeholder === '文件夹名称');
await act(async () => {
	nameInput2.props.onChange({ target: { value: '拖拽测试' } });
});
const save2 = overlayAll().find((node) => node.props.onClick && textOf(node) === '保存');
await act(async () => {
	save2.props.onClick();
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});
const stateM4 = (await dispatch('organizer.folders.state', {})).value;
assert.equal(stateM4.folders.length, 1);
const folderIdM4 = stateM4.folders[0].id;

const fakeDragEvent = (overrides = {}) => {
	const event = {
		preventDefault() {
			event.defaultPrevented = true;
		},
		stopPropagation() {
			event.propagationStopped = true;
		},
		defaultPrevented: false,
		propagationStopped: false,
		clientY: 0,
		currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 24, left: 0, right: 0, bottom: 24, width: 0 }) },
		dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' }
	};
	return Object.assign(event, overrides);
};
const rowByKey = (key) => all().find((node) => node.props['data-row-key'] === key);

// 1) 拖未收纳会话 s-2 到文件夹行：收纳
const unassignedRow = rowByKey('session:s-2');
assert.ok(unassignedRow, '未收纳会话行应存在');
const folderRowM4 = rowByKey(`folder:${folderIdM4}`);
assert.ok(folderRowM4, '文件夹行应存在');
await act(async () => {
	unassignedRow.props.onDragStart(fakeDragEvent());
});
const overEvent = fakeDragEvent();
await act(async () => {
	folderRowM4.props.onDragOver(overEvent);
});
assert.equal(overEvent.defaultPrevented, true, '文件夹行应接受收纳拖拽（preventDefault）');
await act(async () => {
	folderRowM4.props.onDrop(fakeDragEvent());
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});
let members = (await dispatch('organizer.folders.state', {})).value;
assert.deepEqual(members.memberships.map((item) => item.sessionId), ['s-2'], '拖到文件夹行应写入归属');

// 2) 展开文件夹，能看到 s-2；s-2 不再出现在顶层
const folderRowM4b = rowByKey(`folder:${folderIdM4}`);
await click(folderRowM4b);
assert.ok(rowKeys().includes('session:s-2'), '展开文件夹后能看到内部会话');
const idxFolder = rowKeys().indexOf(`folder:${folderIdM4}`);
const idxS2 = rowKeys().indexOf('session:s-2');
assert.ok(idxFolder >= 0 && idxS2 > idxFolder, '内部会话应在文件夹行之后');

// 3) 拖出：把文件夹内 s-2 拖到未收纳会话 s-1 上
const insideRow = rowByKey('session:s-2');
const targetRow = rowByKey('session:s-1');
assert.ok(insideRow && targetRow, '两个会话行都应存在');
await act(async () => {
	insideRow.props.onDragStart(fakeDragEvent());
});
await act(async () => {
	targetRow.props.onDragOver(fakeDragEvent({ clientY: 20 })); // 下半区 → after
});
await act(async () => {
	targetRow.props.onDrop(fakeDragEvent({ clientY: 20 }));
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});
members = (await dispatch('organizer.folders.state', {})).value;
assert.deepEqual(members.memberships.map((item) => item.sessionId), [], '拖到未收纳会话应移出文件夹');
assert.ok(rowKeys().includes('session:s-2'), '移出后会话仍可见（未被删除）');

// 4) 同层排序：把文件夹拖到 s-1 之前
const folderRowM4c = rowByKey(`folder:${folderIdM4}`);
const s1Row = rowByKey('session:s-1');
await act(async () => {
	folderRowM4c.props.onDragStart(fakeDragEvent());
});
await act(async () => {
	s1Row.props.onDragOver(fakeDragEvent({ clientY: 2 })); // 上半区 → before
});
await act(async () => {
	s1Row.props.onDrop(fakeDragEvent({ clientY: 2 }));
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30));
});
const orderM4 = (await dispatch('organizer.folders.state', {})).value.orders['ws-a'];
assert.deepEqual(orderM4[0], { type: 'folder', id: folderIdM4 }, '文件夹应被排到 s-1 之前');

// 5) 不吞事件：没有本插件发起拖拽时，onDrop 不应 preventDefault
const probe = fakeDragEvent();
const anySessionRow = rowByKey('session:s-1');
await act(async () => {
	anySessionRow.props.onDrop(probe);
});
assert.equal(probe.defaultPrevented, false, '非本插件拖拽不应被吞掉');
// #endregion

// #region M2/M3：文件夹成本小计 + 悬停明细
// 等第一次成本快照落地（新建文件夹后 1200ms debounce 才拉）
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 1600));
});
await flush();
// 空文件夹：没有成本语义 → 成本位整块隐藏（绝不显示 ¥0.00 或占位符）
const emptyCostRow = rowByKey(`folder:${folderIdM4}`);
assert.ok(emptyCostRow, '文件夹行应存在');
assert.equal(textOf(emptyCostRow).includes('¥'), false, '空文件夹不应出现金额');
assert.equal(textOf(emptyCostRow).includes('—'), false, '空文件夹也不应出现占位符');

// 工作区行总花费：包含该工作区全部会话（这里 s-1 已计价 1.5、s-2 未计价）
const wsCostRow = all().find((node) => node.props['data-row-key'] === 'workspace:ws-a');
assert.ok(wsCostRow, '工作区行应存在');
assert.ok(textOf(wsCostRow).includes('¥1.50'), `工作区行应显示总花费，实际：${textOf(wsCostRow)}`);
assert.ok(String(wsCostRow.props.title || '').includes('其中未收纳'), '工作区行悬停应给出会话/未收纳明细');

// 未收纳会话不带任何成本标注（文件夹级汇总只属于文件夹行）
assert.equal(textOf(rowByKey('session:s-1')).includes('¥'), false, '未收纳会话不显示文件夹级成本');

// 把已计价的 s-1 拖进文件夹 → 行内出现小计
await act(async () => {
	rowByKey('session:s-1').props.onDragStart(fakeDragEvent());
});
await act(async () => {
	rowByKey(`folder:${folderIdM4}`).props.onDrop(fakeDragEvent());
});
await flush();
await act(async () => {
	// cost 快照有 1200ms debounce（合并会话高频事件），这里等它落地
	await new Promise((resolve) => setTimeout(resolve, 1600));
});
await flush();

const pricedRow = rowByKey(`folder:${folderIdM4}`);
assert.ok(textOf(pricedRow).includes('¥1.50'), `文件夹行应显示小计 ¥1.50，实际：${textOf(pricedRow)}`);
assert.equal(textOf(pricedRow).includes('*'), false, '数据完整时不应带缺失标记');

// 悬停明细卡（HoverCard 替身会同时渲染 anchor 与 content）
const cardText = textOf(renderer.root);
assert.ok(cardText.includes('文件夹总计'), '明细卡应有文件夹总计');
assert.ok(cardText.includes('估算值（非平台账单）'), '明细卡必须声明这是估算值');

// 明细求和 = 小计
const costSnapshot = (await dispatch('organizer.cost.snapshot', {})).value;
const view = costSnapshot.folders[folderIdM4];
assert.equal(view.sessionCount, 1);
assert.equal(view.sessions.length, 1);
assert.equal(view.sessions[0].sessionId, 's-1');
assert.equal(view.sessions[0].cost, 1.5);
assert.equal(Number(view.sessions.reduce((sum, item) => sum + (item.cost ?? 0), 0).toFixed(6)), view.totalCost);

// 同一次快照里工作区总计与会话级缓存必须同步（真实 Host dispatch）
assert.equal(costSnapshot.workspaces['ws-a'].totalCost, 1.5, '工作区总计只含已计价会话');
assert.equal(costSnapshot.workspaces['ws-a'].sessionCount, 2);
assert.equal(costSnapshot.workspaces['ws-a'].missingCount, 1);
assert.equal(costSnapshot.sessions['s-1'].cost, 1.5, '底栏可直接读会话级缓存');
assert.equal(costSnapshot.sessions['s-2'].missing, true, '未计价会话必须标 missing');

// 再拖入一个“查不到成本”的会话 s-2 → 小计带缺失标记，会话行标“未计价”
await act(async () => {
	rowByKey('session:s-2').props.onDragStart(fakeDragEvent());
});
await act(async () => {
	rowByKey(`folder:${folderIdM4}`).props.onDrop(fakeDragEvent());
});
await flush();
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 1600));
});
await flush();
const partialRow = rowByKey(`folder:${folderIdM4}`);
assert.ok(textOf(partialRow).includes('¥1.50*'), `部分缺失应标注 *，实际：${textOf(partialRow)}`);
const partialSnapshot = (await dispatch('organizer.cost.snapshot', {})).value;
assert.equal(partialSnapshot.folders[folderIdM4].missingCount, 1);
assert.equal(partialSnapshot.folders[folderIdM4].totalCost, 1.5, '缺失会话不计入总计');
// 会话行 / 明细卡里的“未计价”标注
const rowTexts = all().map(textOf);
assert.ok(rowTexts.some((text) => text.includes('未计价')), '缺失会话必须标“未计价”');
assert.ok(rowTexts.some((text) => text.includes('部分数据缺失')), '明细卡必须标“部分数据缺失”');
// #endregion

// #region M6：底栏当前会话花费（与官方 stats 并列的独立条目）
const dockEntries = slots.entries('conversation.composer.dock');
assert.equal(dockEntries.length, 2, '官方 stats 与本插件花费条目应同时留在 ledger');
assert.equal(dockEntries[0].options.id, 'stats', '官方统计条目必须排在最前');
assert.equal(dockEntries[1].options.id, 'workspace-organizer-cost', '本插件用独立 id 并列注册，绝不遮蔽官方 stats');
assert.equal(dockEntries[1].options.order, 10, '花费徽章排在官方 stats 之后（即「缓存命中」与「上下文占用」之间）');
assert.equal(dockEntries[0].options.priority, undefined, '官方 stats 条目不得被 priority 影子');
const dockWinners = slots.entriesOfSlot('conversation.composer.dock');
assert.equal(dockWinners.length, 2, '两个不同 id 的 cell 都要存活（官方 stats 不被遮蔽）');
const costSeat = dockWinners.find((entry) => entry.options.id === 'workspace-organizer-cost');
const statsSeat = dockWinners.find((entry) => entry.options.id === 'stats');
assert.ok(costSeat !== undefined, '本插件花费条目必须是 winner');
assert.ok(statsSeat !== undefined, '官方 stats 条目必须仍然可见');
let dockRenderer = null;
await act(async () => {
	dockRenderer = TestRenderer.create(React.createElement(costSeat.component, {}));
});
await flush();
const dockText = () => {
	const out = [];
	const walk = (node) => {
		if (typeof node === 'string') out.push(node);
		else if (node !== null && node !== undefined && Array.isArray(node.children)) node.children.forEach(walk);
	};
	walk(dockRenderer.root);
	return out.join('');
};
const dockRendered = dockText();
assert.ok(dockRendered.includes('¥1.50'), `底栏应显示当前会话花费 ¥1.50，实际：${dockRendered}`);
assert.ok(
	!dockRendered.includes('缓存命中 99%'),
	'官方 stats 由官方条目自己渲染，本插件不得重复渲染一份'
);
assert.equal(
	dockRenderer.root.findAll((node) => typeof node.type === 'string' && node.props.className === 'wso-dock-cost').length,
	1,
	'底栏只应有一个花费徽章'
);
// #endregion


// #region M5：成本模块失败 → 隐藏成本列、显示「成本统计不可用」、文件夹照常可用
failCostRpc = true;
await act(async () => {
	// 让 sessionSnapshot 变一下，触发 1200ms debounce 的成本刷新
	sessionsStore.set(Object.assign({}, sessionsStore.getSnapshot(), { ids: [...sessionsStore.getSnapshot().ids] }));
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 1600));
});
await flush();
assert.ok(
	all().some((node) => textOf(node) === '成本统计不可用'),
	'成本 RPC 失败时应出现「成本统计不可用」提示'
);
const degradedFolderRow = all().find((node) => node.props['data-row-key'] === `folder:${folderIdM4}`);
assert.ok(degradedFolderRow, '成本失败不影响文件夹行渲染');
assert.equal(textOf(degradedFolderRow).includes('¥'), false, '成本不可用时应隐藏成本列');
// 底栏降级：徽章整块消失；官方 stats 条目本身不受影响（仍由官方负责渲染）
const degradedDock = dockText();
assert.equal(degradedDock.includes('¥'), false, '成本不可用时应隐藏底栏花费徽章');
assert.ok(
	slots.entriesOfSlot('conversation.composer.dock').some((entry) => entry.options.id === 'stats'),
	'成本不可用不得影响官方 stats 条目存活'
);
// 工作区行也隐藏花费
const degradedWsRow = all().find((node) => node.props['data-row-key'] === 'workspace:ws-a');
assert.ok(degradedWsRow, '成本失败不影响工作区行渲染');
assert.equal(textOf(degradedWsRow).includes('¥'), false, '成本不可用时应隐藏工作区花费');
// 折叠/展开照常可用（成本模块失败不得阻断文件夹本身）
if (degradedFolderRow.props['aria-expanded'] === true) {
	await click(degradedFolderRow);
	assert.equal(rowKeys().includes('session:s-1'), false, '折叠后内部会话隐藏');
	await click(degradedFolderRow);
	assert.equal(rowKeys().includes('session:s-1'), true, '再展开仍能看到内部会话');
}
failCostRpc = false;
// #endregion


// 10) 切到官方视图：disposer 生效，ledger 只剩官方条目
await act(async () => {
	clientExports.ui.set({});
	const footer = slots.entriesOfSlot('sidebar.footer.action').map((entry) => entry.component);
	assert.ok(footer.length >= 2, '应注册回收站与视图切换两个 footer 条目');
});
const toggle = slots
	.entriesOfSlot('sidebar.footer.action')
	.map((entry) => entry.component)
	.find((component) => component && component.name === 'ViewToggleFooterAction');
assert.ok(toggle, '应有切换官方视图的 footer 组件');
let toggleRenderer = null;
await act(async () => {
	toggleRenderer = TestRenderer.create(React.createElement(toggle));
});
await flush();
const toggleButton = toggleRenderer.root.findAll((node) => typeof node.type === 'string' && node.props.onClick)[0];
await act(async () => {
	toggleButton.props.onClick();
});
await flush();
const afterToggle = slots.entriesOfSlot('sidebar.workspaces');
assert.equal(afterToggle.length, 1, '切到官方视图后 single 槽仍只有一个 winner');
assert.equal(afterToggle[0].component, OfficialBrowser, '官方条目回到渲染位');
assert.equal(slots.entries('sidebar.workspaces').length, 1, '插件的 -1 条目应被撤下');

// 切回来
await act(async () => {
	toggleButton.props.onClick();
});
await flush();
assert.equal(slots.entries('sidebar.workspaces').length, 2, '切回后插件条目重新注册');
assert.equal(slots.entriesOfSlot('sidebar.workspaces')[0].options.priority, -1, '切回后插件重新赢得渲染位');

// #region M5：降级与卸载
// 1) 槽位未声明：不注册接管、不抛
const degradedRegisterNames = [];
const degradedCtx = {
	connection: ctx.connection,
	slots: {
		inject(_name, callback) {
			const dispose = callback();
			return typeof dispose === 'function' ? dispose : () => {};
		},
		register(options) {
			degradedRegisterNames.push(options.name);
			return () => {};
		},
		entries: () => [],
		entriesOfSlot: () => [],
		spec: () => undefined
	},
	effect: (fn) => {
		const dispose = fn();
		return dispose;
	},
	get(name) {
		if (name === 'workspaces') return { list: workspacesStore };
		if (name === 'sessions') return { list: sessionsStore };
		if (name === 'locale') return { bind: () => (key) => key };
		return undefined;
	}
};
assert.doesNotThrow(() => clientExports.apply(degradedCtx), '槽位缺失时 apply 不应抛');
assert.equal(degradedRegisterNames.includes('sidebar.workspaces'), false, '槽位缺失时不应注册 sidebar.workspaces');

// 2) register 抛错：放弃接管，官方条目继续渲染（不抛、不反复重试）
const conflictCtx = {
	connection: ctx.connection,
	slots: {
		inject(_name, callback) {
			const dispose = callback();
			return typeof dispose === 'function' ? dispose : () => {};
		},
		register(options) {
			if (options.name === 'sidebar.workspaces') throw new Error('single slot already registered');
			return () => {};
		},
		entries: () => [],
		entriesOfSlot: () => slots.entriesOfSlot('sidebar.workspaces'),
		spec: (name) => (name === 'sidebar.workspaces' ? { kind: 'single', scope: 'root' } : undefined)
	},
	effect: (fn) => {
		const dispose = fn();
		return dispose;
	},
	get(name) {
		if (name === 'workspaces') return { list: workspacesStore };
		if (name === 'sessions') return { list: sessionsStore };
		if (name === 'locale') return { bind: () => (key) => key };
		return undefined;
	}
};
assert.doesNotThrow(() => clientExports.apply(conflictCtx), '接管注册失败时 apply 不应抛');
assert.ok(slots.entries('sidebar.workspaces').some((entry) => entry.component === OfficialBrowser), '接管失败时官方条目仍在 ledger 里');

// 3) 卸载：调所有 effect disposer，ledger 里不应留下本插件的条目
for (const dispose of effectDisposers.splice(0)) dispose();
await flush();
const remaining = slots
	.entries('sidebar.workspaces')
	.filter((entry) => entry.component !== OfficialBrowser)
	.length;
assert.equal(remaining, 0, '卸载后 sidebar.workspaces 不应残留插件条目');
assert.equal(
	slots
		.entries('sidebar.workspaces.session.menu.item')
		.filter((entry) => String(entry.options.id || '').startsWith('workspace-organizer')).length,
	0,
	'卸载后会话菜单座位不应残留'
);
assert.equal(
	slots
		.entries('sidebar.footer.action')
		.filter((entry) => String(entry.options.id || '').startsWith('workspace-organizer')).length,
	0,
	'卸载后 footer 座位不应残留'
);
// #endregion


// #region 冷启动顺序回归（真实 SlotRegistry：无 specDynamic / subscribeDeclaration）
//
// ui-sidebar 的 inject 是 ['slots','layout','sessions','workspaces','locale']，
// 本插件只需要 ['connection','slots'] —— 冷启动时本插件先 apply，此时
// sidebar.workspaces 还没有声明。旧实现用 subscribeDeclaration 兜底，
// 而该函数在真实服务面上并不存在，于是永久放弃接管，只有重载插件才恢复。
{
	const coldRecords = new Map();
	const coldRecordOf = (name) => {
		let record = coldRecords.get(name);
		if (record === undefined) {
			record = { spec: undefined, entries: [], waiters: [] };
			coldRecords.set(name, record);
		}
		return record;
	};
	const coldDeclare = (name, spec) => {
		const record = coldRecordOf(name);
		record.spec = spec;
		for (const waiter of record.waiters.splice(0)) waiter.run();
	};
	const coldSlots = {
		inject(name, callback) {
			const run = () => {
				const dispose = callback();
				return typeof dispose === 'function' ? dispose : () => {};
			};
			const record = coldRecordOf(name);
			if (record.spec !== undefined) return run();
			const waiter = { run: null, dispose: null, active: true };
			waiter.run = () => {
				if (!waiter.active) return;
				waiter.dispose = run();
			};
			record.waiters.push(waiter);
			return () => {
				if (!waiter.active) return;
				waiter.active = false;
				if (typeof waiter.dispose === 'function') waiter.dispose();
			};
		},
		register(options, component) {
			const record = coldRecordOf(options.name);
			if (record.spec === undefined) throw new Error('slot "' + options.name + '" is not declared');
			const entry = {
				component,
				options: { id: options.id, order: options.order, priority: options.priority },
				inject: options.inject,
				locale: options.locale
			};
			record.entries = [...record.entries, entry].sort(
				(a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)
			);
			return () => {
				record.entries = record.entries.filter((candidate) => candidate !== entry);
			};
		},
		entries(name) {
			return coldRecordOf(name).entries;
		},
		entriesOfSlot(name) {
			const record = coldRecordOf(name);
			if (record.spec === undefined) return [];
			return record.entries.slice(0, record.spec.kind === 'single' ? 1 : record.entries.length);
		},
		spec(name) {
			return coldRecordOf(name).spec;
		}
	};

	storage.set('dsh.workspace-organizer.view.v1', JSON.stringify({ version: 1, mode: 'tree' }));
	storage.set('dsh.workspace-organizer.folders.v1', JSON.stringify({ folders: [], memberships: [], orders: {} }));

	let coldExports = null;
	globalThis.window.__ModuleLoader__ = {
		load: ({ factory }) => {
			coldExports = factory((specifier) => {
				if (specifier === 'react') return React;
				if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
				throw new Error('unexpected require: ' + specifier);
			});
		}
	};
	await import('../client.js?cold-start-order');
	assert.ok(coldExports !== null, '冷启动用例未能加载 client.js');

	const coldDisposers = [];
	const coldCtx = {
		connection: ctx.connection,
		slots: coldSlots,
		effect: (fn) => {
			const dispose = fn();
			if (typeof dispose === 'function') coldDisposers.push(dispose);
			return dispose;
		},
		get(name) {
			if (name === 'workspaces') return { list: workspacesStore };
			if (name === 'sessions') return { list: sessionsStore };
			if (name === 'uiWorkspace') return navService;
			if (name === 'locale') return { bind: () => (key) => key };
			return undefined;
		}
	};

	coldExports.apply(coldCtx);
	assert.equal(
		coldSlots.entries('sidebar.workspaces').length,
		0,
		'槽位尚未声明时不应抢注（真实冷启动：本插件先于 ui-sidebar 激活）'
	);

	// ui-sidebar 稍后注册 sidebar 条目（同时声明 sidebar.workspaces）
	coldDeclare('sidebar.workspaces', { kind: 'single', scope: 'root' });
	coldSlots.register({ name: 'sidebar.workspaces', priority: 0 }, OfficialBrowser);

	const coldWinners = coldSlots.entriesOfSlot('sidebar.workspaces');
	assert.equal(coldWinners.length, 1, 'single 槽只投影一个 winner');
	assert.equal(coldWinners[0].options.priority, -1, '声明晚到时插件应自动接管，而不是永久放弃');
	assert.equal(coldWinners[0].component !== OfficialBrowser, true, '渲染位应交给插件自己的树');

	for (const dispose of coldDisposers.splice(0)) dispose();
	assert.equal(coldSlots.entries('sidebar.workspaces').length, 1, '卸载后只剩官方条目');
}
// #endregion

await act(async () => {
	renderer.unmount();
	if (dockRenderer !== null) dockRenderer.unmount();
});
await rm(root, { recursive: true, force: true }).catch(() => {});
console.log('tree-check: 接管(M1) + 文件夹(M3/M4) + 成本小计/工作区总计/底栏徽章 + 降级(M2/M3/M5/M6) 全部断言通过');
