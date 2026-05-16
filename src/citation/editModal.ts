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
	private loadingIntervals = new Map<string, ReturnType<typeof setInterval>>();

	constructor(
		app: ZoteroConnector['app'],
		private readonly plugin: ZoteroConnector,
		private readonly view: EditorView,
		private readonly range?: { from: number; to: number },
		initialKeys: string[] = [],
	) {
		super(app);
		this.citeKeys = [...initialKeys];
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

	private renderCards() {
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

		for (let i = 0; i < this.citeKeys.length; i++) {
			const key = this.citeKeys[i];
			const item = engine.getIndividualJsonCached(key);
			const number = engine.getNumber(key) || 0;

			if (item) {
				this.renderCard(i, key, number, item);
			} else {
				missingKeys.push(key);
				this.renderPlaceholderCard(i, key, number);
			}
		}

		if (missingKeys.length > 0) {
			engine.precacheAllBibs(missingKeys);
			this.startPollingForMetadata(missingKeys);
		}

		this.updateSaveButton();
	}

	/**
	 * 渲染富文本卡片（缓存命中）。
	 */
	private renderCard(index: number, key: string, number: number, item: any) {
		const card = this.cardContainer.createDiv('citation-edit-card');
		card.setAttribute('data-index', String(index));
		card.setAttribute('data-key', key);

		// 拖拽手柄
		const handle = card.createSpan('citation-edit-card-handle');
		setIcon(handle, 'grip-vertical');
		handle.draggable = true;
		this.attachDragEvents(handle, card, index);

		// 编号徽章
		const badge = card.createSpan('citation-edit-card-number');
		badge.setText(number > 0 ? `[${number}]` : '[?]');

		// 元数据主体
		const body = card.createDiv('citation-edit-card-body');

		const metaRow = body.createDiv('citation-edit-card-meta');
		const authorEl = metaRow.createSpan('citation-edit-card-author');
		authorEl.setText(extractFirstAuthor(item) || `@${key}`);
		const yearEl = metaRow.createSpan('citation-edit-card-year');
		const yearText = extractYear(item);
		if (yearText) yearEl.setText(`(${yearText})`);

		const titleEl = body.createSpan('citation-edit-card-title');
		titleEl.setText(cleanTitle(item, key));

		const journalText = extractJournalSmart(item);
		if (journalText) {
			const journalEl = body.createSpan('citation-edit-card-journal');
			journalEl.setText(journalText);
		}

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
	 */
	private renderPlaceholderCard(index: number, key: string, number: number) {
		const card = this.cardContainer.createDiv(
			'citation-edit-card citation-edit-card-loading',
		);
		card.setAttribute('data-index', String(index));
		card.setAttribute('data-key', key);

		// 拖拽手柄（占位卡片也可拖拽）
		const handle = card.createSpan('citation-edit-card-handle');
		setIcon(handle, 'grip-vertical');
		handle.draggable = true;
		this.attachDragEvents(handle, card, index);

		// 编号徽章
		const badge = card.createSpan('citation-edit-card-number');
		badge.setText(number > 0 ? `[${number}]` : '[?]');

		// 占位内容
		const body = card.createDiv('citation-edit-card-body');
		const nameEl = body.createSpan('citation-edit-card-author');
		nameEl.setText(`@${key}`);
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
	 */
	private buildCardElement(index: number, key: string, number: number, item: any): HTMLElement {
		const card = createDiv('citation-edit-card');
		card.setAttribute('data-index', String(index));
		card.setAttribute('data-key', key);

		const handle = card.createSpan('citation-edit-card-handle');
		setIcon(handle, 'grip-vertical');
		handle.draggable = true;
		this.attachDragEvents(handle, card, index);

		const badge = card.createSpan('citation-edit-card-number');
		badge.setText(number > 0 ? `[${number}]` : '[?]');

		const body = card.createDiv('citation-edit-card-body');

		const metaRow = body.createDiv('citation-edit-card-meta');
		const authorEl = metaRow.createSpan('citation-edit-card-author');
		authorEl.setText(extractFirstAuthor(item) || `@${key}`);
		const yearEl = metaRow.createSpan('citation-edit-card-year');
		const yearText = extractYear(item);
		if (yearText) yearEl.setText(`(${yearText})`);

		const titleEl = body.createSpan('citation-edit-card-title');
		titleEl.setText(cleanTitle(item, key));

		const journalText = extractJournalSmart(item);
		if (journalText) {
			const journalEl = body.createSpan('citation-edit-card-journal');
			journalEl.setText(journalText);
		}

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

	private attachDragEvents(handle: HTMLElement, card: HTMLElement, index: number) {
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

		const number = this.plugin.citationEngine.getNumber(key) || 0;
		const newCard = this.buildCardElement(index, key, number, item);
		placeholder.replaceWith(newCard);
	}

	// ── 增删 citekey ──

	private removeCiteKey(key: string) {
		this.citeKeys = this.citeKeys.filter((k) => k !== key);
		this.renderCards();
	}

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
			this.renderCards();
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

		this.close();
	}
}
