/**
 * dsh-workspace-organizer — Client 半（source-as-product，无需构建）。
 *
 * 侧边栏工作区浏览器**接管**（priority -1 影子渲染）：
 *   工作区行 →（文件夹行，可折叠）→ 会话行
 * 文件夹是工作区内部的**视图层容器**：只改渲染与元数据，不改 Session 的
 * header.cwd、不移动磁盘文件、不删除任何会话或目录。
 *
 * 架构约束（用户拍板）：
 *  - 走 `sidebar.workspaces` 槽位 priority -1 接管；disposer 一调，官方
 *    priority 0 的浏览器自动回到渲染位。
 *  - **不声明 children**：官方条目已持有 sidebar.workspaces.directoryFlow、
 *    .session.menu.item、.session.row.action、sidebar.session.row.leading、
 *    .hover 等子座位；重声明会抛 "already declared" 并静默注销自己的座位。
 *  - 官方行座位从 ledger 读回：slots.entriesOfSlot(name) → { component,
 *    inject(), locale }，按官方渲染协议组装 props 后插回原位。缺失就跳过，
 *    不阻断整树渲染。
 *  - store 用私有实例（localStorage 视图状态），不信任合成 props.useStore。
 *  - 服务缺失 / 渲染崩溃都降级，不拖垮 fiber（guarded + QuietBoundary）。
 *
 * 另保留的既有能力：跨工作区拖拽移动（改 cwd、保留历史）、删除项目
 * （回收站 / 仅移除注册 / 彻底删除）、回收站面板。
 */
