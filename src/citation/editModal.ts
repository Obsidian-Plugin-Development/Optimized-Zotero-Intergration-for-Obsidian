/**
 * v6.1.0 引注编辑/插入双模模态框 — 富文本卡片 + 拖拽排序
 *
 * 双模式复用同一个 Modal：
 *   - 编辑模式（editRange 存在）：富文本卡片展示 citekey 元数据，保存时 view.dispatch 精准替换原坐标
 *   - 插入模式（editRange 为空）：卡片初始为空，保存时在光标处插入新引注
 *
 * 富文本卡片：
 *   - 拖拽手柄 (grip-vertical) + 编号徽章 + 作者/年份/标题/期刊 + 删除按钮
 *   - 异步加载元数据：缓存命中即时渲染，未命中显示占位 + 后台轮询
 *   - HTML5 DragEvent 拖拽排序，保存时按显示顺序组装 Pandoc 语法
 */
import { Modal, setIcon } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type ZoteroConnector from '../main';
import {
	extractAuthorsSmart,
	extractYear,
	extractJournalSmart,
} from '../bbt/smartExtractors';

/** BBT picker 返回的 citekey 对象 */
interface CiteKeyObj {
	key: string;
	library: number;
}

/**
 * 动态导入 getCiteKeys — 避免循环依赖。
 * getCiteKeys 位于 src/bbt/cayw.ts，依赖 BBT JSON-RPC，
 * 仅在用户点击「添加文献」时才触发 import。
 */
let _getCiteKeys: ((database: { database: string; port: number }) => Promise<CiteKeyObj[]>) | null = null;
async function loadGetCiteKeys() {
	if (!_getCiteKeys) {
		const mod = await import('../bbt/cayw');
		_getCiteKeys = mod.getCiteKeys;
	}
	return _getCiteKeys;
}

const POLL_INTERVAL_MS = 200;
const MAX_POLL_TIME_MS = 15000;
const TITLE_MAX_LEN = 60;

/**
 * 从 CSL-JSON 条目提取第一作者（纯文本，剥离标记字符）。
 */
function extractFirstAuthor(item: any): string {
	const authors = extractAuthorsSmart(item);
	if (authors.length === 0) return '';
	return authors[0].replace(/[\u2021\u2709\uFE0E]/g, '').trim();
}

/**
 * 清洗标题：剥离 markdown 链接语法，截断过长文本。
 */
function cleanTitle(item: any, key: string): string {
	let title = item.title || '';
	// 剥离 markdown 链接: [text](url)
	title = title.replace(/^\[/, '').replace(/\]\(.*\)$/, '');
	if (!title) return `@${key}`;
	if (title.length > TITLE_MAX_LEN) title = title.slice(0, TITLE_MAX_LEN - 3) + '...';
	return title;
}

export class CitationEditModal extends Modal {
	private citeKeys: string[];
	private cardContainer!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private addBtn!: HTMLButtonElement;
	private startIndex: number;
	private loadingIntervals = new Map<string, ReturnType<typeof setInterval>>();
	/** 记录哪些 citekey 是历史引用（在当前编辑位置之前已出现过） */
	private lockedKeys = new Set<string>();

	constructor(
		app: ZoteroConnector['app'],
		private readonly plugin: ZoteroConnector,
		private readonly view: EditorView,
		private readonly range?: { from: number; to: number },
		initialKeys: string[] = [],
		startIndex: number = 1,
	) {
		super(app);
		this.citeKeys = [...initialKeys];
		this.startIndex = startIndex;

		// 计算哪些 citekey 是历史引用（锁定状态）
		this.computeLockedKeys();
	}

	/**
	 * 计算哪些 citekey 是历史引用（在当前编辑位置之前已出现过）。
	 * 这些文献不允许拖拽改变顺序。
	 */
	private computeLockedKeys() {
		if (!this.range) {
			// 插入模式：所有文献都是新增的，无锁定
			this.lockedKeys.clear();
			return;
		}

		const docText = this.view.state.doc.toString();
		const editPosition = this.range.from;
		const pattern = /\[@([^\]]+)\]/g;
		let match: RegExpExecArray | null;

		// 扫描编辑位置之前的所有引注
		while ((match = pattern.exec(docText)) !== null) {
			if (match.index >= editPosition) break;

			const keys = match[1]
				.split(';')
				.map((s) => s.trim().replace(/^@/, ''))
				.filter(Boolean);

			for (const key of keys) {
				// 如果这个 key 在当前编辑的引注中，且之前已出现过，则标记为锁定
				if (this.citeKeys.includes(key)) {
					this.lockedKeys.add(key);
				}
			}
		}
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('citation-edit-modal');

