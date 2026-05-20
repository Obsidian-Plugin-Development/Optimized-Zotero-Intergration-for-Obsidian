/**
 * v6.2 悬停悬浮卡片管理器 — 零延迟同步渲染
 *
 * ★ 后台预缓存：cm6LivePreview 扫描文档时静默拉取所有 citekey 的
 *   单篇参考文献 HTML + 元数据存入 citationEngine 缓存。
 * ★ 零延迟直读：mouseenter 同步从缓存读取，无 await、无 Loading UI。
 * ★ DOMParser 序号校准：解析 CSL HTML DOM，精准替换默认编号 1 → 全局序号。
 * ★ 单例管理：始终只有一个弹窗，新弹窗先同步销毁旧弹窗。
 */
import { Notice, setIcon, TFile } from 'obsidian';
import type ZoteroConnector from '../main';
import type { CitationEngine } from './citationEngine';
import { CitationEditModal } from './editModal';
import { getActiveEditorView } from './cm6LivePreview';

const HIDE_DELAY_MS = 300;

// ── v7.3: DOMParser 模块级单例复用 ──
const _sharedDOMParser = new DOMParser();

// ── v7.3: vault getFiles() 缓存 ──
let _cachedFiles: TFile[] | null = null;
let _cachedFilesAt = 0;
const FILES_CACHE_TTL_MS = 30_000; // 30 秒

function getVaultFilesCached(plugin: ZoteroConnector): TFile[] {
	const now = Date.now();
	if (_cachedFiles && (now - _cachedFilesAt) < FILES_CACHE_TTL_MS) {
		return _cachedFiles;
	}
	_cachedFiles = plugin.app.vault.getFiles();
	_cachedFilesAt = now;
	return _cachedFiles;
}

// ── DOM 级序号校准 ──

/**
 * 利用 DOMParser 解析 CSL 参考文献 HTML，将单条渲染时
 * CSL 引擎默认生成的编号 "1" （如 [1]、1.、(1)）精准替换为
 * 该文献在正文中的真实全局序号 actualNumber。
 *
 * 查找顺序：
 *   1. .csl-left-margin — CSL margin 编号容器
 *   2. .csl-number      — CSL number span
 *   3. 正文首部 text node — 暴力正则匹配首处编号模式
 *
 * 仅替换首次出现，避免误伤文献标题/日期中的数字 1。
 *
 * ★ v7.3: 使用模块级 DOMParser 单例，避免每次调用 new DOMParser()
 */
function calibrateCitationNumber(html: string, actualNumber: number): string {
	if (!html || actualNumber <= 1) return html;

	const doc = _sharedDOMParser.parseFromString(html, 'text/html');

	// 1. CSL left-margin 容器：<div class="csl-left-margin">[1]</div>
	const leftMargin = doc.querySelector('.csl-left-margin');
	if (leftMargin) {
		const text = leftMargin.textContent?.trim() || '';
		if (text === '[1]') leftMargin.textContent = `[${actualNumber}]`;
		else if (text === '(1)') leftMargin.textContent = `(${actualNumber})`;
		else if (/^1\.$/.test(text)) leftMargin.textContent = `${actualNumber}.`;
		else if (text === '1') leftMargin.textContent = `${actualNumber}`;
		return doc.body.innerHTML;
	}

	// 2. CSL number span：<span class="csl-number">1.</span>
	const cslNumber = doc.querySelector('.csl-number');
	if (cslNumber) {
		const text = cslNumber.textContent?.trim() || '';
		if (text === '[1]') cslNumber.textContent = `[${actualNumber}]`;
		else if (text === '(1)') cslNumber.textContent = `(${actualNumber})`;
		else if (/^1\./.test(text)) cslNumber.textContent = `${actualNumber}.`;
		return doc.body.innerHTML;
	}

	// 3. 遍历 body 下 text node，匹配首部出现的编号模式
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
	let node: Text | null;
	while ((node = walker.nextNode() as Text)) {
		const text = node.textContent || '';
		const trimmed = text.trimStart();
		if (!trimmed) continue;
		const space = text.slice(0, text.length - trimmed.length);

		if (trimmed.startsWith('[1]')) {
			node.textContent = space + `[${actualNumber}]` + trimmed.slice(3);
			break;
		}
		if (trimmed.startsWith('(1)')) {
			node.textContent = space + `(${actualNumber})` + trimmed.slice(3);
			break;
		}
		if (/^1\.\s/.test(trimmed)) {
			node.textContent = space + `${actualNumber}.` + trimmed.slice(2);
			break;
		}
		if (/^1\s/.test(trimmed)) {
			// 最松散模式，仅当数字后为空格
			node.textContent = space + `${actualNumber} ` + trimmed.slice(2);
			break;
		}
	}

	return doc.body.innerHTML;
}