window.__ModuleLoader__.load({
	id: 'dsh-workspace-organizer',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const { useState, useEffect } = React;
		const h = React.createElement;

		/* ------------------------------------------------------------------ *
		 * UI primitives（可能缺包：缺哪个就退化成空实现，不阻断渲染）
		 * ------------------------------------------------------------------ */
		let P = {};
		try {
			P = require('@deepseek-ai/dsh-client-ui-primitives') || {};
		} catch {
			P = {};
		}
		const passThrough = (props) => (props && props.children !== undefined ? props.children : null);
		const pick = (name, fallback) => (P && typeof P[name] === 'function' ? P[name] : fallback);
		const Modal = pick('Modal', passThrough);
		const Button = pick('Button', (props) => h('button', { onClick: props.onClick, disabled: props.disabled }, props.children));
		const MenuItemButton = pick('MenuItemButton', (props) => h('button', { onClick: props.onSelect }, props.children));
		const Menu = pick('Menu', ({ open, anchor, children }) => (open ? h('div', null, anchor, children) : h('div', null, anchor)));
		const Tooltip = pick('Tooltip', (props) => h('span', { title: props.label }, props.children));
		const HoverCard = pick('HoverCard', (props) => props.anchor);
		const Toast = pick('Toast', () => null);
		const IconTrashOutlineRegular = pick('IconTrashOutlineRegular', () => null);
		const IconWarningOutlineRegular = pick('IconWarningOutlineRegular', () => null);
		const IconFolderOpenRegular = pick('IconFolderOpenRegular', () => null);
		const IconFolderCloseRegular = pick('IconFolderCloseRegular', () => null);
		const IconChevronDownOutlineRegular = pick('IconChevronDownOutlineRegular', () => null);
		const IconChevronRightOutlineRegular = pick('IconChevronRightOutlineRegular', () => null);
		const IconPlusOutlineRegular = pick('IconPlusOutlineRegular', () => null);
		const IconEditOutlineRegular = pick('IconEditOutlineRegular', () => null);
		const IconCloseOutlineRegular = pick('IconCloseOutlineRegular', () => null);
		const IconRefreshOutlineRegular = pick('IconRefreshOutlineRegular', () => null);
		const IconEllipsisOutlineRegular = pick('IconEllipsisOutlineRegular', () => null);
		const IconNewChatOutlineRegular = pick('IconNewChatOutlineRegular', () => null);
		const IconArchiveOutlineRegular = pick('IconArchiveOutlineRegular', () => null);
		const IconUnarchiveOutlineRegular = pick('IconUnarchiveOutlineRegular', () => null);
		const IconSearchOutlineRegular = pick('IconSearchOutlineRegular', () => null);
		const IconFlatListOutlineRegular = pick('IconFlatListOutlineRegular', () => null);
		const IconWorkspaceTreeOutlineRegular = pick('IconWorkspaceTreeOutlineRegular', () => null);
		const IconTriangleRightFillRegular = pick('IconTriangleRightFillRegular', () => null);
		const IconPinOutlineRegular = pick('IconPinOutlineRegular', () => null);
		const IconPinFillRegular = pick('IconPinFillRegular', () => null);
		const relativeTime = typeof P.relativeTime === 'function' ? P.relativeTime : () => ({ unit: 'minute', n: 0 });

		const PLUGIN = 'dsh-workspace-organizer';
		const CHANNEL = '/workspace-organizer';
		const WORKSPACE_NS = 'workspace';

		// #region 样式
		const CSS = `
.wso-footer-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.wso-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wso-footer-action[data-on="true"]{color:var(--dsw-alias-label-primary)}
.wso-drop-target{outline:2px dashed var(--dsw-alias-state-business-primary,#4f7cf5)!important;outline-offset:-2px;border-radius:8px}
.wso-body{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.wso-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wso-option{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:10px;cursor:pointer}
.wso-option[data-active="true"]{border-color:var(--dsw-alias-state-business-primary,#4f7cf5);background:var(--dsw-alias-interactive-bg-hover)}
.wso-option input{margin-top:3px}
.wso-option-title{font-weight:500}
.wso-warn{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-warning,#fff7e6);color:var(--dsw-alias-label-primary)}
.wso-list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto;padding-right:4px}
.wso-row{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:10px}
.wso-row-main{flex:1;min-width:0}
.wso-row-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wso-row-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wso-actions{display:flex;gap:6px;flex:none}
.wso-empty{padding:18px 4px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.wso-input{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}
.wso-input:focus{border-color:var(--dsw-alias-state-business-primary,#4f7cf5)}

.wso-root{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;font-size:13px;color:inherit;line-height:20px}
.wso-head{display:flex;align-items:center;gap:2px;padding:2px 6px 4px}
.wso-head-title{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wso-search{display:flex;align-items:center;gap:5px;margin:0 6px 6px;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover)}
.wso-search-input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:12px}
.wso-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.wso-tree-list{position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 4px 8px}
.wso-exits{contain:strict;pointer-events:none;position:absolute;inset:0;overflow:clip}
/* 本段 .wso-row 与上方对话框列表的 .wso-row 同名，必须显式清掉 border/背景，
   否则侧边栏每一行都会继承对话框行的 1px 外框。 */
.wso-row{display:flex;align-items:center;gap:4px;min-height:26px;padding:1px 6px;border:0;border-radius:6px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);background:none}
.wso-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wso-row[data-selected="true"]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover))}
.wso-row[data-active="true"]{font-weight:500}
.wso-row[data-drop-marker="before"]{box-shadow:inset 0 2px 0 0 var(--dsw-alias-state-business-primary,#4f7cf5)}
.wso-row[data-drop-marker="after"]{box-shadow:inset 0 -2px 0 0 var(--dsw-alias-state-business-primary,#4f7cf5)}
.wso-row[data-drop-marker="into"]{outline:2px dashed var(--dsw-alias-state-business-primary,#4f7cf5);outline-offset:-2px}
.wso-ws-row{min-height:28px}
.wso-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wso-count{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 4px;font-variant-numeric:tabular-nums}
.wso-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.wso-glyph[data-dim="true"]{opacity:.55}
.wso-chev{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto;padding:0;border:0;background:transparent;color:inherit;opacity:.5;cursor:pointer;transition:transform .12s ease}
.wso-chev[data-open="true"]{transform:rotate(90deg)}
.wso-actions-row{display:flex;align-items:center;gap:1px;flex:0 0 auto;margin-left:auto}
.wso-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;opacity:0;cursor:pointer}
.wso-row:hover .wso-icon-btn,.wso-icon-btn[data-open="true"]{opacity:.65}
.wso-icon-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
.wso-group{display:flex;flex-direction:column;gap:1px;margin:0 0 2px}
.wso-children{margin-left:14px;display:flex;flex-direction:column;gap:1px}
.wso-children[data-folder="true"]{margin-left:22px}
.wso-overflow{align-self:flex-start;margin:1px 0 2px 20px;border:0;background:transparent;color:inherit;opacity:.55;font:inherit;font-size:11.5px;padding:1px 4px;border-radius:4px;cursor:pointer}
.wso-overflow:hover{opacity:.9;background:var(--dsw-alias-interactive-bg-hover)}
.wso-empty-row{padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wso-time{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wso-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4f7cf5);flex:0 0 auto;animation:wso-pulse 1.1s ease-in-out infinite}
@keyframes wso-pulse{0%,100%{opacity:.25}50%{opacity:.85}}
.wso-menu-wrap{display:inline-flex}
/* ---- 文件夹成本（估算值；缺失时明确标注，不参与排序） ---- */
.wso-cost{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:0 4px;font-variant-numeric:tabular-nums;white-space:nowrap}
.wso-cost[data-empty="true"]{color:var(--dsw-alias-label-tertiary);opacity:.7}
.wso-cost[data-missing="true"]{color:var(--dsw-alias-state-warning-primary,#f5a623)}
.wso-cost-inline{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wso-cost-missing{flex:0 0 auto;font-size:10px;padding:0 3px;border-radius:3px;color:var(--dsw-alias-state-warning-primary,#f5a623);background:rgba(245,166,35,.14)}
.wso-cost-hint{margin:0 8px 4px;padding:2px 6px;border-radius:5px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}
.wso-cost-card{gap:4px;min-width:200px}
.wso-cost-total{display:flex;align-items:baseline;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wso-cost-total-value{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.wso-cost-lines{display:flex;flex-direction:column;gap:1px;max-height:220px;overflow-y:auto;border-top:1px solid var(--dsw-alias-interactive-bg-hover);padding-top:3px}
.wso-cost-line{display:flex;align-items:baseline;gap:8px;justify-content:space-between;font-size:11px}
.wso-cost-line[data-missing="true"]{color:var(--dsw-alias-label-tertiary)}
.wso-cost-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wso-cost-value{flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.wso-cost-line[data-missing="true"] .wso-cost-value{color:var(--dsw-alias-state-warning-primary,#f5a623)}
.wso-cost-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.wso-cost-warn{font-size:10.5px;color:var(--dsw-alias-state-warning-primary,#f5a623)}
.wso-cost-note{font-size:10px;color:var(--dsw-alias-label-tertiary);opacity:.85}
/* ---- 工作区行总花费（含未收纳会话；不可用时整列隐藏） ---- */
.wso-ws-cost{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:0 4px;font-variant-numeric:tabular-nums;white-space:nowrap}
.wso-ws-cost[data-missing="true"]{color:var(--dsw-alias-state-warning-primary,#f5a623)}
/* ---- 底栏：当前会话花费徽章（与官方 StatsPills 同款字号/行高，前置一碗饭线稿图标） ---- */
.wso-dock-cost{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;height:20px;padding:1px 8px;border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;cursor:default}
.wso-dock-cost svg{flex:none;width:16px;height:16px;display:block}
.wso-dock-cost[data-subagent="true"]{opacity:.75}
.wso-hover{display:flex;flex-direction:column;gap:2px;max-width:320px}
.wso-hover-title{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wso-hover-path{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.wso-rail{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 0}
.wso-rail-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:inherit;opacity:.65;cursor:pointer}
.wso-rail-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
`;
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin="' + PLUGIN + '"]') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = PLUGIN;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		// #endregion

		// #region 模块级状态
		let hostCtx = null;
		let connection = null;
		/** apply 时装配的导航器；对话框（独立 overlay 座位）也用它。 */
		let moduleNavigator = null;

		/** 极简发布订阅：对话框/Toast 的共享状态。 */
		const ui = {
			state: { dialog: null, toast: null },
			listeners: new Set(),
			set(patch) {
				ui.state = { ...ui.state, ...patch };
				for (const listener of [...ui.listeners]) {
					try {
						listener();
					} catch {
						/* 单个订阅者渲染失败不影响其余 */
					}
				}
			},
			subscribe(listener) {
				ui.listeners.add(listener);
				return () => ui.listeners.delete(listener);
			}
		};

		function showToast(text, tone = 'success') {
			ui.set({ toast: { id: `${Date.now()}-${Math.random()}`, text: String(text ?? ''), tone } });
		}

		/** RPC 调用：统一解包 host 的 { ok, value | error }。 */
		async function rpc(endpoint, payload) {
			if (connection === null) {
				try {
					connection = hostCtx?.connection ?? null;
				} catch {
					connection = null;
				}
			}
			if (connection === null || typeof connection.rpc?.call !== 'function') {
				throw Object.assign(new Error('Host 连接不可用，请刷新页面后重试'), { code: 'no-connection' });
			}
			const response = await connection.rpc.call(CHANNEL, endpoint, payload ?? {});
			if (response === null || typeof response !== 'object') throw new Error('Host 返回了无效响应');
			if (response.ok !== true) {
				const error = new Error(response.error?.message ?? '操作失败');
				error.code = response.error?.code ?? 'internal-error';
				throw error;
			}
			return response.value;
		}

		function errorText(error) {
			return String(error?.message ?? error ?? '未知错误');
		}

		/** 操作完成后刷新侧边栏快照。 */
		async function refreshSidebar() {
			try {
				await hostCtx?.sessions?.refresh?.();
			} catch {
				/* 忽略：刷新失败时用户可手动刷新页面 */
			}
			try {
				await hostCtx?.get?.('workspaces')?.refresh?.();
			} catch {
				/* 同上 */
			}
		}

		/** 会话被删除后：若主面板正开着它，先清空主面板再刷新。 */
		async function afterSessionRemoved(sessionId) {
			try {
				const ws = hostCtx?.get?.('uiWorkspace');
				const current = ws?.selection?.getSnapshot?.()?.sessionId;
				if (current !== undefined && current === sessionId) ws?.clearMain?.();
			} catch {
				/* 视图层 API 缺失时交给宿主自己处理 */
			}
			await refreshSidebar();
		}
		// #endregion

		// #region 视图状态（私有 store，不信任合成 props.useStore）
		const VIEW_KEY = 'dsh.workspace-organizer.view.v1';
		const VIEW_DEFAULTS = {
			version: 1,
			mode: 'tree', // tree=接管渲染；native=交还官方浏览器
			view: 'tree', // tree=工作区分组；list=单列表
			expanded: {},
			visible: {},
			foldersExpanded: {},
			archivedFilter: 'default'
		};
		const ARCHIVED_FILTERS = ['default', 'show', 'only'];
		const SESSION_STEP = 10;
		const SESSION_DEFAULT = 5;

		function sanitizeView(raw) {
			const merged = Object.assign({}, VIEW_DEFAULTS, raw || {});
			return {
				version: 1,
				mode: merged.mode === 'native' ? 'native' : 'tree',
				view: merged.view === 'list' ? 'list' : 'tree',
				expanded: merged.expanded && typeof merged.expanded === 'object' ? Object.assign({}, merged.expanded) : {},
				visible: merged.visible && typeof merged.visible === 'object' ? Object.assign({}, merged.visible) : {},
				foldersExpanded: merged.foldersExpanded && typeof merged.foldersExpanded === 'object' ? Object.assign({}, merged.foldersExpanded) : {},
				archivedFilter: ARCHIVED_FILTERS.indexOf(merged.archivedFilter) === -1 ? 'default' : merged.archivedFilter
			};
		}

		function readView() {
			try {
				const raw = window.localStorage.getItem(VIEW_KEY);
				return sanitizeView(raw === null ? null : JSON.parse(raw));
			} catch (error) {
				console.warn('[workspace-organizer] 读取视图状态失败，使用默认值', error);
				return sanitizeView(null);
			}
		}

		let viewState = readView();
		const viewListeners = new Set();

		function getViewState() {
			return viewState;
		}

		function updateView(patch) {
			const next = typeof patch === 'function' ? patch(viewState) : patch;
			viewState = Object.assign({}, viewState, next);
			try {
				window.localStorage.setItem(VIEW_KEY, JSON.stringify(viewState));
			} catch (error) {
				console.warn('[workspace-organizer] 保存视图状态失败', error);
			}
			for (const listener of Array.from(viewListeners)) {
				try {
					listener();
				} catch (error) {
					console.error('[workspace-organizer] 视图状态订阅者失败', error);
				}
			}
		}

		function subscribeView(listener) {
			viewListeners.add(listener);
			return () => {
				viewListeners.delete(listener);
			};
		}

		function useViewState() {
			return React.useSyncExternalStore(subscribeView, getViewState, getViewState);
		}

		/** 订阅一个 snapshot store。 */
		function useStoreSnapshot(store) {
			const subscribe = React.useCallback((listener) => store.subscribe(listener), [store]);
			const getSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
			return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		// ---- 文件夹状态（来自 Host sidecar，模块级缓存 + 订阅） ----
		const EMPTY_FOLDERS = Object.freeze({ folders: [], memberships: [], orders: {} });
		let foldersState = EMPTY_FOLDERS;
		const foldersListeners = new Set();

		function getFoldersState() {
			return foldersState;
		}

		function setFoldersState(next) {
			foldersState = next === null || typeof next !== 'object' ? EMPTY_FOLDERS : {
				folders: Array.isArray(next.folders) ? next.folders : [],
				memberships: Array.isArray(next.memberships) ? next.memberships : [],
				orders: next.orders && typeof next.orders === 'object' ? next.orders : {}
			};
			for (const listener of Array.from(foldersListeners)) {
				try {
					listener();
				} catch (error) {
					console.error('[workspace-organizer] 文件夹订阅者失败', error);
				}
			}
		}

		function subscribeFolders(listener) {
			foldersListeners.add(listener);
			return () => {
				foldersListeners.delete(listener);
			};
		}

		function useFoldersState() {
			return React.useSyncExternalStore(subscribeFolders, getFoldersState, getFoldersState);
		}

		/** 从 Host 拉一次文件夹状态；失败就回退「全部未收纳」，不白屏。 */
		async function reloadFolders() {
			try {
				const state = await rpc('organizer.folders.state', {});
				setFoldersState(state);
				return state;
			} catch (error) {
				console.warn('[workspace-organizer] 文件夹状态加载失败，按全部未收纳渲染', error);
				setFoldersState(EMPTY_FOLDERS);
				return EMPTY_FOLDERS;
			}
		}

		// ---- 成本（Host 增量算好的快照；失败只是没有成本列/没有徽章） ----
		//
		// 一份快照同时服务三处展示：文件夹小计（folders）、工作区总计
		// （workspaces）、底栏当前会话（sessions）。三者都由 Host 侧统一维护的
		// **会话级 cost 缓存**派生，客户端不再做任何金额加总。
		const EMPTY_COSTS = Object.freeze({
			phase: 'idle',
			available: false,
			source: null,
			reason: null,
			estimated: true,
			folders: {},
			workspaces: {},
			sessions: {}
		});
		let costsState = EMPTY_COSTS;
		const costsListeners = new Set();
		let costsRequest = null;
		let costsPendingSessions = new Set();
		let costsDebounceTimer = null;
		const COSTS_DEBOUNCE_MS = 1200;

		function getCostsState() {
			return costsState;
		}

		function setCostsState(next) {
			costsState =
				next === null || typeof next !== 'object'
					? EMPTY_COSTS
					: {
							phase: next.phase || 'ready',
							available: next.available === true,
							source: next.source || null,
							label: next.label || null,
							reason: next.reason || null,
							estimated: next.estimated !== false,
							folders: next.folders && typeof next.folders === 'object' ? next.folders : {},
							workspaces: next.workspaces && typeof next.workspaces === 'object' ? next.workspaces : {},
							sessions: next.sessions && typeof next.sessions === 'object' ? next.sessions : {}
						};
			for (const listener of Array.from(costsListeners)) {
				try {
					listener();
				} catch (error) {
					console.error('[workspace-organizer] 成本订阅者失败', error);
				}
			}
		}

		function subscribeCosts(listener) {
			costsListeners.add(listener);
			return () => {
				costsListeners.delete(listener);
			};
		}

		function useCostsState() {
			return React.useSyncExternalStore(subscribeCosts, getCostsState, getCostsState);
		}

		/**
		 * 拉一次成本快照。
		 *
		 * Host 侧只对**会话日志水位变过**的会话重取成本，所以这里可以放心在
		 * 文件夹/会话变化时刷新。并发调用合并：后到的会话 ID 会补进下一次
		 * 请求，不会因为「前一次还在飞」而丢掉底栏当前会话。
		 *
		 * @param {string[]} [sessionIds] 需要额外确保有成本缓存的会话（底栏当前会话）
		 */
		async function reloadCosts(sessionIds) {
			for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
				if (typeof sessionId === 'string' && sessionId !== '') costsPendingSessions.add(sessionId);
			}
			if (costsRequest !== null) {
				// 已有请求在飞：等它落地后，若期间又攒了新的会话（切换会话等），
				// 再补一次；否则这些 sessionId 会滞留到下一次刷新。
				await costsRequest;
				if (costsPendingSessions.size > 0) return await reloadCosts();
				return null;
			}
			const run = (async () => {
				let last = null;
				for (;;) {
					const focused = [...costsPendingSessions];
					costsPendingSessions = new Set();
					try {
						const snapshot = await rpc(
							'organizer.cost.snapshot',
							focused.length === 0 ? {} : { sessionIds: focused }
						);
						last = snapshot;
						setCostsState(Object.assign({ phase: 'ready' }, snapshot));
					} catch (error) {
						console.warn('[workspace-organizer] 成本快照加载失败，成本列按不可用处理', error);
						setCostsState({ phase: 'error', available: false, reason: describe(error), folders: {} });
						return null;
					}
					// 期间又来了新的会话（切换会话等）：再补一次，仍然只有 1 个 RPC。
					if (costsPendingSessions.size === 0) return last;
				}
			})().finally(() => {
				costsRequest = null;
			});
			costsRequest = run;
			return await run;
		}

		/**
		 * 统一的一次性刷新调度（树与底栏共用，全插件只有一个定时器）。
		 *
		 * 会话高频事件、收纳变化都会落到这里；1.2s 内合并成一次快照请求。
		 * 绝不新增轮询定时器：Host 侧的 2s 合并 + 60s 兜底已有水位检查。
		 */
		function scheduleCostsRefresh(sessionIds) {
			for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
				if (typeof sessionId === 'string' && sessionId !== '') costsPendingSessions.add(sessionId);
			}
			if (costsDebounceTimer !== null) clearTimeout(costsDebounceTimer);
			costsDebounceTimer = setTimeout(() => {
				costsDebounceTimer = null;
				void reloadCosts();
			}, COSTS_DEBOUNCE_MS);
		}
		// #endregion

		// #region 工具
		function cls() {
			let out = '';
			for (const value of arguments) {
				if (typeof value === 'string' && value !== '') out = out === '' ? value : out + ' ' + value;
			}
			return out;
		}

		function timeOf(value) {
			if (typeof value === 'number' && Number.isFinite(value)) return value;
			const parsed = Date.parse(typeof value === 'string' ? value : '');
			return Number.isNaN(parsed) ? 0 : parsed;
		}

		function describe(reason) {
			return reason instanceof Error ? reason.message : String(reason);
		}

		function cap(name) {
			return 'use' + name.charAt(0).toUpperCase() + name.slice(1);
		}

		function nowMs() {
			return Date.now();
		}

		function timeLabel(updatedAt) {
			if (updatedAt === undefined || updatedAt === null) return '';
			try {
				const { unit, n } = relativeTime(updatedAt, nowMs());
				const zh = { second: '秒', minute: '分', hour: '小时', day: '天', week: '周', month: '月', year: '年' };
				if (zh[unit] === undefined) return '';
				return `${n}${zh[unit]}`;
			} catch {
				return '';
			}
		}

		function workspaceTitleOf(workspace) {
			return workspace?.title || workspace?.path || workspace?.workspaceId || '';
		}

		/**
		 * 成本显示：`¥12.48` / `<¥0.01` / `—`。
		 *
		 * 这里只是**估算值**（价目表 + 峰谷来自外部账单插件），不是平台账单。
		 */
		function costLabel(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
			if (value <= 0) return '¥0.00';
			if (value < 0.005) return '<¥0.01';
			if (value >= 10000) return '¥' + (value / 1000).toFixed(1) + 'k';
			return '¥' + value.toFixed(2);
		}

		/**
		 * 文件夹/工作区行上的成本角标。
		 *
		 * 统一降级规则（用户要求）：**没有可展示的正数金额就不渲染任何东西**——
		 * 空容器、全部会话未计价、数据源不可用都返回 undefined，
		 * 绝不显示 ¥0.00 或 “—” 之类的占位符。
		 */
		function costBadgeOf(view) {
			if (view === undefined || view === null || typeof view !== 'object') return undefined;
			const count = view.sessionCount ?? 0;
			if (count <= 0) return undefined;
			const missing = view.missingCount ?? 0;
			if (count - missing <= 0) return undefined;
			const total = typeof view.totalCost === 'number' && Number.isFinite(view.totalCost) ? view.totalCost : 0;
			if (!(total > 0)) return undefined;
			return { text: costLabel(total), missing: missing > 0, empty: false };
		}

		/** 会话行上的“未计价”角标（成本缺失时才有）。 */
		function sessionCostOf(view, sessionId) {
			if (view === undefined || view === null || !Array.isArray(view.sessions)) return undefined;
			return view.sessions.find((item) => item.sessionId === sessionId);
		}

		/**
		 * 底栏徽章：只读统一会话级缓存。
		 * 返回 undefined 表示「不渲染」——没有数据源、该会话无记录、金额非正数都是这种情况。
		 */
		function sessionCostBadge(costs, sessionId) {
			if (costs === undefined || costs === null || costs.available !== true) return undefined;
			if (typeof sessionId !== 'string' || sessionId === '') return undefined;
			const sessions = costs.sessions && typeof costs.sessions === 'object' ? costs.sessions : {};
			const view = sessions[sessionId];
			if (view === undefined || view === null || view.missing === true) return undefined;
			const cost = view.cost;
			if (typeof cost !== 'number' || !Number.isFinite(cost) || !(cost > 0)) return undefined;
			return { cost, subagent: view.subagent === true };
		}

		/** token 总量的紧凑写法（明细卡里用）。 */
		function formatTokens(value) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
			if (value >= 1e8) return (value / 1e8).toFixed(2) + '亿';
			if (value >= 1e4) return (value / 1e4).toFixed(1) + '万';
			return String(Math.round(value));
		}

		/** 会话是否为普通行（子代理、非当前的空白会话都不进树）。 */
		function sessionVisible(summary, currentId, archivedSet, archivedFilter) {
			if (summary.origin === 'subagent') return false;
			if (summary.blank === true && summary.id !== currentId) return false;
			const isArchived = archivedSet.has(summary.id);
			if (archivedFilter === 'default') return !isArchived;
			if (archivedFilter === 'only') return isArchived;
			return true;
		}

		/** 置顶行在前、空白占位最前（官方同一分区语义）。 */
		function sectionMembers(members, pinnedSet, archivedSet) {
			const placeholders = [];
			const leading = [];
			const rest = [];
			for (const member of members) {
				if (member.blank === true) placeholders.push(member);
				else if (!archivedSet.has(member.id) && pinnedSet.has(member.id)) leading.push(member);
				else rest.push(member);
			}
			return placeholders.concat(leading, rest);
		}

		function matchesQuery(summary, needle) {
			if (needle === '') return true;
			const text = [summary.title, summary.displayTitle, summary.cwd, summary.id]
				.filter((value) => typeof value === 'string')
				.join('\u0000')
				.toLowerCase();
			return text.includes(needle);
		}

		function matchesWorkspace(workspace, needle) {
			if (needle === '') return true;
			const text = [workspace.title, workspace.path, workspace.workspaceId]
				.filter((value) => typeof value === 'string')
				.join('\u0000')
				.toLowerCase();
			return text.includes(needle);
		}

		/** 当前主视图打开的会话（快照里 retainedBy.mainView > 0）。 */
		function currentMainSessionId(sessionSnapshot) {
			for (const id of sessionSnapshot.ids || []) {
				const summary = (sessionSnapshot.byId || {})[id];
				if (summary !== undefined && (summary.retainedBy || {}).mainView > 0) return id;
			}
			return undefined;
		}
		// #endregion

		// #region 从 ledger 读回官方行座位
		/**
		 * 读一个座位名的存活条目（list 槽位按 order 排序）。
		 *
		 * 返回 { id, component, face, locale, slotHooks }：
		 *  - face = entry.inject() 的结果（可选链，抛错就当没有）
		 *  - slotHooks = 槽位声明级 inject.hooks（menu.item 的 menuOpenState /
		 *    shortcuts 走这一层）
		 * 任何一步失败都只丢掉这一条座位，不抛。
		 */
		function seatEntriesReader(ctx, name) {
			try {
				const slots = ctx?.slots;
				if (slots === undefined || slots === null) return [];
				const entries =
					typeof slots.entriesOfSlot === 'function' ? slots.entriesOfSlot(name) : typeof slots.entries === 'function' ? slots.entries(name) : [];
				const spec = typeof slots.specDynamic === 'function' ? slots.specDynamic(name) : typeof slots.spec === 'function' ? slots.spec(name) : undefined;
				const slotHooks = spec && spec.inject && spec.inject.hooks && typeof spec.inject.hooks === 'object' ? spec.inject.hooks : {};
				const out = [];
				for (const entry of entries || []) {
					if (entry === null || entry === undefined || entry.component === undefined) continue;
					let face = {};
					if (typeof entry.inject === 'function') {
						try {
							face = entry.inject() || {};
						} catch (error) {
							console.warn(`[workspace-organizer] 座位 ${name} 的 inject 失败，跳过`, error);
							continue;
						}
					}
					out.push({
						id: entry.options && entry.options.id !== undefined ? entry.options.id : '',
						component: entry.component,
						face,
						locale: typeof entry.locale === 'string' ? entry.locale : null,
						slotHooks
					});
				}
				return out;
			} catch (error) {
				console.warn(`[workspace-organizer] 读取座位 ${name} 失败`, error);
				return [];
			}
		}

		/** source → 稳定的 selector hook（复刻渲染器的 observableHook）。 */
		const sourceHookCache = new WeakMap();

		function makeSelectorHook(source) {
			return function useSourceSelector(selector) {
				const subscribe = React.useCallback((listener) => source.subscribe(listener), [source]);
				const getSnapshot = React.useCallback(() => source.getSnapshot(), [source]);
				const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
				if (typeof selector !== 'function') return snapshot;
				try {
					return selector(snapshot);
				} catch (error) {
					console.error('[workspace-organizer] 座位 selector 失败', error);
					return undefined;
				}
			};
		}

		function bindSourceHook(source) {
			if (source === null || source === undefined) return () => undefined;
			if (typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return () => undefined;
			let hook = sourceHookCache.get(source);
			if (hook === undefined) {
				hook = makeSelectorHook(source);
				sourceHookCache.set(source, hook);
			}
			return hook;
		}

		/**
		 * 渲染一条从 ledger 读回的座位。
		 *
		 * 复刻官方渲染协议的 props 拼装顺序：
		 *   kit(hooks) ← face ← 槽位级 hooks ← ownerProps
		 * 座位组件按 `use<Name>` 契约拿到 hook props。
		 */
		function SeatItem(props) {
			const { seat, ownerProps, hookContext, t } = props;
			const Comp = seat.component;
			if (typeof Comp !== 'function') return null;

			const hookProps = {};
			const faceHooks = seat.face && typeof seat.face.hooks === 'object' ? seat.face.hooks : null;
			if (faceHooks !== null) {
				for (const name of Object.keys(faceHooks)) {
					hookProps[cap(name)] = bindSourceHook(faceHooks[name]);
				}
			}
			const slotHooks = seat.slotHooks && typeof seat.slotHooks === 'object' ? seat.slotHooks : {};
			for (const name of Object.keys(slotHooks)) {
				const definition = slotHooks[name];
				if (typeof definition === 'function') {
					try {
						hookProps[cap(name)] = definition({}, hookContext);
					} catch (error) {
						console.warn('[workspace-organizer] 槽位 hook factory 失败', error);
					}
				} else {
					hookProps[cap(name)] = bindSourceHook(definition);
				}
			}
			const faceRest = {};
			if (seat.face && typeof seat.face === 'object') {
				for (const key of Object.keys(seat.face)) {
					if (key === 'hooks' || key === 'keyedHooks') continue;
					faceRest[key] = seat.face[key];
				}
			}
			const seatProps = Object.assign({}, hookProps, faceRest, t === undefined ? {} : { t }, ownerProps);
			return h(Comp, seatProps);
		}

		/** 一个座位的全部存活条目（按官方 list 顺序）。 */
		function SeatList(props) {
			const { seats, ownerProps, hookContext, t } = props;
			if (seats === undefined || seats === null || seats.length === 0) return null;
			return h(
				React.Fragment,
				null,
				seats.map((seat, index) =>
					h(SeatItem, { key: `${seat.id || 'seat'}:${index}`, seat, ownerProps, hookContext, t })
				)
			);
		}
		// #endregion

		// #region 底栏当前会话花费（conversation.composer.dock 的独立条目）
		const EMPTY_SESSION_SNAPSHOT = Object.freeze({ phase: 'idle', ids: [], byId: {} });
		const EMPTY_SESSION_STORE = Object.freeze({
			subscribe: () => () => {},
			getSnapshot: () => EMPTY_SESSION_SNAPSHOT
		});

		/**
		 * 一碗白饭（A 版线稿，16×16，与官方图标同一画法：
		 * fill:none + stroke:currentColor + strokeWidth 1）。
		 *
		 * 结构照 🍚：上面一团比碗口小的半圆米饭，下面一个梯形碗 + 横碗沿。
		 * 米饭的底边和碗沿故意不齐（米饭比碗口窄、弧线端点落在碗沿内侧），
		 * 这样两条线不会连成一个圆，16px 下也能看出「碗里盛着饭」。
		 *
		 * 图形铺满 viewBox（碗沿 x 2→14、碗底到 y 13.5），墨迹约 12×8 单位，
		 * 与官方图标（如 database 约 10.5×11）视觉大小相当；再小就会被看成偏小。
		 */
		function CostBowlIcon() {
			return h(
				'svg',
				{
					width: 16,
					height: 16,
					viewBox: '0 0 16 16',
					fill: 'none',
					xmlns: 'http://www.w3.org/2000/svg',
					'aria-hidden': 'true',
					strokeWidth: 1,
					stroke: 'currentColor',
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				},
				// 米饭：窄于碗口的半圆（直径 8.4，碗口 12）
				h('path', { d: 'M3.8 9.5A4.2 4.2 0 0 1 12.2 9.5' }),
				// 碗沿
				h('path', { d: 'M2 9.5H14' }),
				// 碗身：梯形 + 圆底
				h('path', { d: 'M2.4 9.5L4.9 12.85Q5.25 13.5 6 13.5H10Q10.75 13.5 11.1 12.85L13.6 9.5' })
			);
		}

		/**
		 * 底栏花费徽章：作为 conversation.composer.dock 的**独立条目**渲染。
		 *
		 * dock 是 flex 行（justify-content:center; gap:12px），官方 stats 条目
		 * order 0、本插件 order 10，于是顺序天然是
		 * 「StatsPills → 花费徽章 → ContextMeter（上下文占用）」。
		 *
		 * 这里**不影子**官方 stats cell、也不读回官方组件来重渲染：早先那套
		 * priority -1 影子方案依赖「注册顺序 + ledger 读回」两个时序前提，
		 * 任一不成立官方 stats 就整块消失（缓存命中/轮步统计全丢）。并列注册
		 * 让官方条目永远由官方渲染，本插件只负责自己的徽章。
		 *
		 * 数据直接读统一会话级缓存；没有记录就整块不渲染（绝不显示 ¥0.00）。
		 */
		function SessionCostBadge(props) {
			const costs = useCostsState();
			const sessionsService = safeGet(hostCtx, 'sessions');
			const candidate = sessionsService?.list;
			const store =
				candidate !== null && candidate !== undefined && typeof candidate.subscribe === 'function' && typeof candidate.getSnapshot === 'function'
					? candidate
					: EMPTY_SESSION_STORE;
			const sessionSnapshot = useStoreSnapshot(store);
			const sessionId =
				typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : currentMainSessionId(sessionSnapshot);
			React.useEffect(() => {
				if (typeof sessionId === 'string' && sessionId !== '') scheduleCostsRefresh([sessionId]);
				return undefined;
			}, [sessionId, sessionSnapshot]);
			const badge = sessionCostBadge(costs, sessionId);
			if (badge === undefined) return null;
			return h(
				'span',
				{
					className: 'wso-dock-cost',
					'data-subagent': badge.subagent === true ? 'true' : undefined,
					title: `当前会话花费 ${costLabel(badge.cost)}（估算值，非平台账单）`
				},
				h(CostBowlIcon),
				costLabel(badge.cost)
			);
		}
		// #endregion

		// #region AnimatedRows（复刻官方位移动画 + inert 退场克隆）
		const ROW_FADE_MS = 100;
		const ROW_GLIDE_MS = 200;

		function sameRows(previous, next) {
			return previous.rowKeys.length === next.rowKeys.length && previous.rowKeys.every((key, index) => key === next.rowKeys[index]);
		}

		function intersects(row, viewport) {
			return row.bottom > viewport.top && row.top < viewport.bottom && row.right > viewport.left && row.left < viewport.right;
		}

		class AnimatedRows extends React.Component {
			constructor(props) {
				super(props);
				this.armed = false;
				this.list = React.createRef();
				this.overlay = React.createRef();
				this.movements = new Map();
				this.exits = new Map();
			}

			getSnapshotBeforeUpdate(previous) {
				const list = this.list.current;
				if (
					!this.armed ||
					sameRows(previous, this.props) ||
					previous.resetKey !== this.props.resetKey ||
					!previous.ready ||
					!this.props.ready ||
					list === null ||
					typeof list.animate !== 'function' ||
					(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
				) {
					return null;
				}
				const viewport = list.getBoundingClientRect();
				const positions = this.readPositions();
				const nextKeys = new Set(this.props.rowKeys);
				const removed = new Map();
				for (const [key, row] of positions) {
					if (nextKeys.has(key) || !intersects(row.rect, viewport)) continue;
					const clone = row.element.cloneNode(true);
					clone.removeAttribute('data-row-key');
					// 退场克隆是 inert 的：焦点不能落进已经消失的行。
					clone.inert = true;
					clone.setAttribute('inert', '');
					clone.setAttribute('aria-hidden', 'true');
					removed.set(key, Object.assign({}, row, { element: clone }));
				}
				return { positions, removed };
			}

			componentDidUpdate(previous, _state, snapshot) {
				if (snapshot === null) {
					if (!sameRows(previous, this.props) || previous.resetKey !== this.props.resetKey || previous.ready !== this.props.ready) this.clear();
					return;
				}
				this.cancelMovements();
				const list = this.list.current;
				const overlay = this.overlay.current;
				if (list === null || overlay === null) return;
				const viewport = list.getBoundingClientRect();
				const origin = overlay.getBoundingClientRect();
				const positions = this.readPositions();
				for (const [key, row] of positions) {
					this.removeExit(key);
					const previousRow = snapshot.positions.get(key);
					if (!intersects(row.rect, viewport) && (previousRow === undefined || !intersects(previousRow.rect, viewport))) continue;
					if (previousRow === undefined) {
						this.move(row.element, [{ opacity: 0 }, { opacity: 1 }], ROW_FADE_MS);
						continue;
					}
					const dx = previousRow.rect.left - row.rect.left;
					const dy = previousRow.rect.top - row.rect.top;
					if (dx === 0 && dy === 0 && previousRow.opacity === 1) continue;
					this.move(
						row.element,
						[
							{ transform: `translate(${String(dx)}px, ${String(dy)}px)`, opacity: previousRow.opacity },
							{ transform: 'translate(0, 0)', opacity: 1 }
						],
						ROW_GLIDE_MS
					);
				}
				for (const [key, row] of snapshot.removed) {
					const element = row.element;
					this.removeExit(key);
					Object.assign(element.style, {
						position: 'absolute',
						margin: '0',
						transform: 'none',
						boxSizing: 'border-box',
						left: `${String(row.rect.left - origin.left)}px`,
						top: `${String(row.rect.top - origin.top)}px`,
						width: `${String(row.rect.width)}px`,
						height: `${String(row.rect.height)}px`
					});
					overlay.appendChild(element);
					const animation = element.animate([{ opacity: row.opacity }, { opacity: 0 }], {
						duration: ROW_FADE_MS,
						easing: 'ease-out',
						fill: 'forwards'
					});
					this.exits.set(key, { element, animation });
					animation.onfinish = () => {
						this.removeExit(key);
					};
				}
			}

			componentWillUnmount() {
				this.clear();
			}

			readPositions() {
				const list = this.list.current;
				if (list === null) return new Map();
				const rows = list.querySelectorAll('[data-row-key]');
				return new Map(
					Array.from(rows, (element) => [
						element.dataset.rowKey,
						{
							element,
							rect: element.getBoundingClientRect(),
							opacity: this.movements.has(element) ? Number(getComputedStyle(element).opacity) : 1
						}
					])
				);
			}

			move(element, keyframes, duration) {
				if (typeof element.animate !== 'function') return;
				const animation = element.animate(keyframes, { duration, easing: 'ease-out' });
				this.movements.set(element, animation);
				animation.onfinish = () => {
					this.movements.delete(element);
					animation.cancel();
				};
			}

			cancelMovements() {
				for (const animation of this.movements.values()) {
					animation.onfinish = null;
					animation.cancel();
				}
				this.movements.clear();
			}

			removeExit(key) {
				const exit = this.exits.get(key);
				if (exit === undefined) return;
				exit.animation.onfinish = null;
				exit.animation.cancel();
				exit.element.remove();
				this.exits.delete(key);
			}

			clear() {
				this.cancelMovements();
				for (const key of Array.from(this.exits.keys())) this.removeExit(key);
			}

			render() {
				return h(
					React.Fragment,
					null,
					h(
						'div',
						{
							ref: this.list,
							className: this.props.className,
							role: 'tree',
							'aria-label': this.props.label,
							onPointerDownCapture: () => {
								this.armed = true;
							},
							onKeyDownCapture: () => {
								this.armed = true;
							}
						},
						this.props.children
					),
					h('div', { ref: this.overlay, className: 'wso-exits', 'aria-hidden': 'true' })
				);
			}
		}
		// #endregion

		// #region 行组件
		/** 行内图标按钮（不抢行的点击）。 */
		function RowIconButton(props) {
			const button = h(
				'button',
				{
					type: 'button',
					className: 'wso-icon-btn',
					'aria-label': props.label,
					title: props.label,
					'data-open': props.open === true ? 'true' : undefined,
					onClick: (event) => {
						event.preventDefault();
						event.stopPropagation();
						props.onClick(event);
					},
					onMouseDown: (event) => event.stopPropagation()
				},
				props.children
			);
			if (P && typeof P.Tooltip === 'function') {
				return h(Tooltip, { label: props.label, side: 'bottom', align: 'end', delayMs: 400 }, button);
			}
			return button;
		}

		/**
		 * 会话行。
		 *
		 * data-row-key="session:<id>"，role=treeitem，aria-selected。
		 * 行内座位：leading（状态/日程）、row.action（归档/pin）、菜单
		 * （pin/rename/fork/archive + 本插件的删除/移到文件夹）。
		 */
		function SessionRow(props) {
			const {
				node,
				selected,
				busy,
				onOpen,
				onRename,
				seats,
				t,
				cost,
				drag
			} = props;
			const [menuOpen, setMenuOpen] = React.useState(false);
			const menuOpenState = React.useMemo(() => [menuOpen, setMenuOpen], [menuOpen]);
			const title = node.title === '' ? '新会话' : node.title;
			const ownerProps = { sessionId: node.id, displayTitle: node.title };

			const leadingSeats = seats.leading;
			const actionSeats = seats.action;
			const menuSeats = seats.menu;

			const row = h(
				'div',
				{
					'data-row-key': `session:${node.id}`,
					className: cls('wso-row', 'wso-session-row'),
					role: 'treeitem',
					'aria-selected': selected === true,
					'aria-label': title,
					'data-selected': selected === true ? 'true' : undefined,
					'data-archived': node.archived === true ? 'true' : undefined,
					title,
					tabIndex: 0,
					draggable: drag !== undefined && node.blank !== true && node.archived !== true,
					onDragStart:
						drag === undefined
							? undefined
							: (event) => {
									try {
										event.dataTransfer.effectAllowed = 'move';
										event.dataTransfer.setData('text/plain', node.id);
										event.dataTransfer.setData('application/x-wso-session', node.id);
									} catch {
										/* 拖拽载荷 best-effort */
									}
									drag.start(event);
								},
					onDragEnd: drag === undefined ? undefined : drag.end,
					onDragOver: drag === undefined ? undefined : drag.onDragOver,
					onDragLeave: drag === undefined ? undefined : drag.onDragLeave,
					onDrop: drag === undefined ? undefined : drag.onDrop,
					'data-drop-marker': drag === undefined ? undefined : drag.marker,
					onClick: () => onOpen(node.id),
					onDoubleClick: (event) => {
						if (node.blank === true || node.archived === true) return;
						event.stopPropagation();
						onRename(node.id, node.title);
					},
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							onOpen(node.id);
						}
					}
				},
				h(
					'span',
					{ className: 'wso-glyph', 'data-dim': 'true' },
					leadingSeats.length > 0 && node.archived !== true && node.blank !== true
						? h(SeatList, { seats: leadingSeats, ownerProps, t })
						: h(IconArchiveOutlineRegular, { size: 13, style: { opacity: node.archived === true ? 0.8 : 0.55 } })
				),
				h('span', { className: 'wso-label', style: node.blank === true ? { fontStyle: 'italic', opacity: 0.65 } : undefined }, title),
				// 成本缺失时不假装精确：这一行明确标“未计价”。
				cost !== undefined && cost.missing === true
					? h('span', { className: 'wso-cost-missing', title: '该会话查不到成本（未计价）' }, '未计价')
					: cost !== undefined && typeof cost.cost === 'number'
						? h('span', { className: 'wso-cost-inline', title: '估算花费（非平台账单）' }, costLabel(cost.cost))
						: null,
				node.running === true ? h('span', { className: 'wso-dot', title: '运行中' }) : null,
				node.pinned === true && node.archived !== true ? h('span', { className: 'wso-glyph', 'data-dim': 'true' }, h(IconPinFillRegular, { size: 11 })) : null,
				h('span', { className: 'wso-time' }, node.blank === true ? '' : timeLabel(node.updatedAt)),
				h(
					'span',
					{ className: 'wso-actions-row', onClick: (event) => event.stopPropagation() },
					actionSeats.length > 0 ? h(SeatList, { seats: actionSeats, ownerProps, t }) : null,
					h(
						'span',
						{ className: 'wso-menu-wrap' },
						h(
							Menu,
							{
								open: menuOpen,
								onClose: () => setMenuOpen(false),
								portal: true,
								closeOnPointerLeave: true,
								anchor: h(
									RowIconButton,
									{
										label: '会话操作',
										open: menuOpen,
										onClick: () => setMenuOpen((value) => !value)
									},
									h(IconEllipsisOutlineRegular, { size: 14 })
								)
							},
							h(SeatList, { seats: menuSeats, ownerProps, hookContext: menuOpenState, t })
						)
					)
				)
			);

			if (P && typeof P.HoverCard === 'function' && typeof props.renderHover === 'function') {
				return h(HoverCard, {
					anchor: row,
					content: props.renderHover(node, title),
					openDelayMs: 800,
					disabled: menuOpen || (drag !== undefined && drag.active === true),
					copyText: node.blank === true ? undefined : title
				});
			}
			return row;
		}

		/**
		 * 工作区行。
		 *
		 * data-row-key="workspace:<key>"，role=treeitem，aria-expanded。
		 * 菜单：重命名 / 删除；行内：新建会话（在此工作区）。
		 */
		function WorkspaceRow(props) {
			const { group, expanded, active, sessionCount, onToggle, onNewSession, onNewFolder, onRename, onDelete, drag, containsCurrentDescendant, cost, unassignedCount } = props;
			const [menuOpen, setMenuOpen] = React.useState(false);
			const label = group.workspaceId === undefined ? '未分组' : group.label;
			const isReal = group.workspaceId !== undefined;
			// 工作区总花费：含未收纳会话（数据来自统一会话级缓存），不可用/全缺失时整列隐藏。
			const badge = isReal ? costBadgeOf(cost) : undefined;
			const costDetail =
				badge === undefined
					? undefined
					: `包含 ${cost.sessionCount} 个会话，其中未收纳 ${typeof unassignedCount === 'number' ? unassignedCount : 0} 个` +
						((cost.missingCount ?? 0) > 0 ? `，${cost.missingCount} 个未计价` : '') +
						'（估算值，非平台账单）';
			const rowTitle = isReal && costDetail !== undefined ? `${group.cwd === undefined ? label : group.cwd}\n${costDetail}` : group.cwd === undefined ? label : group.cwd;
			const items = isReal
				? [
						{ id: 'new-folder', label: '新建文件夹', icon: h(IconFolderOpenRegular, { size: 14 }) },
						{ id: 'rename', label: '重命名工作区', icon: h(IconEditOutlineRegular, {}) },
						{ id: 'delete', label: '删除工作区', icon: h(IconTrashOutlineRegular, {}), danger: true }
					]
				: [];
			return h(
				'div',
				{
					'data-row-key': `workspace:${group.key}`,
					className: cls('wso-row', 'wso-ws-row'),
					role: 'treeitem',
					'aria-expanded': expanded === true,
					'aria-label': label,
					'data-active': active === true || containsCurrentDescendant === true ? 'true' : undefined,
					title: rowTitle,
					tabIndex: 0,
					draggable: isReal && drag !== undefined,
					onDragStart:
						drag === undefined || !isReal
							? undefined
							: (event) => {
									try {
										event.dataTransfer.effectAllowed = 'move';
										event.dataTransfer.setData('text/plain', group.key);
										event.dataTransfer.setData('application/x-wso-workspace', group.workspaceId);
									} catch {
										/* best-effort */
									}
									drag.start(event);
								},
					onDragEnd: drag === undefined ? undefined : drag.end,
					onDragOver: drag === undefined ? undefined : drag.onDragOver,
					onDragLeave: drag === undefined ? undefined : drag.onDragLeave,
					onDrop: drag === undefined ? undefined : drag.onDrop,
					'data-drop-marker': drag === undefined ? undefined : drag.marker,
					onClick: onToggle,
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							onToggle();
						}
					}
				},
				h(
					'span',
					{ className: 'wso-glyph' },
					isReal ? (expanded === true ? h(IconFolderOpenRegular, { size: 15 }) : h(IconFolderCloseRegular, { size: 15 })) : h(IconWorkspaceTreeOutlineRegular, { size: 14 })
				),
				h(
					'button',
					{
						type: 'button',
						className: 'wso-chev',
						'data-open': expanded === true ? 'true' : undefined,
						'aria-label': expanded === true ? '折叠' : '展开',
						onClick: (event) => {
							event.stopPropagation();
							onToggle();
						}
					},
					h(IconChevronRightOutlineRegular, { size: 11 })
				),
				h('span', { className: 'wso-label' }, label),
				h('span', { className: 'wso-count' }, String(sessionCount)),
				badge === undefined
					? null
					: h(
							'span',
							{
								className: 'wso-ws-cost',
								'data-missing': badge.missing === true ? 'true' : undefined,
								title: costDetail
							},
							badge.text,
							badge.missing === true ? '*' : ''
						),
				h(
					'span',
					{ className: 'wso-actions-row', onClick: (event) => event.stopPropagation() },
					isReal && typeof onNewSession === 'function'
						? h(
								RowIconButton,
								{ label: '在此工作区新建会话', onClick: onNewSession },
								h(IconNewChatOutlineRegular, { size: 14 })
							)
						: null,
					isReal && items.length > 0
						? h(
								Menu,
								{
									open: menuOpen,
									onClose: () => setMenuOpen(false),
									items,
									onSelect: (id) => {
										setMenuOpen(false);
										if (id === 'rename') onRename();
										else if (id === 'delete') onDelete();
										else if (id === 'new-folder' && typeof onNewFolder === 'function') onNewFolder();
									},
									portal: true,
									closeOnPointerLeave: true,
									anchor: h(
										RowIconButton,
										{
											label: '工作区操作',
											open: menuOpen,
											onClick: () => setMenuOpen((value) => !value)
										},
										h(IconEllipsisOutlineRegular, { size: 14 })
									)
								}
							)
						: null
				)
			);
		}
		// #endregion

		// #region 树（组件）
		/**
		 * 文件夹展开后的明细卡（悬停显示）。
		 *
		 * 逐会话成本 + 文件夹总计 + 「其中子代理」；任何缺失都写清楚，
		 * 并在末尾声明这是估算值（价目表来自外部账单插件，不是平台账单）。
		 */
		function renderFolderCostCard(folder, cost, titleOf) {
			const badge = costBadgeOf(cost);
			const sessions = Array.isArray(cost.sessions) ? cost.sessions : [];
			const priced = sessions.filter((item) => item.missing !== true);
			const missing = sessions.length - priced.length;
			const rows = sessions.map((item) => {
				const label = titleOf(item.sessionId) || item.sessionId;
				return h(
					'div',
					{ key: `cost:${item.sessionId}`, className: 'wso-cost-line', 'data-missing': item.missing === true ? 'true' : undefined },
					h('span', { className: 'wso-cost-name' }, item.subagent === true ? `⤷ ${label}` : label),
					h(
						'span',
						{ className: 'wso-cost-value' },
						item.missing === true ? '未计价' : costLabel(item.cost)
					)
				);
			});
			return h(
				'div',
				{ className: 'wso-hover wso-cost-card' },
				h('span', { className: 'wso-hover-title' }, `📁 ${folder.name}`),
				h(
					'div',
					{ className: 'wso-cost-total' },
					h('span', null, '文件夹总计'),
					h('span', { className: 'wso-cost-total-value' }, badge === undefined ? '—' : badge.text),
					badge !== undefined && badge.missing === true ? h('span', { className: 'wso-cost-warn' }, '部分数据缺失') : null
				),
				h('span', { className: 'wso-hover-path' }, `会话数 ${sessions.length}${cost.totalTokens > 0 ? ` · ${formatTokens(cost.totalTokens)} tokens` : ''}`),
				rows.length > 0 ? h('div', { className: 'wso-cost-lines' }, rows) : h('span', { className: 'wso-hover-path' }, '文件夹里还没有会话'),
				cost.subagentCost > 0 ? h('span', { className: 'wso-cost-sub' }, `其中子代理：${costLabel(cost.subagentCost)}`) : null,
				missing > 0
					? h('span', { className: 'wso-cost-warn' }, `部分数据缺失：${missing} 个会话未计价，总计不含它们`)
					: null,
				h('span', { className: 'wso-cost-note' }, '估算值（非平台账单）')
			);
		}

		/**
		 * 文件夹行。
		 *
		 * data-row-key="folder:<id>"，role=treeitem，aria-expanded。
		 * 文件夹是工作区内部的容器：展开时内部会话渲染为它的子级。
		 * 行尾显示该文件夹的**成本小计**（不参与 WorkspaceItemOrder 排序）。
		 */
		function FolderRow(props) {
			const { folder, expanded, sessionCount, onToggle, onNewSession, onRename, onDelete, onColor, drag, cost, titleOf } = props;
			const [menuOpen, setMenuOpen] = React.useState(false);
			const items = [
				{ id: 'new-session', label: '在此文件夹新建会话' },
				{ id: 'rename', label: '重命名文件夹', icon: h(IconEditOutlineRegular, {}) },
				{ id: 'color:reset', label: '颜色 · 默认' },
				{ id: 'color:#4f7cf5', label: '颜色 · 蓝色' },
				{ id: 'color:#2fb37a', label: '颜色 · 绿色' },
				{ id: 'color:#e5484d', label: '颜色 · 红色' },
				{ id: 'color:#f5a623', label: '颜色 · 橙色' },
				{ id: 'delete', label: '删除文件夹', icon: h(IconTrashOutlineRegular, {}), danger: true, separatorBefore: true }
			];
			const badge = costBadgeOf(cost);
			const row = h(
				'div',
				{
					'data-row-key': `folder:${folder.id}`,
					className: 'wso-row',
					role: 'treeitem',
					'aria-expanded': expanded === true,
					'aria-label': folder.name,
					title: folder.name,
					tabIndex: 0,
					draggable: drag !== undefined,
					onDragStart:
						drag === undefined
							? undefined
							: (event) => {
									try {
										event.dataTransfer.effectAllowed = 'move';
										event.dataTransfer.setData('text/plain', folder.id);
										event.dataTransfer.setData('application/x-wso-folder', folder.id);
									} catch {
										/* best-effort */
									}
									drag.start(event);
								},
					onDragEnd: drag === undefined ? undefined : drag.end,
					onDragOver: drag === undefined ? undefined : drag.onDragOver,
					onDragLeave: drag === undefined ? undefined : drag.onDragLeave,
					onDrop: drag === undefined ? undefined : drag.onDrop,
					'data-drop-marker': drag === undefined ? undefined : drag.marker,
					onClick: onToggle,
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							onToggle();
						}
					}
				},
				h(
					'span',
					{ className: 'wso-glyph', style: folder.color === undefined ? undefined : { color: folder.color } },
					expanded === true ? h(IconFolderOpenRegular, { size: 15 }) : h(IconFolderCloseRegular, { size: 15 })
				),
				h(
					'button',
					{
						type: 'button',
						className: 'wso-chev',
						'data-open': expanded === true ? 'true' : undefined,
						'aria-label': expanded === true ? '折叠文件夹' : '展开文件夹',
						onClick: (event) => {
							event.stopPropagation();
							onToggle();
						}
					},
					h(IconChevronRightOutlineRegular, { size: 11 })
				),
				h('span', { className: 'wso-label' }, folder.name),
				h('span', { className: 'wso-count' }, String(sessionCount)),
				badge === undefined
					? null
					: h(
							'span',
							{
								className: 'wso-cost',
								'data-missing': badge.missing === true ? 'true' : undefined,
								'data-empty': badge.empty === true ? 'true' : undefined,
								title:
									badge.empty === true
										? '空文件夹（无成本）'
										: badge.missing === true
											? '部分数据缺失：有会话未计价'
											: '估算花费（悬停看逐会话明细）'
							},
							badge.text,
							badge.missing === true ? '*' : ''
						),
				h(
					'span',
					{ className: 'wso-actions-row', onClick: (event) => event.stopPropagation() },
					typeof onNewSession === 'function'
						? h(
								RowIconButton,
								{ label: '在此文件夹新建会话', onClick: onNewSession },
								h(IconNewChatOutlineRegular, { size: 14 })
							)
						: null,
					h(
						Menu,
						{
							open: menuOpen,
							onClose: () => setMenuOpen(false),
							items,
							onSelect: (id) => {
								setMenuOpen(false);
								if (id === 'rename') onRename();
								else if (id === 'delete') onDelete();
								else if (id === 'new-session' && typeof onNewSession === 'function') onNewSession();
								else if (id.startsWith('color:')) onColor(id.slice(6) === 'reset' ? '' : id.slice(6));
							},
							portal: true,
							closeOnPointerLeave: true,
							anchor: h(
								RowIconButton,
								{
									label: '文件夹操作',
									open: menuOpen,
									onClick: () => setMenuOpen((value) => !value)
								},
								h(IconEllipsisOutlineRegular, { size: 14 })
							)
						}
					)
				)
			);
			// 悬停明细卡：成本不可用/空文件夹时不给（避免空壳）。
			if (P && typeof P.HoverCard === 'function' && cost !== undefined && badge !== undefined && badge.empty !== true) {
				return h(HoverCard, {
					anchor: row,
					content: renderFolderCostCard(folder, cost, typeof titleOf === 'function' ? titleOf : () => ''),
					openDelayMs: 500,
					disabled: menuOpen || (drag !== undefined && drag.active === true)
				});
			}
			return row;
		}
		// #endregion
		function renderHoverContent(node, title, seats, t) {
			return h(
				'div',
				{ className: 'wso-hover' },
				h('span', { className: 'wso-hover-title' }, title || '新会话'),
				node.cwd === undefined ? null : h('span', { className: 'wso-hover-path' }, node.cwd),
				seats.hover.length > 0
					? h(SeatList, { seats: seats.hover, ownerProps: { sessionId: node.id, displayTitle: node.title }, t })
					: null
			);
		}

		function WorkspaceTreeBody(props) {
			const {
				workspacesSnapshot,
				sessionSnapshot,
				view,
				needle,
				archivedFilter,
				seats,
				t,
				nav,
				onRenameSession,
				dragApi,
				folderState,
				folderActions,
				costs
			} = props;
			const currentId = currentMainSessionId(sessionSnapshot);
			const archivedSet = new Set(workspacesSnapshot.archivedSessionIds || []);
			const pinnedSet = new Set(workspacesSnapshot.pinnedSessionIds || []);
			const rowKeys = [];
			const workspaceSessionIds = new Set();
			const folderById = new Map((folderState.folders || []).map((folder) => [folder.id, folder]));
			const membershipOf = new Map((folderState.memberships || []).map((membership) => [membership.sessionId, membership.folderId]));
			const orderInFolderOf = new Map((folderState.memberships || []).map((membership) => [membership.sessionId, membership.orderInFolder]));
			// 成本快照：不可用时整列隐藏，绝不阻断树本身。
			const costFolders = costs !== undefined && costs !== null && costs.available === true ? costs.folders || {} : {};
			const costOfFolder = (folderId) => (costFolders[folderId] === undefined ? undefined : costFolders[folderId]);
			// 工作区总花费（含未收纳）：与文件夹小计共用 Host 侧同一份会话级缓存。
			const costWorkspaces = costs !== undefined && costs !== null && costs.available === true ? costs.workspaces || {} : {};
			const costOfWorkspace = (workspaceId) =>
				workspaceId === undefined || workspaceId === null ? undefined : costWorkspaces[workspaceId];
			/** 明细卡里的会话标签：优先用树里已知的标题，子代理会话退回 ID。 */
			const sessionTitleOf = (sessionId) => {
				const summary = (sessionSnapshot.byId || {})[sessionId];
				const title = summary === undefined ? '' : summary.title || '';
				return title === '' ? '' : title;
			};

			const groups = [];
			for (const workspace of workspacesSnapshot.items || []) {
				for (const id of workspace.sessionIds || []) workspaceSessionIds.add(id);
				const members = [];
				for (const id of workspace.sessionIds || []) {
					const summary = (sessionSnapshot.byId || {})[id];
					if (summary === undefined) continue;
					if (!sessionVisible(summary, currentId, archivedSet, archivedFilter)) continue;
					if (!matchesQuery(summary, needle)) continue;
					members.push(summary);
				}
				const workspaceMatches =
					matchesWorkspace(workspace, needle) ||
					(folderState.folders || []).some(
						(folder) =>
							folder.workspaceId === workspace.workspaceId &&
							typeof folder.name === 'string' &&
							folder.name.toLowerCase().includes(needle)
					);
				if (archivedFilter === 'only' && members.length === 0) continue;
				if (needle !== '' && !workspaceMatches && members.length === 0) continue;
				groups.push({
					key: workspace.workspaceId,
					workspaceId: workspace.workspaceId,
					cwd: workspace.path,
					label: workspaceTitleOf(workspace),
					rawTitle: workspace.title,
					sessionIds: workspace.sessionIds || [],
					members
				});
			}

			const stray = [];
			for (const id of sessionSnapshot.ids || []) {
				if (workspaceSessionIds.has(id)) continue;
				const summary = (sessionSnapshot.byId || {})[id];
				if (summary === undefined) continue;
				if (!sessionVisible(summary, currentId, archivedSet, archivedFilter)) continue;
				if (!matchesQuery(summary, needle)) continue;
				stray.push(summary);
			}
			if (stray.length > 0) {
				groups.push({ key: '', workspaceId: undefined, cwd: undefined, label: '', rawTitle: '', sessionIds: [], members: stray });
			}

			const renderSession = (summary, folderId, workspaceId) => {
				const node = {
					id: summary.id,
					title: summary.blank === true ? '' : summary.title || '',
					blank: summary.blank === true,
					archived: archivedSet.has(summary.id),
					pinned: pinnedSet.has(summary.id),
					running: summary.running === true,
					cwd: summary.cwd,
					updatedAt: summary.updatedAt
				};
				rowKeys.push(`session:${node.id}`);
				// 只有收进文件夹的会话才有成本语境；未收纳会话不显示任何文件夹级汇总。
				const sessionCost = folderId === undefined ? undefined : sessionCostOf(costOfFolder(folderId), node.id);
				return h(SessionRow, {
					key: `session:${node.id}`,
					node,
					selected: node.id === currentId,
					busy: props.busySessionId === node.id,
					onOpen: nav.openSession,
					onRename: onRenameSession,
					seats,
					t,
					cost: sessionCost,
					renderHover: (rowNode, title) => renderHoverContent(rowNode, title, seats, t),
					drag: dragApi ? dragApi.session(node, folderId === undefined ? null : folderId, workspaceId) : undefined
				});
			};

			const renderGroup = (group) => {
				// 搜索时自动展开命中的工作区，让匹配的会话行直接可见。
				const expanded = needle !== '' ? true : view.expanded[group.key] === true;
				const limit = view.visible[group.key] === undefined ? SESSION_DEFAULT : view.visible[group.key];
				rowKeys.push(`workspace:${group.key}`);
				const active =
					currentId !== undefined && group.sessionIds !== undefined && (group.sessionIds || []).includes(currentId);
				const workspaceCost = costOfWorkspace(group.workspaceId);
				// 「未收纳」= 工作区记账里有、但没进任何文件夹的会话（用成本视图的完整成员名册算）。
				const unassignedCount =
					workspaceCost === undefined || !Array.isArray(workspaceCost.sessionIds)
						? 0
						: workspaceCost.sessionIds.filter((sessionId) => !membershipOf.has(sessionId)).length;
				const children = [];

				if (expanded) {
					const folders = (folderState.folders || [])
						.filter((folder) => folder.workspaceId === group.workspaceId)
						.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
					const membersByFolder = new Map();
					for (const summary of group.members) {
						const folderId = membershipOf.get(summary.id);
						if (folderId === undefined) continue;
						if (!membersByFolder.has(folderId)) membersByFolder.set(folderId, []);
						membersByFolder.get(folderId).push(summary);
					}
					for (const list of membersByFolder.values()) {
						list.sort((left, right) => (orderInFolderOf.get(left.id) ?? 0) - (orderInFolderOf.get(right.id) ?? 0));
					}

					// 交错顺序：WorkspaceItemOrder 里出现过的先排，再补缺失的未收纳会话与文件夹。
					const declaredOrder = Array.isArray(folderState.orders[group.workspaceId])
						? folderState.orders[group.workspaceId]
						: [];
					const items = [];
					const seenSessions = new Set();
					const seenFolders = new Set();
					const memberSummary = new Map(group.members.map((summary) => [summary.id, summary]));
					for (const item of declaredOrder) {
						if (item === null || typeof item !== 'object') continue;
						if (item.type === 'folder') {
							const folder = folderById.get(item.id);
							if (folder === undefined || folder.workspaceId !== group.workspaceId || seenFolders.has(folder.id)) continue;
							seenFolders.add(folder.id);
							items.push({ type: 'folder', folder });
						} else if (item.type === 'session') {
							if (membershipOf.has(item.id) || seenSessions.has(item.id)) continue;
							const summary = memberSummary.get(item.id);
							if (summary === undefined) continue;
							seenSessions.add(item.id);
							items.push({ type: 'session', summary });
						}
					}
					// 未收纳会话的自然顺序：置顶在前（官方行语义），其余按工作区会话顺序。
					const unassignedNatural = sectionMembers(
						group.members.filter((summary) => !membershipOf.has(summary.id)),
						pinnedSet,
						archivedSet
					);
					for (const summary of unassignedNatural) {
						if (seenSessions.has(summary.id)) continue;
						seenSessions.add(summary.id);
						items.push({ type: 'session', summary });
					}
					for (const folder of folders) {
						if (seenFolders.has(folder.id)) continue;
						seenFolders.add(folder.id);
						items.push({ type: 'folder', folder });
					}

					let shownUnassigned = 0;
					let hiddenCount = 0;
					for (const item of items) {
						if (item.type === 'session') {
							if (shownUnassigned >= limit) {
								hiddenCount += 1;
								continue;
							}
							shownUnassigned += 1;
							children.push(renderSession(item.summary, null, group.workspaceId));
							continue;
						}
						const folder = item.folder;
						const folderExpanded = needle !== '' ? true : view.foldersExpanded[folder.id] === true;
						const folderMembers = membersByFolder.get(folder.id) || [];
						rowKeys.push(`folder:${folder.id}`);
						children.push(
							h(FolderRow, {
								key: `folder:${folder.id}`,
								folder,
								expanded: folderExpanded,
								sessionCount: folderMembers.length,
								onToggle: () => folderActions.toggle(folder.id),
								onRename: () => folderActions.rename(folder),
								onDelete: () => folderActions.remove(folder),
								onColor: (color) => folderActions.color(folder, color),
								drag: dragApi ? dragApi.folder(folder, group.workspaceId) : undefined,
								cost: costOfFolder(folder.id),
								titleOf: sessionTitleOf
							})
						);
						if (folderExpanded) {
							const innerChildren = folderMembers.map((summary) => renderSession(summary, folder.id, group.workspaceId));
							if (innerChildren.length === 0) {
								innerChildren.push(
									h(
										'div',
										{
											key: `empty:folder:${folder.id}`,
											className: 'wso-empty-row',
											'data-row-key': `empty:folder:${folder.id}`
										},
										'空文件夹'
									)
								);
							}
							children.push(
								h(
									'div',
									{ key: `folder-children:${folder.id}`, className: 'wso-children', 'data-folder': 'true', role: 'group' },
									innerChildren
								)
							);
						}
					}

					if (hiddenCount > 0) {
						rowKeys.push(`overflow:${group.key}`);
						children.push(
							h(
								'button',
								{
									key: `overflow:${group.key}`,
									type: 'button',
									className: 'wso-overflow',
									'data-row-key': `overflow:${group.key}`,
									onClick: (event) => {
										event.stopPropagation();
										props.onShowMore(group.key);
									}
								},
								`显示更多 (+${hiddenCount})`
							)
						);
					}
					if (group.members.length === 0 && folders.length === 0) {
						children.push(
							h(
								'div',
								{ key: 'empty', className: 'wso-empty-row', 'data-row-key': `empty:${group.key}` },
								needle === '' ? '暂无会话' : '没有匹配的会话'
							)
						);
					}
				}

				return h(
					'div',
					{ key: `group:${group.key}`, className: 'wso-group' },
					h(WorkspaceRow, {
						group,
						expanded,
						active,
						sessionCount: group.members.length,
						onToggle: () => props.onToggleWorkspace(group.key),
						onNewSession:
							group.workspaceId === undefined ? undefined : () => nav.startSession(group.workspaceId),
						onNewFolder: () => folderActions.newFolder(group.workspaceId),
						onRename: () => props.onRenameWorkspace(group.workspaceId, group.rawTitle || group.label),
						onDelete: () => props.onDeleteWorkspace(group.workspaceId, group.rawTitle || group.label),
						drag: dragApi ? dragApi.workspace(group) : undefined,
						containsCurrentDescendant: active && expanded !== true,
						cost: workspaceCost,
						unassignedCount
					}),
					expanded ? h('div', { className: 'wso-children', role: 'group' }, children) : null
				);
			};

			const body = groups.map(renderGroup);

			if (body.length === 0) {
				rowKeys.push('empty');
				body.push(
					h(
						'div',
						{ key: 'empty', className: 'wso-empty-row', 'data-row-key': 'empty' },
						needle === '' ? '还没有工作区' : '没有匹配的工作区或会话'
					)
				);
			}

			return h(
				AnimatedRows,
				{
					className: 'wso-tree-list',
					label: '工作区',
					rowKeys,
					ready: workspacesSnapshot.phase === 'ready' && sessionSnapshot.phase === 'ready',
					resetKey: JSON.stringify([
						workspacesSnapshot.items ? workspacesSnapshot.items.length : 0,
						view.expanded,
						view.visible,
						view.foldersExpanded,
						folderState.folders.length
					]),
					children: body
				}
			);
		}

		/**
		 * 顶部工具条：标题 / 视图选项 / 搜索。
		 * 视图选项 = 分组方式（tree·list）+ 归档显示方式，对应官方同组能力。
		 */
		function TreeHeader(props) {
			const { view, onView, query, onQuery, onAddWorkspace, adding } = props;
			const [viewOpen, setViewOpen] = React.useState(false);
			const viewItems = [
				{ id: 'view:tree', label: '按工作区分组', selected: view.view === 'tree' },
				{ id: 'view:list', label: '单列表', selected: view.view === 'list' },
				{ id: 'sep', label: '—', disabled: true, separatorBefore: true },
				{ id: 'filter:default', label: '隐藏已归档', selected: view.archivedFilter === 'default' },
				{ id: 'filter:show', label: '含已归档', selected: view.archivedFilter === 'show' },
				{ id: 'filter:only', label: '仅已归档', selected: view.archivedFilter === 'only' }
			];
			return h(
				'div',
				{ className: 'wso-head' },
				h('span', { className: 'wso-head-title' }, '工作区'),
				h(
					RowIconButton,
					{ label: adding ? '正在选择文件夹…' : '新建工作区', onClick: onAddWorkspace },
					h(IconFolderOpenRegular, { size: 14 })
				),
				h(
					Menu,
					{
						open: viewOpen,
						onClose: () => setViewOpen(false),
						items: viewItems,
						onSelect: (id) => {
							setViewOpen(false);
							if (id.startsWith('view:')) onView({ view: id.slice(5) });
							else if (id.startsWith('filter:')) onView({ archivedFilter: id.slice(7) });
						},
						portal: true,
						anchor: h(
							RowIconButton,
							{ label: '视图选项', open: viewOpen, onClick: () => setViewOpen((value) => !value) },
							h(IconFlatListOutlineRegular, { size: 14 })
						)
					}
				)
			);
		}

		function SearchBar(props) {
			return h(
				'div',
				{ className: 'wso-search' },
				h(IconSearchOutlineRegular, { size: 12 }),
				h('input', {
					className: 'wso-search-input',
					value: props.query,
					placeholder: '筛选工作区或会话…',
					onChange: (event) => props.onChange(event.target.value)
				}),
				props.query === ''
					? null
					: h(
							RowIconButton,
							{ label: '清除筛选', onClick: () => props.onChange('') },
							h(IconCloseOutlineRegular, { size: 11 })
						)
			);
		}

		/**
		 * 接管后的工作区浏览器。
		 *
		 * 只依赖 ctx 服务与私有视图状态；任何服务缺失都降级成空树提示，
		 * 不抛（外层还有 QuietBoundary）。
		 */
		function TreeBrowser(props) {
			const view = useViewState();
			const workspacesStore = props.workspacesStore;
			const sessionsStore = props.sessionsStore;
			const workspacesSnapshot = useStoreSnapshot(workspacesStore);
			const sessionSnapshot = useStoreSnapshot(sessionsStore);
			const [query, setQuery] = React.useState('');
			const [busySessionId, setBusySessionId] = React.useState(null);
			const [adding, setAdding] = React.useState(false);
			const [error, setError] = React.useState(null);
			const folderState = useFoldersState();
			const costs = useCostsState();
			React.useEffect(() => {
				void reloadFolders();
			}, []);
			// 文件夹/工作区/会话一变（收纳、移出、归档、水位刷新）就排一次增量
			// 成本快照。Host 侧只重算水位变了的会话；客户端把树与底栏的请求合并到
			// 同一个 1.2s debounce 里，全插件没有第二个成本定时器。
			React.useEffect(() => {
				if (workspacesSnapshot.phase !== 'ready' || sessionSnapshot.phase !== 'ready') return undefined;
				scheduleCostsRefresh();
				return undefined;
			}, [folderState, sessionSnapshot]);


			const needle = query.trim().toLowerCase();
			const seats = props.readSeats();
			const nav = props.nav;

			// ---- 视图状态 ----
			const toggleWorkspace = (key) => {
				updateView((current) => {
					const next = Object.assign({}, current.expanded);
					if (next[key] === true) delete next[key];
					else next[key] = true;
					return { expanded: next };
				});
			};
			const showMore = (key) => {
				updateView((current) => {
					const next = Object.assign({}, current.visible);
					const base = next[key] === undefined ? SESSION_DEFAULT : next[key];
					next[key] = base + SESSION_STEP;
					return { visible: next };
				});
			};

			// ---- 动作 ----
			const addWorkspace = () => {
				if (adding) return;
				setAdding(true);
				setError(null);
				Promise.resolve(nav.createWorkspace())
					.catch((reason) => {
						setError('新建工作区失败：' + describe(reason));
						console.error('[workspace-organizer] 新建工作区失败', reason);
					})
					.finally(() => setAdding(false));
			};

			const renameSession = React.useCallback((sessionId, title) => {
				ui.set({ dialog: { kind: 'rename-session', sessionId, title: title || '' } });
			}, []);

			// ---- 文件夹动作（失败只 Toast，不阻断树） ----
			const runFolderMutation = (label, operation) => {
				setError(null);
				Promise.resolve()
					.then(operation)
					.then(() => Promise.all([reloadFolders(), reloadCosts()]))
					.catch((reason) => {
						const message = `${label}失败：${describe(reason)}`;
						setError(message);
						showToast(message, 'error');
					});
			};
			const toggleFolder = (folderId) => {
				updateView((current) => {
					const next = Object.assign({}, current.foldersExpanded);
					if (next[folderId] === true) delete next[folderId];
					else next[folderId] = true;
					return { foldersExpanded: next };
				});
			};
			// ---- 拖拽：会话 ↔ 文件夹收纳、同层排序（跨区移动仍走标题） ----
			const dragRef = React.useRef(null);
			const [dragState, setDragState] = React.useState(null);
			const applyDrag = (next) => {
				dragRef.current = next;
				setDragState(next);
			};
			const markerOf = (key) => {
				const over = dragState === null ? null : dragState.over;
				return over !== null && over.key === key ? over.kind : undefined;
			};
			const halfOf = (event) => {
				try {
					const rect = event.currentTarget.getBoundingClientRect();
					return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
				} catch {
					return 'after';
				}
			};
			const beginDrag = (payload) => (event) => {
				applyDrag(Object.assign({ over: null }, payload));
			};
			const endDrag = () => applyDrag(null);
			/** 工作区顶层的当前顺序（与渲染同一套补全规则）。 */
			const topItemsOf = (workspace) => {
				const workspaceId = workspace.workspaceId;
				const membershipOf = new Map((folderState.memberships || []).map((membership) => [membership.sessionId, membership.folderId]));
				const folderById = new Map((folderState.folders || []).map((folder) => [folder.id, folder]));
				const folders = (folderState.folders || [])
					.filter((folder) => folder.workspaceId === workspaceId)
					.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
				const declared = Array.isArray(folderState.orders[workspaceId]) ? folderState.orders[workspaceId] : [];
				const items = [];
				const seenSessions = new Set();
				const seenFolders = new Set();
				const sessionIds = new Set(workspace.sessionIds || []);
				for (const item of declared) {
					if (item === null || typeof item !== 'object') continue;
					if (item.type === 'folder') {
						const folder = folderById.get(item.id);
						if (folder === undefined || folder.workspaceId !== workspaceId || seenFolders.has(folder.id)) continue;
						seenFolders.add(folder.id);
						items.push({ type: 'folder', id: folder.id });
					} else if (item.type === 'session') {
						if (membershipOf.has(item.id) || seenSessions.has(item.id) || !sessionIds.has(item.id)) continue;
						seenSessions.add(item.id);
						items.push({ type: 'session', id: item.id });
					}
				}
				for (const id of workspace.sessionIds || []) {
					if (membershipOf.has(id) || seenSessions.has(id)) continue;
					seenSessions.add(id);
					items.push({ type: 'session', id });
				}
				for (const folder of folders) {
					if (seenFolders.has(folder.id)) continue;
					seenFolders.add(folder.id);
					items.push({ type: 'folder', id: folder.id });
				}
				return items;
			};
			const workspaceById = (workspaceId) => (workspacesSnapshot.items || []).find((item) => item.workspaceId === workspaceId);
			const reorderTop = (workspaceId, moving, anchor, half) => {
				const workspace = workspaceById(workspaceId);
				if (workspace === undefined) return Promise.resolve();
				const list = topItemsOf(workspace).filter((item) => !(item.type === moving.type && item.id === moving.id));
				let at = list.length;
				if (anchor !== null && anchor !== undefined) {
					const index = list.findIndex((item) => item.type === anchor.type && item.id === anchor.id);
					if (index >= 0) at = half === 'after' ? index + 1 : index;
				}
				list.splice(Math.max(0, Math.min(at, list.length)), 0, { type: moving.type, id: moving.id });
				return nav.setOrder(workspaceId, list);
			};
			/** 收纳（含跨区两步：先改 cwd 再写归属，不合并成原子操作）。 */
			const foldInto = async (drag, folder, beforeSessionId) => {
				if (drag.workspaceId !== folder.workspaceId) {
					await nav.moveSession(drag.sessionId, folder.workspaceId);
					await refreshSidebar();
				}
				await nav.addToFolder(folder.id, drag.sessionId, beforeSessionId);
			};
			const dropOnSession = async (drag, target) => {
				if (drag.type === 'folder') {
					await reorderTop(target.workspaceId, { type: 'folder', id: drag.id }, { type: 'session', id: target.sessionId }, target.half);
					return;
				}
				if (drag.sessionId === target.sessionId) return;
				if (target.folderId !== null) {
					const folder = (folderState.folders || []).find((item) => item.id === target.folderId);
					if (folder === undefined) return;
					await foldInto(drag, folder, target.half === 'before' ? target.sessionId : undefined);
					return;
				}
				// 落到未收纳会话上：同区排序；来源在文件夹里时先移出。
				if (drag.workspaceId !== target.workspaceId) return;
				if (drag.fromFolderId !== null) {
					await nav.removeFromFolder(drag.sessionId);
				}
				await reorderTop(target.workspaceId, { type: 'session', id: drag.sessionId }, { type: 'session', id: target.sessionId }, target.half);
			};
			const dropOnFolder = async (drag, folder) => {
				if (drag.type === 'folder') {
					if (drag.id === folder.id) return;
					await reorderTop(folder.workspaceId, { type: 'folder', id: drag.id }, { type: 'folder', id: folder.id }, 'before');
					return;
				}
				await foldInto(drag, folder, undefined);
			};
			const dropOnWorkspace = async (drag, workspaceId) => {
				if (drag.type === 'session' && drag.workspaceId === workspaceId && drag.fromFolderId !== null) {
					await nav.removeFromFolder(drag.sessionId);
					await reorderTop(workspaceId, { type: 'session', id: drag.sessionId }, null, 'after');
					return;
				}
				if (drag.workspaceId !== workspaceId) return;
				await reorderTop(workspaceId, { type: drag.type, id: drag.type === 'folder' ? drag.id : drag.sessionId }, null, 'after');
			};
			const runDrop = (label, operation) => {
				setError(null);
				Promise.resolve()
					.then(operation)
					.then(() => reloadFolders())
					.catch((reason) => {
						const message = `${label}失败：${describe(reason)}`;
						setError(message);
						showToast(message, 'error');
					});
			};
			const dragApi = {
				session(node, folderId, workspaceId) {
					const key = `session:${node.id}`;
					const payload = {
						type: 'session',
						id: node.id,
						sessionId: node.id,
						fromFolderId: folderId === undefined ? null : folderId,
						workspaceId
					};
					return {
						active: dragState !== null && dragState.type === 'session' && dragState.id === node.id,
						marker: markerOf(key),
						start: beginDrag(payload),
						end: endDrag,
						onDragOver(event) {
							const drag = dragRef.current;
							if (drag === null || drag.id === node.id) return;
							if (drag.type === 'session' && drag.workspaceId !== workspaceId && folderId === null) return;
							if (drag.type === 'folder' && drag.workspaceId !== workspaceId) return;
							event.preventDefault();
							event.stopPropagation();
							try {
								event.dataTransfer.dropEffect = 'move';
							} catch {
								/* 只读阶段 */
							}
							const half = halfOf(event);
							if (drag.over === null || drag.over.key !== key || drag.over.kind !== half) {
								applyDrag(Object.assign({}, drag, { over: { key, kind: half } }));
							}
						},
						onDragLeave(event) {
							const drag = dragRef.current;
							if (drag === null || drag.over === null || drag.over.key !== key) return;
							void event;
							applyDrag(Object.assign({}, drag, { over: null }));
						},
						onDrop(event) {
							const drag = dragRef.current;
							if (drag === null || drag.id === node.id) return;
							if (drag.type === 'session' && drag.workspaceId !== workspaceId && folderId === null) return;
							if (drag.type === 'folder' && drag.workspaceId !== workspaceId) return;
							event.preventDefault();
							event.stopPropagation();
							const half = halfOf(event);
							applyDrag(null);
							runDrop('收纳/排序', () =>
								dropOnSession(drag, { sessionId: node.id, folderId: folderId === undefined ? null : folderId, workspaceId, half })
							);
						}
					};
				},
				folder(folder, workspaceId) {
					const key = `folder:${folder.id}`;
					return {
						active: dragState !== null && dragState.type === 'folder' && dragState.id === folder.id,
						marker: markerOf(key),
						start: beginDrag({ type: 'folder', id: folder.id, sessionId: null, fromFolderId: null, workspaceId: folder.workspaceId }),
						end: endDrag,
						onDragOver(event) {
							const drag = dragRef.current;
							if (drag === null) return;
							if (drag.type === 'folder' && (drag.id === folder.id || drag.workspaceId !== folder.workspaceId)) return;
							// 跨区会话进文件夹是两步操作（先改 cwd 再写归属），这里一律放行。
							event.preventDefault();
							event.stopPropagation();
							try {
								event.dataTransfer.dropEffect = 'move';
							} catch {
								/* 只读阶段 */
							}
							if (drag.over === null || drag.over.key !== key || drag.over.kind !== 'into') {
								applyDrag(Object.assign({}, drag, { over: { key, kind: 'into' } }));
							}
						},
						onDragLeave(event) {
							const drag = dragRef.current;
							if (drag === null || drag.over === null || drag.over.key !== key) return;
							void event;
							applyDrag(Object.assign({}, drag, { over: null }));
						},
						onDrop(event) {
							const drag = dragRef.current;
							if (drag === null) return;
							event.preventDefault();
							event.stopPropagation();
							applyDrag(null);
							runDrop('收纳/排序', () => dropOnFolder(drag, folder));
						}
					};
				},
				workspace(group) {
					const key = `workspace:${group.key}`;
					return {
						active: false,
						marker: markerOf(key),
						start: beginDrag({ type: 'workspace', id: group.key, sessionId: null, fromFolderId: null, workspaceId: group.workspaceId }),
						end: endDrag,
						onDragOver(event) {
							const drag = dragRef.current;
							if (drag === null) return;
							// 工作区排序可以跨行；会话/文件夹只允许在本工作区内落到标题上。
							if (drag.type !== 'workspace' && drag.workspaceId !== group.workspaceId) return;
							event.preventDefault();
							event.stopPropagation();
							if (drag.over === null || drag.over.key !== key || drag.over.kind !== 'after') {
								applyDrag(Object.assign({}, drag, { over: { key, kind: 'after' } }));
							}
						},
						onDragLeave(event) {
							const drag = dragRef.current;
							if (drag === null || drag.over === null || drag.over.key !== key) return;
							void event;
							applyDrag(Object.assign({}, drag, { over: null }));
						},
						onDrop(event) {
							const drag = dragRef.current;
							if (drag === null) return;
							if (drag.type !== 'workspace' && drag.workspaceId !== group.workspaceId) return;
							event.preventDefault();
							event.stopPropagation();
							applyDrag(null);
							if (drag.type === 'workspace') {
								if (drag.id === group.key) return;
								runDrop('工作区排序', () => nav.reorderWorkspace(drag.id, group.key).then(() => refreshSidebar()));
								return;
							}
							runDrop('排序', () => dropOnWorkspace(drag, group.workspaceId));
						}
					};
				}
			};
			const folderActions = {
				toggle: toggleFolder,
				newFolder(workspaceId) {
					if (workspaceId === undefined) return;
					ui.set({ dialog: { kind: 'new-folder', workspaceId } });
				},
				rename(folder) {
					ui.set({ dialog: { kind: 'rename-folder', folderId: folder.id, name: folder.name, color: folder.color || '' } });
				},
				color(folder, color) {
					runFolderMutation('改文件夹颜色', () => nav.updateFolder(folder.id, { color }));
				},
				remove(folder) {
					const question = `删除文件夹「${folder.name}」？\n\n里面的会话会回到同一工作区的未收纳区，不会删除任何会话或磁盘目录。`;
					if (typeof window.confirm === 'function' && !window.confirm(question)) return;
					runFolderMutation('删除文件夹', () => nav.deleteFolder(folder.id));
				}
			};

			const renameWorkspace = (workspaceId, title) => {
				if (workspaceId === undefined) return;
				ui.set({ dialog: { kind: 'rename-workspace', workspaceId, title: title || '' } });
			};
			const deleteWorkspace = (workspaceId, title) => {
				if (workspaceId === undefined) return;
				const question = `删除工作区「${title}」？\n\n只会把它从侧边栏移除；工作区目录与会话档案留在磁盘上，不会删除。`;
				if (typeof window.confirm === 'function' && !window.confirm(question)) return;
				nav.deleteWorkspace(workspaceId).catch((reason) => {
					setError('删除工作区失败：' + describe(reason));
					showToast('删除工作区失败：' + describe(reason), 'error');
				});
			};

			if (props.wide === false) {
				return h(
					'div',
					{ className: 'wso-root' },
					h(
						'div',
						{ className: 'wso-rail' },
						h(
							'button',
							{
								type: 'button',
								className: 'wso-rail-btn',
								title: '展开侧边栏',
								onClick: () => props.expandSidebar && props.expandSidebar()
							},
							h(IconWorkspaceTreeOutlineRegular, { size: 16 })
						)
					)
				);
			}

			return h(
				'div',
				{ className: 'wso-root' },
				h(TreeHeader, {
					view,
					onView: (patch) => updateView(patch),
					query,
					onQuery: setQuery,
					onAddWorkspace: addWorkspace,
					adding
				}),
				h(SearchBar, { query, onChange: setQuery }),
				// 没有成本数据源时：工作区/文件夹的花费列整列隐藏，这里只留一行说明
				// （不阻断折叠、拖拽、排序等任何原有交互）。
				costs.available !== true &&
				(folderState.folders.length > 0 || (workspacesSnapshot.items || []).length > 0)
					? h(
							'div',
							{
								className: 'wso-cost-hint',
								title:
									costs.reason ||
									'未找到会话级成本数据源（dsh-workspace-hub / meow-cachebilling 投影均不可用）'
							},
							'成本统计不可用'
						)
					: null,
				error === null
					? null
					: h('div', { className: 'wso-empty-row', title: error }, error),
				workspacesSnapshot.phase !== 'ready' || sessionSnapshot.phase !== 'ready'
					? h('div', { className: 'wso-empty-row' }, '正在载入…')
					: view.view === 'list'
						? h(FlatTypeBody, {
								sessionSnapshot,
								workspacesSnapshot,
								view,
								needle,
								seats,
								t: props.t,
								nav,
								onRenameSession: renameSession,
								busySessionId,
								dragApi
							})
						: h(WorkspaceTreeBody, {
								workspacesSnapshot,
								sessionSnapshot,
								view,
								needle,
								archivedFilter: view.archivedFilter,
								seats,
								t: props.t,
								nav,
								onRenameSession: renameSession,
								onToggleWorkspace: toggleWorkspace,
								onShowMore: showMore,
								onRenameWorkspace: renameWorkspace,
								onDeleteWorkspace: deleteWorkspace,
								busySessionId,
								dragApi,
								folderState,
								folderActions,
								costs
							})
			);
		}

		/** 单列表视图：全部会话平铺（官方 "In one list" 的等价能力）。 */
		function FlatTypeBody(props) {
			const { sessionSnapshot, workspacesSnapshot, view, needle, seats, t, nav, onRenameSession, busySessionId, dragApi } = props;
			const currentId = currentMainSessionId(sessionSnapshot);
			const archivedSet = new Set(workspacesSnapshot.archivedSessionIds || []);
			const pinnedSet = new Set(workspacesSnapshot.pinnedSessionIds || []);
			const rows = [];
			const rowKeys = [];
			const members = [];
			for (const id of sessionSnapshot.ids || []) {
				const summary = (sessionSnapshot.byId || {})[id];
				if (summary === undefined) continue;
				if (!sessionVisible(summary, currentId, archivedSet, view.archivedFilter)) continue;
				if (!matchesQuery(summary, needle)) continue;
				members.push(summary);
			}
			for (const summary of sectionMembers(members, pinnedSet, archivedSet)) {
				const node = {
					id: summary.id,
					title: summary.blank === true ? '' : summary.title || '',
					blank: summary.blank === true,
					archived: archivedSet.has(summary.id),
					pinned: pinnedSet.has(summary.id),
					running: summary.running === true,
					cwd: summary.cwd,
					updatedAt: summary.updatedAt
				};
				rowKeys.push(`session:${node.id}`);
				rows.push(
					h(SessionRow, {
						key: `session:${node.id}`,
						node,
						selected: node.id === currentId,
						busy: busySessionId === node.id,
						onOpen: nav.openSession,
						onRename: onRenameSession,
						seats,
						t,
						renderHover: (rowNode, title) => renderHoverContent(rowNode, title, seats, t),
						drag: dragApi ? dragApi.session(node) : undefined
					})
				);
			}
			if (rows.length === 0) {
				rowKeys.push('empty');
				rows.push(h('div', { key: 'empty', className: 'wso-empty-row', 'data-row-key': 'empty' }, needle === '' ? '还没有会话' : '没有匹配的会话'));
			}
			return h(
				AnimatedRows,
				{
					className: 'wso-tree-list',
					label: '全部会话',
					rowKeys,
					ready: workspacesSnapshot.phase === 'ready' && sessionSnapshot.phase === 'ready',
					resetKey: JSON.stringify([view.archivedFilter, needle]),
					children: rows
				}
			);
		}
		// #endregion

		// #region 组件：确认移动 / 删除 / 回收站 / 重命名
		function MoveConfirmDialog({ request }) {
			const [busy, setBusy] = useState(false);
			if (request === null) return null;
			const close = () => {
				if (!busy) ui.set({ dialog: null });
			};
			const confirm = async () => {
				if (busy) return;
				setBusy(true);
				try {
					await rpc('organizer.move', { sessionId: request.sessionId, targetWorkspaceId: request.targetWorkspaceId });
					showToast(`已移动到「${request.targetTitle}」`);
					ui.set({ dialog: null });
					await refreshSidebar();
				} catch (error) {
					showToast(`移动失败：${errorText(error)}`, 'error');
					ui.set({ dialog: null });
				} finally {
					setBusy(false);
				}
			};
			return h(
				Modal,
				{
					open: true,
					onClose: close,
					title: '移动到其他工作区',
					closeLabel: '关闭',
					footer: h(
						React.Fragment,
						null,
						h(Button, { variant: 'outline', onClick: close, disabled: busy }, '取消'),
						h(Button, { variant: 'primary', onClick: () => void confirm(), disabled: busy }, busy ? '正在移动…' : '移动')
					)
				},
				h(
					'div',
					{ className: 'wso-body' },
					h('div', null, `会话：${request.title || request.sessionId}`),
					h('div', null, `${request.sourceTitle || '当前工作区'} → ${request.targetTitle}`),
					h('div', { className: 'wso-muted' }, '会改写会话档案里的工作目录并搬到目标工作区目录，全部历史原样保留；失败会自动回滚。')
				)
			);
		}

		const DELETE_MODES = [
			{ id: 'recycle', title: '移入回收站（默认）', hint: '从侧边栏移除，档案移到插件回收站；随时可以恢复。' },
			{ id: 'unregister', title: '仅移除注册', hint: '只从工作区名单里摘掉，磁盘档案保留。索引重建后它可能重新出现。' },
			{ id: 'purge', title: '彻底删除', hint: '先备份，再从磁盘删除档案。备份失败会拒绝删除。' }
		];

		function DeleteDialog({ request }) {
			const [mode, setMode] = useState('recycle');
			const [armed, setArmed] = useState(false);
			const [busy, setBusy] = useState(false);
			if (request === null) return null;
			const close = () => {
				if (!busy) ui.set({ dialog: null });
			};
			const run = async () => {
				if (busy) return;
				if (mode === 'purge' && !armed) {
					setArmed(true);
					return;
				}
				setBusy(true);
				try {
					const result = await rpc('organizer.delete', { sessionId: request.sessionId, mode });
					if (mode === 'recycle') showToast('已移入回收站，可从侧边栏底部的回收站入口恢复');
					else if (mode === 'unregister') showToast('已移除注册（磁盘档案保留）');
					else showToast('已彻底删除（备份已保留）');
					if (result?.mode === 'unregister' && result?.degraded === 'no-artifact' && mode === 'recycle') {
						showToast('该会话还没有落盘档案，已改为移除注册');
					}
					ui.set({ dialog: null });
					await afterSessionRemoved(request.sessionId);
				} catch (error) {
					showToast(`删除失败：${errorText(error)}`, 'error');
					ui.set({ dialog: null });
				} finally {
					setBusy(false);
				}
			};
			const purgeArmed = mode === 'purge' && armed;
			return h(
				Modal,
				{
					open: true,
					onClose: close,
					title: '删除项目',
					closeLabel: '关闭',
					footer: h(
						React.Fragment,
						null,
						h(Button, { variant: 'outline', onClick: close, disabled: busy }, '取消'),
						h(Button, { variant: 'primary', onClick: () => void run(), disabled: busy }, busy ? '正在处理…' : purgeArmed ? '确认彻底删除' : '删除')
					)
				},
				h(
					'div',
					{ className: 'wso-body' },
					h('div', null, `会话：${request.title || request.sessionId}`),
					DELETE_MODES.map((item) =>
						h(
							'label',
							{ key: item.id, className: 'wso-option', 'data-active': mode === item.id ? 'true' : 'false' },
							h('input', {
								type: 'radio',
								name: 'wso-delete-mode',
								checked: mode === item.id,
								disabled: busy,
								onChange: () => {
									setMode(item.id);
									setArmed(false);
								}
							}),
							h('span', null, h('div', { className: 'wso-option-title' }, item.title), h('div', { className: 'wso-muted' }, item.hint))
						)
					),
					mode === 'purge'
						? h(
								'div',
								{ className: 'wso-warn' },
								h(IconWarningOutlineRegular, { size: 18 }),
								h(
									'span',
									null,
									purgeArmed
										? '再点一次「确认彻底删除」即会删除磁盘档案。备份会保留在插件备份目录，可用于人工恢复。'
										: '彻底删除不可通过撤销恢复；需要再确认一次。'
								)
							)
						: null
				)
			);
		}

		function RenameDialog({ request }) {
			const [value, setValue] = useState(request.title || '');
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			if (request === null) return null;
			const isWorkspace = request.kind === 'rename-workspace';
			const close = () => {
				if (!busy) ui.set({ dialog: null });
			};
			const submit = async () => {
				const next = value.trim();
				if (busy) return;
				if (next === '') {
					setError('名称不能为空');
					return;
				}
				setBusy(true);
				setError(null);
				try {
					if (moduleNavigator === null) throw new Error('工作区服务不可用');
					if (isWorkspace) {
						await moduleNavigator.renameWorkspace(request.workspaceId, next);
					} else {
						await moduleNavigator.renameSession(request.sessionId, next);
					}
					showToast('已重命名');
					ui.set({ dialog: null });
					await refreshSidebar();
				} catch (reason) {
					setError(errorText(reason));
				} finally {
					setBusy(false);
				}
			};
			return h(
				Modal,
				{
					open: true,
					onClose: close,
					title: isWorkspace ? '重命名工作区' : '重命名会话',
					closeLabel: '关闭',
					footer: h(
						React.Fragment,
						null,
						h(Button, { variant: 'outline', onClick: close, disabled: busy }, '取消'),
						h(Button, { variant: 'primary', onClick: () => void submit(), disabled: busy }, busy ? '正在保存…' : '保存')
					)
				},
				h(
					'div',
					{ className: 'wso-body' },
					h('input', {
						className: 'wso-input',
						autoFocus: true,
						value,
						onChange: (event) => setValue(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') void submit();
							else if (event.key === 'Escape') close();
						}
					}),
					error === null ? null : h('div', { className: 'wso-warn' }, h('span', null, error))
				)
			);
		}

		const FOLDER_COLORS = ['#4f7cf5', '#2fb37a', '#e5484d', '#f5a623', '#8e5bf5'];

		/** 新建 / 重命名文件夹（名称 + 颜色）。 */
		function FolderDialog({ request }) {
			const isNew = request.kind === 'new-folder';
			const [name, setName] = useState(isNew ? '' : request.name || '');
			const [color, setColor] = useState(request.color || '');
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			if (request === null) return null;
			const close = () => {
				if (!busy) ui.set({ dialog: null });
			};
			const submit = async () => {
				const next = name.trim();
				if (busy) return;
				if (next === '') {
					setError('文件夹名不能为空');
					return;
				}
				setBusy(true);
				setError(null);
				try {
					if (isNew) {
						await rpc('organizer.folders.create', {
							workspaceId: request.workspaceId,
							name: next,
							color: color === '' ? undefined : color
						});
					} else {
						await rpc('organizer.folders.update', { folderId: request.folderId, name: next, color });
					}
					showToast(isNew ? '已新建文件夹' : '文件夹已更新');
					ui.set({ dialog: null });
					await reloadFolders();
				} catch (reason) {
					setError(errorText(reason));
				} finally {
					setBusy(false);
				}
			};
			return h(
				Modal,
				{
					open: true,
					onClose: close,
					title: isNew ? '新建文件夹' : '文件夹设置',
					closeLabel: '关闭',
					footer: h(
						React.Fragment,
						null,
						h(Button, { variant: 'outline', onClick: close, disabled: busy }, '取消'),
						h(Button, { variant: 'primary', onClick: () => void submit(), disabled: busy }, busy ? '正在保存…' : '保存')
					)
				},
				h(
					'div',
					{ className: 'wso-body' },
					h('div', { className: 'wso-muted' }, '文件夹只影响侧边栏的显示分组：不移动目录，也不改会话的工作目录。'),
					h('input', {
						className: 'wso-input',
						autoFocus: true,
						placeholder: '文件夹名称',
						value: name,
						onChange: (event) => setName(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') void submit();
							else if (event.key === 'Escape') close();
						}
					}),
					h(
						'div',
						{ className: 'wso-actions' },
						FOLDER_COLORS.map((value) =>
							h('button', {
								key: value,
								type: 'button',
								title: value,
								style: {
									width: '18px',
									height: '18px',
									borderRadius: '50%',
									border: color === value ? '2px solid currentColor' : '1px solid transparent',
									background: value,
									cursor: 'pointer'
								},
								onClick: () => setColor(value)
							})
						),
						h(
							'button',
							{
								type: 'button',
								className: 'wso-icon-btn',
								style: { opacity: color === '' ? 1 : 0.5, width: '22px', height: '22px' },
								title: '默认颜色',
								onClick: () => setColor('')
							},
							'⌀'
						)
					),
					error === null ? null : h('div', { className: 'wso-warn' }, h('span', null, error))
				)
			);
		}

		/**
		 * 「移到文件夹…」对话框：列出该会话所在工作区的文件夹。
		 * 只写归属（sidecar），不改 cwd、不动磁盘。
		 */
		function AssignDialog({ request }) {
			const folderState = useFoldersState();
			const [creating, setCreating] = useState(false);
			const [name, setName] = useState('');
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			React.useEffect(() => {
				void reloadFolders();
			}, []);
			if (request === null) return null;
			const close = () => {
				if (!busy) ui.set({ dialog: null });
			};
			let workspaceId;
			try {
				const snapshot = hostCtx?.get?.('workspaces')?.list?.getSnapshot?.();
				for (const workspace of (snapshot && snapshot.items) || []) {
					if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(request.sessionId)) {
						workspaceId = workspace.workspaceId;
						break;
					}
				}
			} catch {
				workspaceId = undefined;
			}
			const folders = (folderState.folders || [])
				.filter((folder) => folder.workspaceId === workspaceId)
				.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
			const current = (folderState.memberships || []).find((membership) => membership.sessionId === request.sessionId);
			const run = (operation, message) => {
				if (busy) return;
				setBusy(true);
				setError(null);
				Promise.resolve()
					.then(operation)
					.then(async () => {
						showToast(message);
						ui.set({ dialog: null });
						await reloadFolders();
					})
					.catch((reason) => setError(errorText(reason)))
					.finally(() => setBusy(false));
			};
			const createAndAssign = () => {
				const next = name.trim();
				if (next === '') {
					setError('文件夹名不能为空');
					return;
				}
				run(async () => {
					const created = await rpc('organizer.folders.create', { workspaceId, name: next });
					await rpc('organizer.folders.add', { folderId: created.folderId, sessionId: request.sessionId });
				}, '已收纳到新文件夹');
			};
			return h(
				Modal,
				{
					open: true,
					onClose: close,
					title: '移到文件夹',
					closeLabel: '关闭',
					footer: h(
						React.Fragment,
						null,
						h(
							Button,
							{
								variant: 'outline',
								disabled: busy || current === undefined,
								onClick: () => run(() => rpc('organizer.folders.remove', { sessionId: request.sessionId }), '已移出文件夹')
							},
							'移出文件夹'
						),
						h(Button, { variant: 'primary', onClick: close, disabled: busy }, '完成')
					)
				},
				h(
					'div',
					{ className: 'wso-body' },
					h('div', { className: 'wso-muted' }, `会话：${request.title || request.sessionId}`),
					workspaceId === undefined
						? h('div', { className: 'wso-warn' }, h('span', null, '找不到该会话所在的工作区'))
						: h(
								'div',
								{ className: 'wso-list' },
								folders.length === 0 ? h('div', { className: 'wso-empty' }, '这个工作区还没有文件夹') : null,
								folders.map((folder) =>
									h(
										'button',
										{
											key: folder.id,
											type: 'button',
											className: 'wso-row',
											style: { textAlign: 'left', cursor: 'pointer', background: 'transparent' },
											disabled: busy,
											onClick: () => run(() => rpc('organizer.folders.add', { folderId: folder.id, sessionId: request.sessionId }), `已收纳到「${folder.name}」`)
										},
										h(IconFolderOpenRegular, { size: 15, style: folder.color === undefined ? undefined : { color: folder.color } }),
										h('span', { className: 'wso-label' }, folder.name),
										current !== undefined && current.folderId === folder.id ? h('span', { className: 'wso-count' }, '当前') : null
									)
								)
							),
					creating
						? h(
								'div',
								{ className: 'wso-actions' },
								h('input', {
									className: 'wso-input',
									placeholder: '新文件夹名称',
									value: name,
									onChange: (event) => setName(event.target.value),
									onKeyDown: (event) => {
										if (event.key === 'Enter') createAndAssign();
									}
								}),
								h(Button, { variant: 'primary', disabled: busy, onClick: createAndAssign }, '创建并收纳')
							)
						: h(
								Button,
								{ variant: 'outline', disabled: busy || workspaceId === undefined, onClick: () => setCreating(true) },
								'新建文件夹并收纳'
							),
					error === null ? null : h('div', { className: 'wso-warn' }, h('span', null, error))
				)
			);
		}

		function TrashDialog({ open }) {
			const [state, setState] = useState({ loading: false, items: [], error: null });
			const [pendingPurge, setPendingPurge] = useState(null);
			const [busy, setBusy] = useState(false);

			const load = async () => {
				setState((current) => ({ ...current, loading: true, error: null }));
				try {
					const result = await rpc('organizer.trash.list');
					setState({ loading: false, items: result?.items ?? [], error: null });
				} catch (error) {
					setState({ loading: false, items: [], error: errorText(error) });
				}
			};

			useEffect(() => {
				if (open) void load();
			}, [open]);

			if (!open) return null;
			const close = () => {
				if (!busy) ui.set({ dialog: null });
			};

			const restore = async (item) => {
				setBusy(true);
				try {
					await rpc('organizer.trash.restore', { sessionId: item.sessionId });
					showToast(`已恢复「${item.title || item.sessionId}」`);
					await refreshSidebar();
					await load();
				} catch (error) {
					showToast(`恢复失败：${errorText(error)}`, 'error');
				} finally {
					setBusy(false);
				}
			};

			const purge = async (item) => {
				if (pendingPurge?.sessionId !== item.sessionId) {
					setPendingPurge(item);
					return;
				}
				setBusy(true);
				try {
					await rpc('organizer.trash.purge', { sessionId: item.sessionId });
					showToast('已彻底删除（备份已保留）');
					setPendingPurge(null);
					await load();
				} catch (error) {
					showToast(`彻底删除失败：${errorText(error)}`, 'error');
				} finally {
					setBusy(false);
				}
			};

			return h(
				Modal,
				{
					open: true,
					onClose: close,
					title: '回收站',
					closeLabel: '关闭',
					footer: h(Button, { variant: 'outline', onClick: close, disabled: busy }, '关闭')
				},
				h(
					'div',
					{ className: 'wso-body' },
					h('div', { className: 'wso-muted' }, '删除的会话档案在这里；恢复会把它搬回原工作区目录。'),
					state.loading ? h('div', { className: 'wso-empty' }, '正在载入…') : null,
					state.error === null ? null : h('div', { className: 'wso-warn' }, h('span', null, state.error)),
					!state.loading && state.items.length === 0 ? h('div', { className: 'wso-empty' }, '回收站是空的') : null,
					h(
						'div',
						{ className: 'wso-list' },
						state.items.map((item) =>
							h(
								'div',
								{ key: item.sessionId, className: 'wso-row' },
								h(
									'div',
									{ className: 'wso-row-main' },
									h('div', { className: 'wso-row-title', title: item.title }, item.title || item.sessionId),
									h('div', { className: 'wso-row-meta', title: item.originalCwd }, item.originalCwd || '未知原路径')
								),
								h(
									'div',
									{ className: 'wso-actions' },
									h(Button, { variant: 'outline', disabled: busy, onClick: () => void restore(item) }, '恢复'),
									h(
										Button,
										{ variant: 'outline', disabled: busy, onClick: () => void purge(item) },
										pendingPurge?.sessionId === item.sessionId ? '确认删除' : '彻底删除'
									)
								)
							)
						)
					)
				)
			);
		}
		// #endregion

		// #region 菜单项 / Footer / Overlay
		function dismissMenus(close) {
			try {
				close?.();
			} catch {
				/* 菜单已自行关闭 */
			}
			try {
				document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
			} catch {
				/* 老旧环境没有 PointerEvent：菜单留着也不影响对话框 */
			}
		}

		function menuCloseOf(props) {
			return () => {
				let state = null;
				try {
					state = typeof props?.useMenuOpenState === 'function' ? props.useMenuOpenState() : (props?.hookContext ?? null);
				} catch {
					state = null;
				}
				dismissMenus(state?.[1]);
			};
		}

		function SessionDeleteMenuItem(props) {
			const close = menuCloseOf(props);
			return h(
				MenuItemButton,
				{
					icon: h(IconTrashOutlineRegular, {}),
					danger: true,
					separatorBefore: true,
					onSelect: () => {
						close();
						ui.set({ dialog: { kind: 'delete', sessionId: props?.sessionId, title: props?.displayTitle } });
					}
				},
				'删除项目…'
			);
		}

		/** 会话菜单：移到文件夹…（写归属，不改 cwd）。 */
		function SessionFolderMenuItem(props) {
			const close = menuCloseOf(props);
			return h(
				MenuItemButton,
				{
					icon: h(IconFolderOpenRegular, { size: 14 }),
					onSelect: () => {
						close();
						ui.set({ dialog: { kind: 'assign', sessionId: props?.sessionId, title: props?.displayTitle } });
					}
				},
				'移到文件夹…'
			);
		}

		function TrashFooterAction() {
			return h(
				'button',
				{
					type: 'button',
					className: 'wso-footer-action',
					title: '回收站：恢复或彻底删除已删除的项目',
					onClick: () => ui.set({ dialog: { kind: 'trash' } })
				},
				h(IconTrashOutlineRegular, { size: 16 }),
				h('span', null, '回收站')
			);
		}

		/** 侧栏底部的「切换官方视图」：一句话说明当前是谁在画侧边栏。 */
		function ViewToggleFooterAction() {
			const view = useViewState();
			const custom = view.mode !== 'native';
			const hint = custom ? '当前：本插件的文件夹树（点击切回官方工作区列表）' : '当前：官方工作区列表（点击切回本插件的文件夹树）';
			return h(
				'button',
				{
					type: 'button',
					className: 'wso-footer-action',
					'data-on': custom ? 'true' : undefined,
					title: hint,
					'aria-pressed': custom,
					onClick: () => updateView({ mode: custom ? 'native' : 'tree' })
				},
				custom ? h(IconFolderOpenRegular, { size: 16 }) : h(IconWorkspaceTreeOutlineRegular, { size: 16 }),
				h('span', null, custom ? '文件夹树' : '官方视图')
			);
		}

		function OverlayHost() {
			const [snapshot, setSnapshot] = useState(ui.state);
			useEffect(() => {
				setSnapshot(ui.state);
				return ui.subscribe(() => setSnapshot(ui.state));
			}, []);
			const dialog = snapshot.dialog;
			const toast = snapshot.toast;
			return h(
				React.Fragment,
				null,
				dialog?.kind === 'move' ? h(MoveConfirmDialog, { request: dialog }) : null,
				dialog?.kind === 'delete' ? h(DeleteDialog, { request: dialog }) : null,
				dialog?.kind === 'rename-session' || dialog?.kind === 'rename-workspace' ? h(RenameDialog, { request: dialog }) : null,
				dialog?.kind === 'trash' ? h(TrashDialog, { open: true }) : null,
				dialog?.kind === 'new-folder' || dialog?.kind === 'rename-folder' ? h(FolderDialog, { request: dialog }) : null,
				dialog?.kind === 'assign' ? h(AssignDialog, { request: dialog }) : null,
				toast !== null
					? h(Toast, {
							key: toast.id,
							text: toast.text,
							tone: toast.tone === 'success' ? 'success' : undefined,
							icon: toast.tone === 'success' ? undefined : h(IconWarningOutlineRegular, { size: 16 }),
							holdMs: toast.tone === 'success' ? 3200 : 5200,
							onDone: () => {
								if (ui.state.toast?.id === toast.id) ui.set({ toast: null });
							}
						})
					: null
			);
		}
		// #endregion

		// #region 拖拽：会话行 → 其他工作区标题（M1 保留既有能力）
		const SESSION_ROW = 'div[role="treeitem"][aria-selected]';
		const WORKSPACE_ROW = 'div[role="treeitem"][aria-expanded]';

		function fiberOf(element) {
			if (element === null || element === undefined) return null;
			try {
				const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
				return key === undefined ? null : element[key];
			} catch {
				return null;
			}
		}

		function sessionInfoOf(row) {
			let fiber = fiberOf(row);
			for (let depth = 0; depth < 12 && fiber !== null && fiber !== undefined; depth += 1) {
				const props = fiber.memoizedProps;
				if (props && typeof props === 'object') {
					const node = props.node;
					if (node && typeof node.id === 'string') return { id: node.id, title: node.title || '' };
					if (typeof props.sessionId === 'string' && props.displayTitle !== undefined) {
						return { id: props.sessionId, title: props.displayTitle || '' };
					}
				}
				fiber = fiber.return;
			}
			return null;
		}

		function workspaceInfoOf(header) {
			let fiber = fiberOf(header);
			for (let depth = 0; depth < 12 && fiber !== null && fiber !== undefined; depth += 1) {
				const props = fiber.memoizedProps;
				if (props && typeof props === 'object' && props.group && typeof props.group.workspaceId === 'string') {
					return { workspaceId: props.group.workspaceId, label: props.group.label || '' };
				}
				if (props && typeof props === 'object' && typeof props.workspaceId === 'string' && props.label !== undefined) {
					return { workspaceId: props.workspaceId, label: props.label || '' };
				}
				fiber = fiber.return;
			}
			return null;
		}

		function closestRow(target, selector) {
			try {
				return target?.closest?.(selector) ?? null;
			} catch {
				return null;
			}
		}

		/** 起拖行所属的工作区标题：从行出发逐层向上，在每层容器**前面**的兄弟里找标题行。 */
		function owningHeader(row) {
			let node = row;
			for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
				const container = node.parentElement;
				if (container === null) return null;
				let sibling = container.previousElementSibling;
				while (sibling !== null) {
					if (sibling.matches?.(WORKSPACE_ROW)) return sibling;
					const nested = sibling.querySelector?.(WORKSPACE_ROW);
					if (nested) return nested;
					sibling = sibling.previousElementSibling;
				}
				node = container;
			}
			return null;
		}

		const dragState = { row: null, info: null, header: null, marker: null };

		function clearDropMark() {
			if (dragState.marker !== null) {
				dragState.marker.classList.remove('wso-drop-target');
				dragState.marker = null;
			}
		}

		function resetDrag() {
			clearDropMark();
			dragState.row = null;
			dragState.info = null;
			dragState.header = null;
		}

		/** 拖拽事件安装（capture 阶段；同区排序仍交给官方/本树自己的 drop）。 */
		function installDragBridge() {
			const onDragStart = (event) => {
				resetDrag();
				const row = closestRow(event.target, SESSION_ROW);
				if (row === null) return; // 工作区行拖动 = 排序或跨区，交给各自的处理器
				const info = sessionInfoOf(row);
				if (info === null) return;
				dragState.row = row;
				dragState.info = info;
				dragState.header = owningHeader(row);
			};

			const onDragOver = (event) => {
				if (dragState.row === null) return;
				const header = closestRow(event.target, WORKSPACE_ROW);
				if (header === null) {
					clearDropMark();
					return;
				}
				const target = workspaceInfoOf(header);
				const source = dragState.header === null ? null : workspaceInfoOf(dragState.header);
				if (target === null || (source !== null && source.workspaceId === target.workspaceId)) {
					clearDropMark();
					return; // 同一工作区：交给本树自己的排序/收纳逻辑
				}
				event.preventDefault();
				event.stopPropagation();
				try {
					event.dataTransfer.dropEffect = 'move';
				} catch {
					/* 某些浏览器在 dragover 阶段只读 */
				}
				if (dragState.marker !== header) {
					clearDropMark();
					header.classList.add('wso-drop-target');
					dragState.marker = header;
				}
			};

			const onDrop = (event) => {
				const info = dragState.info;
				const source = dragState.header === null ? null : workspaceInfoOf(dragState.header);
				resetDrag();
				if (info === null) return;
				const header = closestRow(event.target, WORKSPACE_ROW);
				if (header === null) return;
				const target = workspaceInfoOf(header);
				if (target === null) return;
				if (source !== null && source.workspaceId === target.workspaceId) return; // 同区排序
				event.preventDefault();
				event.stopImmediatePropagation();
				ui.set({
					dialog: {
						kind: 'move',
						sessionId: info.id,
						title: info.title,
						sourceTitle: source?.label ?? '',
						targetWorkspaceId: target.workspaceId,
						targetTitle: target.label || '目标工作区'
					}
				});
			};

			const onDragEnd = () => resetDrag();

			document.addEventListener('dragstart', onDragStart, true);
			document.addEventListener('dragover', onDragOver, true);
			document.addEventListener('drop', onDrop, true);
			document.addEventListener('dragend', onDragEnd, true);
			return () => {
				document.removeEventListener('dragstart', onDragStart, true);
				document.removeEventListener('dragover', onDragOver, true);
				document.removeEventListener('drop', onDrop, true);
				document.removeEventListener('dragend', onDragEnd, true);
				resetDrag();
			};
		}
		// #endregion

		// #region 渲染兜底
		/** 渲染崩溃只影响自己这块，不把 fiber 拖下水。 */
		class QuietBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}

			static getDerivedStateFromError() {
				return { failed: true };
			}

			componentDidCatch(error, info) {
				console.error('[workspace-organizer] 侧边栏渲染崩溃，已降级', error, info);
			}

			render() {
				if (this.state.failed) {
					return h(
						'div',
						{ className: 'wso-empty-row' },
						'工作区面板渲染失败；可在底部切回官方视图，或刷新页面重试。'
					);
				}
				return this.props.children;
			}
		}
		// #endregion

		// #region 服务访问（缺失即降级，不抛）
		function safeGet(ctx, name) {
			try {
				return ctx?.get?.(name);
			} catch {
				return undefined;
			}
		}

		function makeNavigator(ctx) {
			const call = (name, fn) => {
				const service = safeGet(ctx, name);
				if (service === undefined || service === null) return undefined;
				try {
					return fn(service);
				} catch (error) {
					console.error(`[workspace-organizer] ${name} 调用失败`, error);
					return undefined;
				}
			};
			return {
				openSession(sessionId) {
					call('uiWorkspace', (service) => service.openSession(sessionId));
				},
				startSession(workspaceId) {
					call('uiWorkspace', (service) => service.startSession(workspaceId));
				},
				pinSession(sessionId) {
					return call('uiWorkspace', (service) => service.pinSession(sessionId));
				},
				unpinSession(sessionId) {
					return call('uiWorkspace', (service) => service.unpinSession(sessionId));
				},
				archiveSession(sessionId, options) {
					return call('uiWorkspace', (service) => service.archiveSession(sessionId, options));
				},
				unarchiveSession(sessionId) {
					return call('uiWorkspace', (service) => service.unarchiveSession(sessionId));
				},
				signOff(sessionId) {
					return call('uiWorkspace', (service) => service.forkSession(sessionId));
				},
				createWorkspace() {
					const ui = safeGet(ctx, 'uiWorkspace');
					const workspaces = safeGet(ctx, 'workspaces');
					if (ui === undefined || workspaces === undefined) return Promise.reject(new Error('工作区服务不可用'));
					const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
					const picked =
						desktop !== undefined && desktop !== null && typeof desktop.pick === 'function'
							? Promise.resolve(desktop.pick())
							: typeof ui.pickDirectory === 'function'
								? Promise.resolve(ui.pickDirectory())
								: Promise.reject(new Error('没有可用的目录选择器'));
					return picked.then((path) => {
						if (path === null || path === undefined || path === '') return null;
						return workspaces.create({ path });
					});
				},
				renameWorkspace(workspaceId, title) {
					return call('workspaces', (service) => service.rename(workspaceId, title));
				},
				// ---- 文件夹（收纳）RPC：全部走 Host sidecar，不改 cwd ----
				moveSession(sessionId, targetWorkspaceId) {
					return rpc('organizer.move', { sessionId, targetWorkspaceId });
				},
				reorderWorkspace(workspaceId, beforeWorkspaceId) {
					return rpc('organizer.reorderWorkspace', { workspaceId, beforeWorkspaceId });
				},
				loadFolders() {
					return rpc('organizer.folders.state', {});
				},
				createFolder(workspaceId, name, color) {
					return rpc('organizer.folders.create', { workspaceId, name, color: color || undefined });
				},
				updateFolder(folderId, patch) {
					return rpc('organizer.folders.update', Object.assign({ folderId }, patch));
				},
				deleteFolder(folderId) {
					return rpc('organizer.folders.delete', { folderId });
				},
				addToFolder(folderId, sessionId, beforeSessionId) {
					return rpc('organizer.folders.add', {
						folderId,
						sessionId,
						beforeSessionId: beforeSessionId === undefined ? undefined : beforeSessionId
					});
				},
				removeFromFolder(sessionId) {
					return rpc('organizer.folders.remove', { sessionId });
				},
				reorderInFolder(folderId, sessionId, beforeSessionId) {
					return rpc('organizer.folders.reorder', {
						folderId,
						sessionId,
						beforeSessionId: beforeSessionId === undefined ? undefined : beforeSessionId
					});
				},
				setOrder(workspaceId, items) {
					return rpc('organizer.folders.order', { workspaceId, items });
				},
				renameSession(sessionId, title) {
					const sessions = safeGet(ctx, 'sessions');
					if (sessions === undefined || sessions === null || typeof sessions.using !== 'function') {
						return Promise.reject(new Error('sessions 服务不可用'));
					}
					return Promise.resolve(
						sessions.using(sessionId, { source: 'workspaceOperation' }, (reference) => reference.binding.session.rename(title))
					).then((result) => {
						if (result !== null && typeof result === 'object' && result.ok === false) {
							throw new Error(result.error?.message ?? '重命名失败');
						}
						return result;
					});
				},
				deleteWorkspace(workspaceId) {
					return call('workspaces', (service) => service.delete(workspaceId));
				}
			};
		}

		function makeLocaleT(ctx) {
			const locale = safeGet(ctx, 'locale');
			if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
				try {
					const bound = locale.bind(WORKSPACE_NS);
					return (key, params) => {
						try {
							return bound(key, params);
						} catch {
							return key;
						}
					};
				} catch {
					/* 继续用 fallback */
				}
			}
			return (key) => key;
		}

		function guarded(what, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`[workspace-organizer] ${what} 注册失败，已放弃该座位`, error);
				return undefined;
			}
		}
		// #endregion

		// #region 文件夹接口占位（M2/M3 接入；成本聚合从这里取成员）
		/**
		 * 某文件夹下所有 Session ID。
		 * Host 侧同名导出是同步的；浏览器侧只能走 RPC（异步）。
		 */
		async function getSessionsInFolder(folderId) {
			const result = await rpc('organizer.folders.sessions', { folderId });
			return Array.isArray(result?.sessionIds) ? result.sessionIds : [];
		}
		// #endregion

		const inject = ['connection', 'slots'];

		function apply(ctx) {
			hostCtx = ctx;
			try {
				connection = ctx.connection ?? null;
			} catch {
				connection = null;
			}

			const slots = ctx.slots;
			if (slots === undefined || slots === null || typeof slots.register !== 'function') {
				console.error('[workspace-organizer] slots 服务不可用，侧边栏接管已跳过');
				return;
			}

			const navigator = makeNavigator(ctx);
			moduleNavigator = navigator;
			const t = makeLocaleT(ctx);

			const pickStore = (name) => {
				const service = safeGet(ctx, name);
				const store = service?.list;
				return store !== undefined && store !== null && typeof store.subscribe === 'function' && typeof store.getSnapshot === 'function'
					? store
					: null;
			};
			// 快照 store 惰性解析：正常情况下 ui-runtime 先于本插件提供
			// sessions/workspaces，apply 时一定拿得到；但「读一次就定终身」
			// 会把任何时序意外放大成永久失效，所以保留一个可重试的解析点，
			// 由 sync() 在槽位声明/视图状态变化时再试。
			let workspacesStore = pickStore('workspaces');
			let sessionsStore = pickStore('sessions');
			const resolveStores = () => {
				if (workspacesStore === null) workspacesStore = pickStore('workspaces');
				if (sessionsStore === null) sessionsStore = pickStore('sessions');
				return workspacesStore !== null && sessionsStore !== null;
			};
			const canTakeOver = resolveStores();
			if (!canTakeOver) {
				console.error('[workspace-organizer] workspaces/sessions 快照不可用，侧边栏接管暂缓（等槽位声明/视图变化再试）');
			}

			const readSeats = () => ({
				menu: seatEntriesReader(ctx, 'sidebar.workspaces.session.menu.item'),
				action: seatEntriesReader(ctx, 'sidebar.workspaces.session.row.action'),
				leading: seatEntriesReader(ctx, 'sidebar.session.row.leading'),
				hover: seatEntriesReader(ctx, 'sidebar.session.row.hover')
			});

			const injectedProps = () => ({
				workspacesStore,
				sessionsStore,
				nav: navigator,
				readSeats,
				t,
				expandSidebar: () => {
					const layout = safeGet(ctx, 'layout');
					if (layout !== undefined && typeof layout.expandSidebar === 'function') layout.expandSidebar();
				}
			});

			const BrowserWithBoundary = (props) =>
				h(QuietBoundary, null, h(TreeBrowser, Object.assign({}, props, injectedProps())));

			// ---- 接管 sidebar.workspaces（priority -1，影子渲染） ----
			//
			// 槽位声明者是 ui-sidebar：它的 inject 是
			// ['slots','layout','sessions','workspaces','locale']，而本插件只需要
			// ['connection','slots'] —— 冷启动时**必然先于** ui-sidebar 激活。
			// 因此不能只「apply 时读一次 spec」，必须等声明出现。
			//
			// 等待只能用官方 `slots.inject(key, callback)`：SlotRegistry 只在
			// 服务面上暴露 inject/spec/entries/entriesOfSlot/register，
			// **没有** subscribeDeclaration / specDynamic。此前用
			// subscribeDeclaration 做兜底，真实环境里该函数不存在（undefined），
			// 于是「槽位晚于本插件声明」时永久放弃接管，只有重载插件
			//（此时页面已完全加载、槽位早已声明）才恢复。
			ctx.effect(() => {
				let disposeRegistration;
				let takeoverFailed = false;

				const release = () => {
					if (disposeRegistration === undefined) return;
					const dispose = disposeRegistration;
					disposeRegistration = undefined;
					try {
						dispose();
					} catch (error) {
						console.error('[workspace-organizer] 注销 sidebar.workspaces 失败', error);
					}
				};

				const declared = () =>
					typeof slots.spec === 'function'
						? slots.spec('sidebar.workspaces')
						: typeof slots.specDynamic === 'function'
							? slots.specDynamic('sidebar.workspaces')
							: undefined;

				const sync = () => {
					if (takeoverFailed) return;
					// store 仍缺失时不注册：等 slots.inject 的声明回调或视图变化再试。
					if (!resolveStores()) return;
					const wanted = getViewState().mode !== 'native';
					if (wanted && disposeRegistration === undefined) {
						// 槽位还没声明：交给下面的 slots.inject 等声明，声明出现时会再调 sync。
						if (declared() === undefined) return;
						disposeRegistration = guarded('sidebar.workspaces', () =>
							slots.register(
								{
									name: 'sidebar.workspaces',
									priority: -1,
									registrant: PLUGIN
								},
								BrowserWithBoundary
							)
						);
						// 注册真的失败（不是槽位未声明）就放弃接管：官方 priority 0 继续渲染。
						if (disposeRegistration === undefined) takeoverFailed = true;
					} else if (!wanted) {
						release();
					}
				};

				const unsubscribe = subscribeView(sync);

				// 声明生命周期等待：声明存在时立刻执行（同步），折叠时调我们返回的
				// disposer；再次声明会重新执行。这是 SlotRegistry 唯一的「等槽位」API。
				let disposeWait;
				if (typeof slots.inject === 'function') {
					try {
						disposeWait = slots.inject('sidebar.workspaces', () => {
							takeoverFailed = false;
							sync();
							return () => release();
						});
					} catch (error) {
						console.error('[workspace-organizer] 等待 sidebar.workspaces 声明失败，侧边栏接管已跳过', error);
					}
				} else if (typeof slots.subscribeDeclaration === 'function') {
					// 兼容将来/测试替身：老路径。
					disposeWait = slots.subscribeDeclaration('sidebar.workspaces', sync);
				}

				sync();
				return () => {
					unsubscribe();
					if (typeof disposeWait === 'function') {
						try {
							disposeWait();
						} catch {
							/* 卸载期失败无妨 */
						}
					}
					release();
				};
			}, 'workspace-organizer: sidebar takeover');

			// ---- shell.overlay：对话框 + Toast ----
			ctx.effect(
				() =>
					guarded('shell.overlay', () =>
						slots.inject('shell.overlay', () =>
							slots.register({ name: 'shell.overlay', id: 'workspace-organizer-overlay', order: 60 }, OverlayHost)
						)
					),
				'workspace-organizer: overlay seat'
			);

			// ---- 会话菜单：移到文件夹 / 删除 ----
			ctx.effect(
				() =>
					guarded('sidebar.workspaces.session.menu.item', () =>
						slots.inject('sidebar.workspaces.session.menu.item', () =>
							slots.register(
								{ name: 'sidebar.workspaces.session.menu.item', id: 'workspace-organizer-folder', order: 880 },
								SessionFolderMenuItem
							)
						)
					),
				'workspace-organizer: folder menu seat'
			);
			ctx.effect(
				() =>
					guarded('sidebar.workspaces.session.menu.item', () =>
						slots.inject('sidebar.workspaces.session.menu.item', () =>
							slots.register(
								{ name: 'sidebar.workspaces.session.menu.item', id: 'workspace-organizer-delete', order: 900 },
								SessionDeleteMenuItem
							)
						)
					),
				'workspace-organizer: session menu seat'
			);

			// ---- 底栏：与官方 stats 并列的独立条目（当前会话花费） ----
			//
			// conversation.composer.dock 是 list 槽、渲染进 flex 行。官方 stats
			// 用默认 priority 0 / order 0；这里用独立 id 'workspace-organizer-cost' / order 10 并列
			// 注册 —— 不影子、不遮蔽官方条目，于是「StatsPills（轮步/tok/s、
			// token/缓存命中）→ 花费徽章 → ContextMeter」的视觉顺序天然成立，
			// 且官方统计永远由官方自己渲染。
			ctx.effect(
				() =>
					guarded('conversation.composer.dock', () =>
						slots.inject('conversation.composer.dock', () =>
							slots.register(
								{
									name: 'conversation.composer.dock',
									id: 'workspace-organizer-cost',
									order: 10,
									locale: 'chat',
									registrant: PLUGIN
								},
								SessionCostBadge
							)
						)
					),
				'workspace-organizer: composer cost seat'
			);

			// ---- 侧栏底部：回收站 + 切换官方视图 ----
			ctx.effect(
				() =>
					guarded('sidebar.footer.action', () =>
						slots.inject('sidebar.footer.action', () =>
							slots.register({ name: 'sidebar.footer.action', id: 'workspace-organizer-trash', order: 40 }, TrashFooterAction)
						)
					),
				'workspace-organizer: trash footer seat'
			);
			ctx.effect(
				() =>
					guarded('sidebar.footer.action', () =>
						slots.inject('sidebar.footer.action', () =>
							slots.register({ name: 'sidebar.footer.action', id: 'workspace-organizer-view', order: 50 }, ViewToggleFooterAction)
						)
					),
				'workspace-organizer: view footer seat'
			);

			// ---- 跨区移动：拖拽桥（只在接管模式下安装，随视图切换装卸） ----
			ctx.effect(() => {
				let disposeBridge = null;
				const sync = () => {
					const wanted = getViewState().mode !== 'native';
					if (wanted && disposeBridge === null) disposeBridge = installDragBridge();
					else if (!wanted && disposeBridge !== null) {
						disposeBridge();
						disposeBridge = null;
					}
				};
				const unsubscribe = subscribeView(sync);
				sync();
				return () => {
					unsubscribe();
					if (disposeBridge !== null) {
						disposeBridge();
						disposeBridge = null;
					}
				};
			}, 'workspace-organizer: drag bridge');
		}

		exports.name = PLUGIN;
		exports.inject = inject;
		exports.apply = apply;
		exports.CHANNEL = CHANNEL;
		exports.ui = ui;
		// 「文件夹总计花费」等聚合模块的接口：返回该文件夹下所有 Session ID。
		exports.getSessionsInFolder = getSessionsInFolder;
		return module.exports;
	}
});