		// ── 标题栏 ──
		const header = contentEl.createDiv('citation-edit-header');
		header.style.cssText = [
			'display: flex',
			'align-items: center',
			'justify-content: space-between',
			'margin-bottom: 16px',
			'padding-bottom: 10px',
			'border-bottom: 1px solid var(--background-modifier-border)',
		].join(';');

		const title = header.createEl('h3');
		title.setText(this.range ? '编辑引注' : '插入引注');
		title.style.cssText = 'margin: 0; font-size: 16px; font-weight: 600;';

		// ── 卡片区域 ──
		const cardSection = contentEl.createDiv();
		cardSection.style.cssText = 'margin-bottom: 16px;';

		const cardLabel = cardSection.createEl('div');
		cardLabel.setText('已选文献');
		cardLabel.style.cssText =
			'font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;';

		this.cardContainer = cardSection.createDiv('citation-edit-cards');

		// ── 操作按钮区 ──
		const actions = contentEl.createDiv();
		actions.style.cssText = [
			'display: flex',
			'gap: 8px',
			'align-items: center',
			'margin-top: 20px',
			'padding-top: 14px',
			'border-top: 1px solid var(--background-modifier-border)',
		].join(';');

		// 添加文献按钮
		this.addBtn = actions.createEl('button');
		this.addBtn.setText('+ 添加文献');
		this.addBtn.style.cssText = [
			'flex: 1',
			'padding: 8px 16px',
			'border-radius: 6px',
			'border: 1px dashed var(--interactive-accent)',
			'background: transparent',
			'color: var(--interactive-accent)',
			'cursor: pointer',
			'font-size: 13px',
			'font-weight: 500',
		].join(';');
		this.addBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onAddCiteKeys();
		});

		// 保存按钮
		this.saveBtn = actions.createEl('button');
		this.saveBtn.setText('保存');
		this.saveBtn.style.cssText = [
			'padding: 8px 24px',
			'border-radius: 6px',
			'border: none',
			'background: var(--interactive-accent)',
			'color: var(--text-on-accent)',
			'cursor: pointer',
			'font-size: 13px',
			'font-weight: 600',
		].join(';');
		this.saveBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onSave();
		});

		// 关闭按钮
		const closeBtn = actions.createEl('button');
		closeBtn.setText('取消');
		closeBtn.style.cssText = [
			'padding: 8px 16px',
			'border-radius: 6px',
			'border: 1px solid var(--background-modifier-border)',
			'background: var(--background-secondary)',
			'color: var(--text-muted)',
			'cursor: pointer',
			'font-size: 13px',
		].join(';');
		closeBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.close();
		});

		// 键盘快捷键：Ctrl+Enter 保存
		this.scope.register([], 'Enter', (evt: KeyboardEvent) => {
			if (evt.ctrlKey || evt.metaKey) {
				evt.preventDefault();
				this.onSave();
				return false;
			}
			return true;
		});

		// 键盘快捷键：Escape 关闭
		this.scope.register([], 'Escape', () => {
			this.close();
			return false;
		});

		// DOM 就绪后渲染卡片
		this.renderCards();
	}

	onClose() {
		this.clearLoadingIntervals();
		const { contentEl } = this;
		contentEl.empty();
	}

	// ── 轮询清理 ──

	private clearLoadingIntervals() {
		for (const id of this.loadingIntervals.values()) {
			clearInterval(id);
		}
		this.loadingIntervals.clear();
	}

	// ── 卡片渲染 ──

	private renderCards(scrollToBottom = false) {
		this.clearLoadingIntervals();
		this.cardContainer.empty();

		if (this.citeKeys.length === 0) {
			const empty = this.cardContainer.createEl('span');
			empty.setText('暂无文献，请点击「+ 添加文献」');
			empty.style.cssText =
				'color: var(--text-faint); font-style: italic; font-size: 12px; padding: 12px 0; display: block; text-align: center;';
			this.updateSaveButton();
			return;
		}

		const engine = this.plugin.citationEngine;
		const missingKeys: string[] = [];

		// ★ 按全局序号排序显示（不改变 this.citeKeys 的顺序）
		const sortedEntries = this.citeKeys
			.map((key, index) => ({
				key,
				index,
				globalNumber: engine.getNumber(key),
			}))
			.sort((a, b) => {
				// 序号为 0 的放最后
				if (a.globalNumber === 0 && b.globalNumber === 0) return 0;
				if (a.globalNumber === 0) return 1;
				if (b.globalNumber === 0) return -1;
				return a.globalNumber - b.globalNumber;
			});

		for (const entry of sortedEntries) {
			const { key, index } = entry;
			const item = engine.getIndividualJsonCached(key);

			if (item) {
				this.renderCard(index, key, 0, item);
			} else {
				missingKeys.push(key);
				this.renderPlaceholderCard(index, key, 0);
			}
		}

		if (missingKeys.length > 0) {
			engine.precacheAllBibs(missingKeys);
			this.startPollingForMetadata(missingKeys);
		}

		this.updateSaveButton();

		// ★ 新增文献后自动滚动至底部，确保新卡片可见
		if (scrollToBottom) {
			requestAnimationFrame(() => {
				this.cardContainer.scrollTop = this.cardContainer.scrollHeight;
			});
		}
	}

	/**
	 * 渲染富文本卡片（缓存命中）。
	 *
	 * ⚠️ 关键：displayNumber 参数被忽略！
	 * 序号必须从全局 CitationEngine 获取，绝不使用局部索引。
	 */
	private renderCard(index: number, key: string, _ignoredNumber: number, item: any) {
		const isLocked = this.lockedKeys.has(key);

		// ★ 从全局 Registry 获取序号（SSOT - Single Source of Truth）
		const globalNumber = this.plugin.citationEngine.getNumber(key);

		const card = this.cardContainer.createDiv('citation-edit-card');
		card.setAttribute('data-index', String(index));
		card.setAttribute('data-key', key);
		if (isLocked) {
			card.addClass('is-locked-citation');
		}

		// 拖拽手柄
		const handle = card.createSpan('citation-edit-card-handle');
		setIcon(handle, 'grip-vertical');
		if (!isLocked) {
			handle.draggable = true;
			this.attachDragEvents(handle, card, index, key);
		} else {
			handle.draggable = false;
			handle.title = '此文献在之前已引用，不可拖拽';
		}

		// 编号徽章 - 使用全局序号
		const badge = card.createSpan('citation-edit-card-number');
		if (isLocked) {
			badge.addClass('is-locked');
		}
		badge.setText(globalNumber > 0 ? `[${globalNumber}]` : '[?]');

		// 元数据主体
		const body = card.createDiv('citation-edit-card-body');

		// ★ Citekey 置顶（加粗）
		const citekeyEl = body.createSpan('citation-edit-card-citekey');
		citekeyEl.setText(`[@${key}]`);

		// 标题全显（自然换行）
		const titleEl = body.createSpan('citation-edit-card-title');
		titleEl.setText(cleanTitle(item, key));

		// 底层元数据（作者、年份、期刊）
		const metaMinimal = body.createDiv('citation-edit-card-meta-minimal');
		const authorText = extractFirstAuthor(item) || '';
		const yearText = extractYear(item);
		const journalText = extractJournalSmart(item);
		const parts: string[] = [];
		if (authorText) parts.push(authorText);
		if (yearText) parts.push(`(${yearText})`);
		if (journalText) parts.push(journalText);
		metaMinimal.setText(parts.join(' • '));

		// 删除按钮
		const deleteBtn = card.createSpan('citation-edit-card-delete');
		deleteBtn.setText('\u00D7');
		deleteBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.removeCiteKey(key);
		});
	}

	/**
	 * 渲染占位卡片（缓存未命中）。
	 *
	 * ⚠️ 关键：displayNumber 参数被忽略！
	 * 序号必须从全局 CitationEngine 获取，绝不使用局部索引。
	 */
	private renderPlaceholderCard(index: number, key: string, _ignoredNumber: number) {
		const isLocked = this.lockedKeys.has(key);

		// ★ 从全局 Registry 获取序号（SSOT）
		const globalNumber = this.plugin.citationEngine.getNumber(key);

		const card = this.cardContainer.createDiv(
			'citation-edit-card citation-edit-card-loading',
		);
		card.setAttribute('data-index', String(index));
		card.setAttribute('data-key', key);
		if (isLocked) {
			card.addClass('is-locked-citation');
		}

		// 拖拽手柄（占位卡片也可拖拽，除非锁定）
		const handle = card.createSpan('citation-edit-card-handle');
		setIcon(handle, 'grip-vertical');
		if (!isLocked) {
			handle.draggable = true;
			this.attachDragEvents(handle, card, index, key);
		} else {
			handle.draggable = false;
			handle.title = '此文献在之前已引用，不可拖拽';
		}

		// 编号徽章 - 使用全局序号
		const badge = card.createSpan('citation-edit-card-number');
		if (isLocked) {
			badge.addClass('is-locked');
		}
		badge.setText(globalNumber > 0 ? `[${globalNumber}]` : '[?]');

		// 占位内容
		const body = card.createDiv('citation-edit-card-body');
		const citekeyEl = body.createSpan('citation-edit-card-citekey');
		citekeyEl.setText(`[@${key}]`);
		const loadingEl = body.createSpan('citation-edit-card-title');
		loadingEl.setText('加载中...');

		// 删除按钮
		const deleteBtn = card.createSpan('citation-edit-card-delete');
		deleteBtn.setText('\u00D7');
		deleteBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.removeCiteKey(key);
		});
	}

	/**
	 * 构建富卡片元素（用于更新单个占位卡片）。
	 *
	 * ⚠️ 关键：displayNumber 参数被忽略！
	 * 序号必须从全局 CitationEngine 获取，绝不使用局部索引。
	 */
	private buildCardElement(index: number, key: string, _ignoredNumber: number, item: any): HTMLElement {
		const isLocked = this.lockedKeys.has(key);

		// ★ 从全局 Registry 获取序号（SSOT）
		const globalNumber = this.plugin.citationEngine.getNumber(key);

		const card = createDiv('citation-edit-card');
		card.setAttribute('data-index', String(index));
		card.setAttribute('data-key', key);
		if (isLocked) {
			card.addClass('is-locked-citation');
		}

		const handle = card.createSpan('citation-edit-card-handle');
		setIcon(handle, 'grip-vertical');
		if (!isLocked) {
			handle.draggable = true;
			this.attachDragEvents(handle, card, index, key);
		} else {
			handle.draggable = false;
			handle.title = '此文献在之前已引用，不可拖拽';
		}

		const badge = card.createSpan('citation-edit-card-number');
		if (isLocked) {
			badge.addClass('is-locked');
		}
		badge.setText(globalNumber > 0 ? `[${globalNumber}]` : '[?]');

		const body = card.createDiv('citation-edit-card-body');

		// Citekey 置顶
		const citekeyEl = body.createSpan('citation-edit-card-citekey');
		citekeyEl.setText(`[@${key}]`);

		// 标题全显
		const titleEl = body.createSpan('citation-edit-card-title');
		titleEl.setText(cleanTitle(item, key));

		// 底层元数据
		const metaMinimal = body.createDiv('citation-edit-card-meta-minimal');
		const authorText = extractFirstAuthor(item) || '';
		const yearText = extractYear(item);
		const journalText = extractJournalSmart(item);
		const parts: string[] = [];
		if (authorText) parts.push(authorText);
		if (yearText) parts.push(`(${yearText})`);
		if (journalText) parts.push(journalText);
		metaMinimal.setText(parts.join(' • '));

		const deleteBtn = card.createSpan('citation-edit-card-delete');
		deleteBtn.setText('\u00D7');
		deleteBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.removeCiteKey(key);
		});

		return card;
	}

	// ── 拖拽事件 ──

	private attachDragEvents(handle: HTMLElement, card: HTMLElement, index: number, key: string) {
		// ★ Bug Fix #2: 确保新文献可以拖拽
		// 注意：此方法只会被非锁定文献调用，所以不需要再次检查 isLocked

		handle.addEventListener('dragstart', (e: DragEvent) => {
			e.dataTransfer!.effectAllowed = 'move';
			e.dataTransfer!.setData('text/plain', String(index));
			card.addClass('is-dragging');
		});

		handle.addEventListener('dragend', () => {
			card.removeClass('is-dragging');
			this.cardContainer.querySelectorAll('.zt-drag-over').forEach(
				(el) => el.removeClass('zt-drag-over'),
			);
		});

		card.addEventListener('dragover', (e: DragEvent) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'move';
			card.addClass('zt-drag-over');
		});

		card.addEventListener('dragleave', () => {
			card.removeClass('zt-drag-over');
		});

		card.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			card.removeClass('zt-drag-over');

			const fromIndex = parseInt(e.dataTransfer!.getData('text/plain'), 10);
			if (isNaN(fromIndex) || fromIndex === index) return;

			const movedKey = this.citeKeys[fromIndex];
			const targetKey = this.citeKeys[index];

			// ★★★ 严格检查：禁止拖拽历史文献 ★★★
			if (this.lockedKeys.has(movedKey)) {
				// 被拖拽的文献是历史引用，显示红色警告
				new Notice('⛔ 此文献在之前已引用，不可改变顺序！', 3000);
				return;
			}

			if (this.lockedKeys.has(targetKey)) {
				// 目标位置的文献是历史引用，显示红色警告
				new Notice('⛔ 不能拖拽到历史引用文献的位置！', 3000);
				return;
			}

			const [moved] = this.citeKeys.splice(fromIndex, 1);
			this.citeKeys.splice(index, 0, moved);
			this.renderCards();
		});
	}

	// ── 异步元数据轮询 ──

	private startPollingForMetadata(keys: string[]) {
		const engine = this.plugin.citationEngine;
		const startTime = Date.now();

		for (const key of keys) {
			// 跳过已经在轮询中的 key
			if (this.loadingIntervals.has(key)) continue;

			const intervalId = setInterval(() => {
				const item = engine.getIndividualJsonCached(key);
				if (item) {
					clearInterval(intervalId);
					this.loadingIntervals.delete(key);
					this.updateSingleCard(key, item);
					return;
				}
				if (Date.now() - startTime > MAX_POLL_TIME_MS) {
					clearInterval(intervalId);
					this.loadingIntervals.delete(key);
				}
			}, POLL_INTERVAL_MS);

			this.loadingIntervals.set(key, intervalId);
		}
	}

	/**
	 * 单个卡片更新：用富卡片 DOM 替换占位卡片。
	 */
	private updateSingleCard(key: string, item: any) {
		const index = this.citeKeys.indexOf(key);
		if (index === -1) return;

		const placeholder = this.cardContainer.querySelector(
			`.citation-edit-card[data-key="${key}"]`,
		) as HTMLElement | null;
		if (!placeholder) return;

		const number = this.startIndex + index;
		const newCard = this.buildCardElement(index, key, number, item);
		placeholder.replaceWith(newCard);
	}

	// ── 增删 citekey ──

	/**
	 * ★★★ Bug Fix #1: 删除文献后不触发 Registry 重建 ★★★
	 *
	 * 从当前引注中移除文献。
	 * 注意：这只是从局部列表中移除，不影响全局 Registry。
	 * 剩余文献的全局序号保持不变。
	 */
	private removeCiteKey(key: string) {
		this.citeKeys = this.citeKeys.filter((k) => k !== key);
		// ★ 关键：删除后重新计算锁定状态（虽然通常不会改变）
		this.computeLockedKeys();
		this.renderCards();
	}

	/**
	 * ★★★ Bug Fix #2: 添加文献后立即检查锁定状态 ★★★
	 *
	 * 从 Zotero 添加文献到当前引注。
	 * 新添加的文献可能是历史引用，必须立即锁定。
	 */
	private async onAddCiteKeys() {
		try {
			const getCiteKeys = await loadGetCiteKeys();
			const database = {
				database: this.plugin.settings.database,
				port: (this.plugin.settings as any).port,
			};
			const selected = await getCiteKeys(database);
			if (!selected || selected.length === 0) return;

			for (const item of selected) {
				if (!this.citeKeys.includes(item.key)) {
					this.citeKeys.push(item.key);
				}
			}

			// ★★★ 关键修复：添加文献后立即重新计算锁定状态 ★★★
			// 这确保新添加的历史文献立即被锁定，无需关闭弹窗重新打开
			this.computeLockedKeys();

			this.renderCards(true);
		} catch {
			// 用户取消选择或 BBT 不可用
		}
	}

	// ── 保存 ──

	private updateSaveButton() {
		if (!this.saveBtn) return;
		this.saveBtn.disabled = false;
		this.saveBtn.style.opacity = '1';
	}

	/**
	 * 双模式保存
	 *
	 * 编辑模式（range 存在）：重组 Pandoc 语法，view.dispatch 精准替换 [from, to) 范围。
	 * 插入模式（range 为空）：在光标处插入新引注。
	 * 空 citeKeys → 编辑模式替换为空串，插入模式不操作。
	 */
	private onSave() {
		const newText = this.citeKeys.length > 0
			? `[@${this.citeKeys.join('; @')}]`
			: '';

		if (this.range) {
			this.view.dispatch({
				changes: {
					from: this.range.from,
					to: this.range.to,
					insert: newText,
				},
			});
		} else {
			if (!newText) {
				this.close();
				return;
			}
			const pos = this.view.state.selection.main.from;
			this.view.dispatch({
				changes: {
					from: pos,
					to: pos,
					insert: newText,
				},
			});
		}

		// ★★★ 关键：保存后立即重建全局 Registry ★★★
		// 这确保了首次出场文献的拖拽顺序立即反映到全局序号中
		// 从而实现"编辑弹窗 -> 参考文献列表 -> HUD 状态"的三端同步
		requestAnimationFrame(() => {
			this.plugin.citationEngine.scanDocument(this.view);
		});

		this.close();
	}
}