// ── Popover Manager ──

export class CitationPopoverManager {
	private popover: HTMLElement | null = null;
	private hideTimer: ReturnType<typeof setTimeout> | null = null;
	private currentKeys: string[] = [];

	constructor(
		private plugin: ZoteroConnector,
		private engine: CitationEngine,
	) {}

	register() {
		document.body.addEventListener('mouseover', this.onMouseOver, true);
		document.body.addEventListener('mouseout', this.onMouseOut, true);
		document.addEventListener('click', this.onDocClick, true);
		document.addEventListener('keydown', this.onEscape, true);
	}

	unregister() {
		document.body.removeEventListener('mouseover', this.onMouseOver, true);
		document.body.removeEventListener('mouseout', this.onMouseOut, true);
		document.removeEventListener('click', this.onDocClick, true);
		document.removeEventListener('keydown', this.onEscape, true);
		this.hide();
	}

	// ── 事件处理 ──

	private onMouseOver = (e: MouseEvent) => {
		const target = (e.target as HTMLElement).closest('.custom-citation-inline') as HTMLElement | null;
		if (!target) return;

		const keys =
			(target.getAttribute('data-citation-keys') || '')
				.split(',')
				.filter(Boolean);
		if (keys.length === 0) return;

		// 同一组 key 不重复渲染
		if (this.popover && this.currentKeys.join(',') === keys.join(',')) return;

		// ★ 单例销毁 + 清除隐藏计时器
		this.destroyPopover();
		clearTimeout(this.hideTimer!);
		this.hideTimer = null;

		// ★ 零延迟：同步直读缓存，瞬间渲染
		this.show(target, keys);
	};

	private onMouseOut = (e: MouseEvent) => {
		const related = e.relatedTarget as HTMLElement | null;
		if (!related) {
			this.scheduleHide();
			return;
		}
		if (
			related.closest('.custom-citation-inline') ||
			related.closest('.citation-popover')
		) {
			return;
		}
		this.scheduleHide();
	};

	private onDocClick = (e: MouseEvent) => {
		if (this.popover && !this.popover.contains(e.target as HTMLElement)) {
			this.hide();
		}
	};

