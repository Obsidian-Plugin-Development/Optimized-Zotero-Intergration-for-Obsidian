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

const HIDE_DELAY_MS = 300;

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
 */
function calibrateCitationNumber(html: string, actualNumber: number): string {
	if (!html || actualNumber <= 1) return html;

	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

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
		this.currentKeys = citeKeys;

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

		// ── 逐篇构建卡片（纯同步 DOM 操作）──

		for (let i = 0; i < citeKeys.length; i++) {
			const key = citeKeys[i];
			const bibHtml = this.engine.getIndividualBibHtmlCached(key);
			const meta = this.engine.getIndividualMetaCached(key);

			// 卡片容器
			const card = popover.createDiv();
			card.style.cssText = [
				'display: flex',
				'gap: 10px',
				'align-items: flex-start',
				i < citeKeys.length - 1
					? 'padding-bottom: 10px; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 10px;'
					: '',
			].join(';');

			// 左栏：参考文献 HTML（序号已校准为全局编号）
			const left = card.createDiv();
			left.style.cssText = 'flex: 1; min-width: 0; overflow-wrap: break-word;';

			if (bibHtml) {
				const bibDiv = left.createDiv('csl-entry');
				const globalNum = this.engine.getNumber(key) || 1;
				bibDiv.innerHTML = calibrateCitationNumber(bibHtml, globalNum);
			} else {
				// ★ Cache miss 降级：显示 citekey，后台静默拉取
				left.setText(`@${key}`);
				left.style.opacity = '0.55';
				left.style.fontStyle = 'italic';
				this.engine.precacheAllBibs([key]);
			}

			// 右栏：操作按钮
			const right = card.createDiv();
			right.style.cssText =
				'display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; align-items: center;';

			this.renderNoteButton(right, key);
			if (meta?.url || meta?.doi) {
				this.renderLinkButton(right, meta);
			}
			this.renderZoteroButton(right, key);
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
		const allFiles = this.plugin.app.vault.getFiles();
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
