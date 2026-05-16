/**
 * v6.1.0-alpha.1 引注编辑/插入双模模态框
 *
 * 双模式复用同一个 Modal：
 *   - 编辑模式（editRange 存在）：标签云展示已有 citekey，保存时 view.dispatch 精准替换原坐标
 *   - 插入模式（editRange 为空）：标签云初始为空，保存时在光标处插入新引注
 *
 * 提供所见即所得 (WYSIWYG) 的引注编辑体验：
 *   - 标签云 (Tag Chips)：展示当前 citekey，每个带 × 删除按钮
 *   - 搜索添加：复用 Zotero BBT picker 添加新文献
 *   - 原子化替换：保存时通过 view.dispatch() 精准替换源码坐标
 */
import { Modal, setIcon } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type ZoteroConnector from '../main';

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

export class CitationEditModal extends Modal {
	private citeKeys: string[];
	private chipContainer!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private addBtn!: HTMLButtonElement;

	constructor(
		app: ZoteroConnector['app'],
		private readonly plugin: ZoteroConnector,
		private readonly view: EditorView,
		private readonly range?: { from: number; to: number },
		initialKeys: string[] = [],
	) {
		super(app);
		// 深拷贝，避免外部修改
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

		// ── 标签云区域 ──
		const chipSection = contentEl.createDiv();
		chipSection.style.cssText = 'margin-bottom: 16px;';

		const chipLabel = chipSection.createEl('div');
		chipLabel.setText('已选文献');
		chipLabel.style.cssText =
			'font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;';

		this.chipContainer = chipSection.createDiv('citation-edit-chips');
		this.chipContainer.style.cssText = [
			'display: flex',
			'flex-wrap: wrap',
			'gap: 6px',
			'min-height: 32px',
			'padding: 8px 10px',
			'background: var(--background-secondary)',
			'border-radius: 8px',
			'border: 1px solid var(--background-modifier-border)',
		].join(';');

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

		// ★ 所有 DOM 就绪后渲染 chips
		this.renderChips();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	// ── 标签云渲染 ──

	private renderChips() {
		this.chipContainer.empty();

		if (this.citeKeys.length === 0) {
			const empty = this.chipContainer.createEl('span');
			empty.setText('暂无文献，请点击「+ 添加文献」');
			empty.style.cssText =
				'color: var(--text-faint); font-style: italic; font-size: 12px; padding: 4px 0;';
			this.updateSaveButton();
			return;
		}

		for (const key of this.citeKeys) {
			const chip = this.chipContainer.createDiv('citation-edit-chip');
			chip.style.cssText = [
				'display: inline-flex',
				'align-items: center',
				'gap: 4px',
				'padding: 3px 4px 3px 10px',
				'background: var(--interactive-accent)',
				'color: var(--text-on-accent)',
				'border-radius: 20px',
				'font-size: 12px',
				'font-weight: 500',
				'line-height: 1.4',
				'user-select: none',
			].join(';');

			const label = chip.createEl('span');
			label.setText(`@${key}`);

			const removeBtn = chip.createEl('span');
			removeBtn.setText('×');
			removeBtn.style.cssText = [
				'display: inline-flex',
				'align-items: center',
				'justify-content: center',
				'width: 18px',
				'height: 18px',
				'border-radius: 50%',
				'background: rgba(255,255,255,0.2)',
				'cursor: pointer',
				'font-size: 14px',
				'font-weight: 700',
				'line-height: 1',
				'transition: background 0.1s',
			].join(';');
			removeBtn.addEventListener('mouseenter', () => {
				removeBtn.style.background = 'rgba(255,255,255,0.4)';
			});
			removeBtn.addEventListener('mouseleave', () => {
				removeBtn.style.background = 'rgba(255,255,255,0.2)';
			});
			removeBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.removeCiteKey(key);
			});

			chip.appendChild(removeBtn);
		}

		this.updateSaveButton();
	}

	// ── 增删 citekey ──

	private removeCiteKey(key: string) {
		this.citeKeys = this.citeKeys.filter((k) => k !== key);
		this.renderChips();
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
			this.renderChips();
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
	 * ★ 双模式保存
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
			// 编辑模式：替换原坐标区域
			this.view.dispatch({
				changes: {
					from: this.range.from,
					to: this.range.to,
					insert: newText,
				},
			});
		} else {
			// 插入模式：光标处插入
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
