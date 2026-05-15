/**
 * v6.5 CodeMirror 6 ViewPlugin — Live Preview 引注实时渲染
 *
 * 使用 ViewPlugin.fromClass 创建装饰插件。
 * 当光标不在引用行时，隐藏 [@citekey] 原始文本，
 * 原地渲染极简行内引注标记（如 [1]、[4-6]、上标 1-3）。
 *
 * engine/plugin 通过模块级闭包注入。
 * 智能拦截：仅当变更涉及 [、]、@ 字符才触发全量重扫。
 *
 * v6.5: 移除 StateField 依赖，改为直接扫描文档 + citationStore 共享。
 */
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import type ZoteroConnector from '../main';
import type { CitationEngine } from './citationEngine';
import { updateCitationStore } from './citationStore';
import type { CitationStore, CitePos } from './citationStore';
import { scheduleBibliographyUpdate } from './bibliographyWriter';

// ── 模块级闭包引用 ──
let _engine: CitationEngine;
let _plugin: ZoteroConnector;
let _activeView: EditorView | null = null;

/** 提供给 hoverPopover 获取当前活跃 EditorView（用于编辑模态框） */
export function getActiveEditorView(): EditorView | null {
	return _activeView;
}

// ── 调试开关 ──
const DEBUG_CITATION_BOUNDARY = false;
let _debugSeq = 0;
function debugLog(msg: string, ...args: any[]) {
	if (!DEBUG_CITATION_BOUNDARY) return;
	console.log(`[CM6-Cite#${++_debugSeq}] ${msg}`, ...args);
}

// ── 光标/选区重叠检测 ──

function isCursorOverlapping(state: EditorState, from: number, to: number): boolean {
	for (const sel of state.selection.ranges) {
		if (sel.from <= to && sel.to >= from) return true;
	}
	return false;
}

// ── 代码块检测 ──

function isInsideCodeBlock(state: EditorState, pos: number): boolean {
	try {
		const tree = syntaxTree(state);
		let node = tree.resolveInner(pos, 1);
		for (let n: any = node; n; n = n.parent) {
			const name: string = n.type?.name || '';
			if (
				name === 'FencedCode' ||
				name === 'CodeBlock' ||
				name === 'InlineCode' ||
				name === 'Comment' ||
				name === 'HyperMD-codeblock' ||
				name === 'HyperMD-code' ||
				name === 'hmd-codeblock' ||
				name === 'hmd-inlinecode'
			) {
				return true;
			}
		}
	} catch { /* syntaxTree 可能尚不可用 */ }
	return false;
}

// ── 本地智能序号折叠算法 ──

function foldNumbers(sortedUnique: number[]): string {
	if (sortedUnique.length === 0) return '';
	const parts: string[] = [];
	let runStart = sortedUnique[0];
	let runEnd = sortedUnique[0];

	for (let i = 1; i < sortedUnique.length; i++) {
		if (sortedUnique[i] === runEnd + 1) {
			runEnd = sortedUnique[i];
		} else {
			parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
			runStart = sortedUnique[i];
			runEnd = sortedUnique[i];
		}
	}
	parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
	return parts.join(', ');
}

function computeInlineHtml(keys: string[]): string {
	const numbers: number[] = [];
	for (const k of keys) {
		const num = _engine.getNumber(k);
		if (num > 0) numbers.push(num);
	}
	if (numbers.length === 0) return '';

	const sortedUnique = [...new Set(numbers)].sort((a, b) => a - b);
	const folded = foldNumbers(sortedUnique);
	const fmt = _engine.getCitationFormat();

	if (fmt.superscript) {
		return `<sup>${folded}</sup>`;
	}
	return fmt.prefix + folded + fmt.suffix;
}

// ── Widget ──

class InlineCitationWidget extends WidgetType {
	constructor(
		private readonly keys: string[],
		private readonly displayHtml: string,
		private readonly from: number,
		private readonly to: number,
	) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		_activeView = view;

		const span = document.createElement('span');
		span.addClass('custom-citation-inline');

		if (!this.displayHtml) {
			span.setText('[?]');
			span.style.opacity = '0.5';
		} else {
			span.innerHTML = this.displayHtml;
		}

		span.setAttribute('data-citation-keys', this.keys.join(','));
		span.setAttribute('data-citation-from', String(this.from));
		span.setAttribute('data-citation-to', String(this.to));
		return span;
	}

	eq(other: InlineCitationWidget): boolean {
		return this.keys.join(',') === other.keys.join(',')
			&& this.displayHtml === other.displayHtml
			&& this.from === other.from
			&& this.to === other.to;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

// ── 文档扫描（内联，不依赖 StateField）──

const CITE_PATTERN = /\[@([^\]]+)\]/g;