	private onEscape = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && this.popover) {
			this.hide();
		}
	};

	private scheduleHide() {
		clearTimeout(this.hideTimer!);
		this.hideTimer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
	}

	// ── 弹窗显示（★ 完全同步，零异步操作）──

	/**
	 * 从缓存同步直读每篇文献的 HTML + 元数据，构建 DOM 并挂载。
	 *
	 * ★ 严禁 await / async / fetch / setTimeout。
	 * ★ 缓存命中 → DOMParser 序号校准 → 瞬间渲染。
	 * ★ 缓存未命中 → 显示 citekey 降级文本 → 后台触发拉取。
	 */
	show(target: HTMLElement, citeKeys: string[]) {
		// 二次确保旧弹窗已销毁（onMouseOver 已调用，此处防御）
		this.destroyPopover();

		// ★★★ Bug Fix #3: 按全局序号排序显示 ★★★
		// 确保详情弹窗中的文献按全局序号从小到大排列
		const sortedKeys = [...citeKeys].sort((a, b) => {
			const numA = this.engine.getNumber(a);
			const numB = this.engine.getNumber(b);
			// 序号为 0 的放最后
			if (numA === 0 && numB === 0) return 0;
			if (numA === 0) return 1;
			if (numB === 0) return -1;
			return numA - numB;
		});

		this.currentKeys = sortedKeys;

		// 弹窗容器（初始透明，挂载后 CSS transition 淡入）
		const popover = document.body.createDiv('citation-popover');
		popover.style.cssText = [
			'position: fixed',
			'z-index: 100000',
			'max-width: 520px',
			'min-width: 340px',
			'background: var(--background-primary)',
			'border: 1px solid var(--background-modifier-border)',
			'border-radius: 12px',
			'box-shadow: var(--shadow-xl)',
			'padding: 12px 14px',
			'font-size: 13px',
			'line-height: 1.6',
			'color: var(--text-normal)',
			'user-select: text',
			'pointer-events: auto',
			// 入场过渡起点
			'opacity: 0',
			'transform: translateY(4px)',
			'transition: opacity 0.12s ease-out, transform 0.12s ease-out',
		].join(';');

		// 悬浮桥：鼠标进入弹窗时取消隐藏
		popover.addEventListener('mouseenter', () => {
			clearTimeout(this.hideTimer!);
			this.hideTimer = null;
		});
		popover.addEventListener('mouseleave', () => {
			this.scheduleHide();
		});

		// ── 标题栏：编辑按钮 ──
		this.renderHeader(popover, target, citeKeys);

		// ── v6.1.0-alpha.1: 上下卡片结构 + 横向 Action Bar ──

		// ★★★ Bug Fix: 使用排序后的 this.currentKeys 而不是原始的 citeKeys ★★★
		for (let i = 0; i < this.currentKeys.length; i++) {
			const key = this.currentKeys[i];
			const bibHtml = this.engine.getIndividualBibHtmlCached(key);
			const meta = this.engine.getIndividualMetaCached(key);

			// 卡片容器 — 上下结构，消除双栏并排留白
			const card = popover.createDiv();
			card.style.cssText = [
				'display: flex',
				'flex-direction: column',
				'gap: 6px',
				i < this.currentKeys.length - 1
					? 'padding-bottom: 10px; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 10px;'
					: '',
			].join(';');

			// 文献文本区域
			const body = card.createDiv();
			body.style.cssText = 'flex: 1; min-width: 0; overflow-wrap: break-word;';

			if (bibHtml) {
				const bibDiv = body.createDiv('csl-entry');
				const globalNum = this.engine.getNumber(key) || 1;
				bibDiv.innerHTML = calibrateCitationNumber(bibHtml, globalNum);
			} else {
				body.setText(`@${key}`);
				body.style.opacity = '0.55';
				body.style.fontStyle = 'italic';
				this.engine.precacheAllBibs([key]);
			}

			// 横向操作按钮栏 — 紧凑排列于文本右下方
			const actions = card.createDiv('citation-actions');
			actions.style.cssText =
				'display: flex; flex-direction: row; justify-content: flex-end; gap: 4px;';

			this.renderNoteButton(actions, key);
			if (meta?.url || meta?.doi) {
				this.renderLinkButton(actions, meta);
			}
			this.renderZoteroButton(actions, key);
		}

		// 挂载 → 定位 → 触发入场过渡
		document.body.appendChild(popover);
		this.popover = popover;
		this.positionPopover(popover, target);

		requestAnimationFrame(() => {
			popover.style.opacity = '1';
			popover.style.transform = 'translateY(0)';
		});
	}

	// ── 按钮渲染 ──

	// ── 标题栏渲染 ──

	/**
	 * 在弹窗顶部渲染标题栏，包含编辑引注按钮。
	 * 读取 target DOM 上的 data-citation-from / data-citation-to 获取坐标，
	 * 从模块级闭包获取当前 EditorView。
	 */
	private renderHeader(popover: HTMLElement, target: HTMLElement, citeKeys: string[]) {
		const header = popover.createDiv();
		header.style.cssText = [
			'display: flex',
			'align-items: center',
			'justify-content: space-between',
			'margin-bottom: 10px',
			'padding-bottom: 8px',
			'border-bottom: 1px solid var(--background-modifier-border)',
		].join(';');

		const label = header.createEl('span');
		label.setText('引注详情');
		label.style.cssText =
			'font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;';

		this.renderEditButton(header, target, citeKeys);
	}

	// ── 编辑按钮 ──

	/**
	 * 渲染编辑引注按钮（pencil 图标）。
	 * 点击时打开 CitationEditModal，传递 view、range、citekeys。
	 */
	private renderEditButton(container: HTMLElement, target: HTMLElement, citeKeys: string[]) {
		const btn = container.createDiv('citation-popover-btn');
		setIcon(btn, 'pencil');
		btn.setAttribute('aria-label', '编辑引注');

		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();

			const view = getActiveEditorView();
			if (!view) {
				new Notice('无法获取编辑器实例', 3000);
				return;
			}

			const fromStr = target.getAttribute('data-citation-from');
			const toStr = target.getAttribute('data-citation-to');
			if (!fromStr || !toStr) {
				new Notice('无法获取引注坐标', 3000);
				return;
			}

			const range = { from: Number(fromStr), to: Number(toStr) };

			// 计算起始序号：第一项在正文中的全局引注编号
			const startIndex = this.engine.getNumber(citeKeys[0]) || 1;

			// 关闭悬浮窗，打开编辑模态框
			this.hide();
			new CitationEditModal(
				this.plugin.app,
				this.plugin,
				view,
				range,
				citeKeys,
				startIndex,
			).open();
		});
	}


	/**
	 * 笔记按钮：在全局根目录（baseStorageFolder）下递归查找 [citekey].md。
	 *
	 * ★ 使用 app.vault.getFiles() 全库遍历 + Array.find() 精准匹配：
	 *   1. 文件名必须完全匹配 citekey.md
	 *   2. 路径必须以 baseStorageFolder 开头（若设置）
	 *   3. baseStorageFolder 为空时搜索整个 vault
	 *
	 * 找到 → 图标高亮，点击打开笔记。
	 * 未找到 → 图标置灰，点击弹出 Notice，禁止自动创建。
	 */
	private renderNoteButton(container: HTMLElement, key: string) {
		const rootDir = (this.plugin.settings as any).baseStorageFolder || '';
		const allFiles = getVaultFilesCached(this.plugin);
		const targetName = `${key}.md`;

		const noteFile = allFiles.find((file) => {
			if (file.name !== targetName) return false;
			if (!rootDir) return true;
			const normalizedRoot = rootDir.endsWith('/') ? rootDir : rootDir + '/';
			return file.path === normalizedRoot + targetName
				|| file.path.startsWith(normalizedRoot);
		});

		const noteExists = !!noteFile;

		const btn = container.createDiv(
			`citation-popover-btn${noteExists ? '' : ' citation-popover-btn-dim'}`,
		);
		setIcon(btn, 'file-text');
		btn.setAttribute('aria-label', noteExists ? 'Open literature note' : 'Note not created');

		btn.addEventListener('click', async (e) => {
			e.stopPropagation();
			e.preventDefault();
			if (noteExists && noteFile) {
				await this.plugin.app.workspace.getLeaf().openFile(noteFile);
				this.hide();
			} else {
				new Notice('该文献的笔记尚未创建！', 3000);
			}
		});
	}

	private renderLinkButton(container: HTMLElement, meta: { doi?: string; url?: string }) {
		const btn = container.createDiv('citation-popover-btn');
		setIcon(btn, 'external-link');
		btn.setAttribute('aria-label', 'Open URL / DOI');

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			const link = meta.url || (meta.doi ? `https://doi.org/${meta.doi}` : '');
			if (link) window.open(link, '_blank');
			this.hide();
		});
	}

	private renderZoteroButton(container: HTMLElement, key: string) {
		const btn = container.createDiv('citation-popover-btn');
		setIcon(btn, 'book-open');
		btn.setAttribute('aria-label', 'Open in Zotero');

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			window.open(`zotero://select/items/bbt:${key}`, '_blank');
			this.hide();
		});
	}

	// ── 定位 ──

	private positionPopover(popover: HTMLElement, target: HTMLElement) {
		const targetRect = target.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		let top = targetRect.bottom + 8;
		let left = targetRect.left + targetRect.width / 2 - popoverRect.width / 2;

		if (left < 8) left = 8;
		if (left + popoverRect.width > window.innerWidth - 8) {
			left = window.innerWidth - popoverRect.width - 8;
		}
		if (top + popoverRect.height > window.innerHeight - 8) {
			top = targetRect.top - popoverRect.height - 8;
		}
		if (top < 8) top = 8;

		popover.style.left = `${left}px`;
		popover.style.top = `${top}px`;
	}

	// ── 生命周期 ──

	/**
	 * ★ 单例模式：同步强制销毁当前弹窗及其所有计时器。
	 * 无淡出动画 — 直接 remove，确保与新弹窗零重叠。
	 */
	private destroyPopover() {
		clearTimeout(this.hideTimer!);
		this.hideTimer = null;
		if (this.popover) {
			this.popover.remove();
			this.popover = null;
			this.currentKeys = [];
		}
	}

	hide() {
		clearTimeout(this.hideTimer!);
		this.hideTimer = null;
		if (this.popover) {
			const el = this.popover;
			this.popover = null;
			this.currentKeys = [];
			// 离场过渡：0.1s 淡出后移除
			el.style.transition = 'opacity 0.1s ease-in, transform 0.1s ease-in';
			el.style.opacity = '0';
			el.style.transform = 'translateY(4px)';
			setTimeout(() => el.remove(), 100);
		}
	}
}