function scanDocumentForCitations(docText: string): CitePos[] {
	const positions: CitePos[] = [];
	let match: RegExpExecArray | null;
	while ((match = CITE_PATTERN.exec(docText)) !== null) {
		const rawKeys = match[1]
			.split(';')
			.map(s => s.trim().replace(/^@/, ''))
			.filter(Boolean);
		positions.push({
			keys: rawKeys,
			from: match.index,
			to: match.index + match[0].length,
		});
	}
	return positions;
}

// ── ViewPlugin ──

class CitationPluginValue implements PluginValue {
	decorations: DecorationSet;

	constructor(private view: EditorView) {
		this.decorations = this.compute();
	}

	update(update: ViewUpdate) {
		const citationAffected = update.docChanged && this.changeAffectsCitations(update);
		if (citationAffected || update.viewportChanged || update.selectionSet) {
			this.decorations = this.compute();
		}
	}

	private changeAffectsCitations(update: ViewUpdate): boolean {
		let affects = false;
		update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			if (affects) return;
			if (/[[\]@]/.test(inserted.toString())) {
				affects = true;
				return;
			}
			if (fromA < toA) {
				const deleted = update.startState.doc.sliceString(fromA, toA);
				if (/[[\]@]/.test(deleted)) {
					affects = true;
				}
			}
		});
		return affects;
	}

	destroy() {}

	/**
	 * v6.5 直接扫描文档 + 更新 citationStore + engine。
	 * 替代原来的 StateField 读取方案。
	 */
	private compute(): DecorationSet {
		if (!_plugin?.settings.citationRenderingEnabled) {
			return Decoration.none;
		}

		const { state } = this.view;
		const docText = state.doc.toString();

		// ★ 扫描文档并更新全局 Store（替代 StateField）
		const store = updateCitationStore(docText);

		// ★ 同步 engine 的 keyToNumber
		_engine.syncKeyToNumber(store.keyToNumber);

		// ★ 触发后台预缓存（单篇 + 合并参考文献）
		if (store.sortedUniqueKeys.length > 0) {
			_engine.precacheAllBibs(store.sortedUniqueKeys);
			// 同时预热合并参考文献缓存（供 bibliographyWriter 同步读取，fire-and-forget）
			_engine.getCombinedBibliographyHtml(store.sortedUniqueKeys);
		}

		// ★ 触发文末参考文献纯文本同步（v6.6 替代 Widget 渲染）
		scheduleBibliographyUpdate(this.view);

		const positions = scanDocumentForCitations(docText);
		if (positions.length === 0) {
			return Decoration.none;
		}

		const visibleRanges = this.view.visibleRanges;
		const ranges: Array<{ from: number; to: number; keys: string[]; displayHtml: string }> = [];
		const unresolvedKeys = new Set<string>();

		for (const pos of positions) {
			if (isInsideCodeBlock(state, pos.from)) continue;
			if (isCursorOverlapping(state, pos.from, pos.to)) continue;

			const isVisible = visibleRanges.some(r =>
				pos.from <= r.to && pos.to >= r.from
			);
			if (!isVisible) continue;

			for (const k of pos.keys) {
				if (!_engine.getCached(k)) {
					unresolvedKeys.add(k);
				}
			}

			const displayHtml = computeInlineHtml(pos.keys);
			ranges.push({ from: pos.from, to: pos.to, keys: pos.keys, displayHtml });
		}

		if (unresolvedKeys.size > 0) {
			_engine.resolveCiteKeys([...unresolvedKeys]).then(() => {
				this.decorations = this.compute();
				try { this.view.dispatch({}); } catch { /* view destroyed */ }
			});
		}

		const decos = ranges.map(({ from, to, keys, displayHtml }) =>
			Decoration.replace({
				widget: new InlineCitationWidget(keys, displayHtml, from, to),
				inclusiveStart: false,
				inclusiveEnd: false,
				block: false,
			}).range(from, to),
		);

		return decos.length > 0 ? Decoration.set(decos, true) : Decoration.none;
	}

}

// ── Factory ──

export function citationLivePreviewPlugin(
	engine: CitationEngine,
	plugin: ZoteroConnector,
): Extension {
	_engine = engine;
	_plugin = plugin;
	return ViewPlugin.fromClass(CitationPluginValue, {
		decorations: (v) => v.decorations,
	});
}
