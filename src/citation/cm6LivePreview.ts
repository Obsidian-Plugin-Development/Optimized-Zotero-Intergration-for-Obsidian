/**
 * v6.1 CodeMirror 6 ViewPlugin — Live Preview 引注实时渲染
 *
 * 使用 ViewPlugin.fromClass 创建装饰插件。
 * 当光标不在引用行时，隐藏 [@citekey] 原始文本，
 * 原地渲染格式化行内引注编号（如 [1]、[1,2]）。
 *
 * engine/plugin 通过模块级闭包注入。
 * 智能拦截：仅当变更涉及 [、]、@ 字符才触发全量重扫。
 * Widget 构造时冻结 displayText，eq() 比较冻结值，根除 CM6 复用陷阱。
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

// ── 模块级闭包引用 ──
let _engine: CitationEngine;
let _plugin: ZoteroConnector;

// ── 调试开关 ──
const DEBUG_CITATION_BOUNDARY = false;
let _debugSeq = 0;
function debugLog(msg: string, ...args: any[]) {
	if (!DEBUG_CITATION_BOUNDARY) return;
	console.log(`[CM6-Cite#${++_debugSeq}] ${msg}`, ...args);
}

// ── 光标/选区重叠检测 ──

/**
 * 判断任意光标或选区是否与引注范围 [from, to) 重叠。
 *
 * 光标紧贴边缘（from 或 to）时判定为重叠 → 卸载装饰 → 暴露裸文，
 * 确保边界输入绝对安全。
 *
 * | 光标位置           | sel.from | sel.to | from≤to | to≥from | 结果        |
 * |--------------------|----------|--------|---------|---------|-------------|
 * | `|[@citekey]`      | from     | from   | T       | T       | 重叠 → 裸文 |
 * | `[@citekey]|`      | to       | to     | T       | T       | 重叠 → 裸文 |
 * | `|` 前一个字符      | from-1   | from-1 | T       | F       | → widget    |
 */
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

// ── Widget：构造时冻结显示文本，根除 eq() 复用陷阱 ──

class InlineCitationWidget extends WidgetType {
	/**
	 * @param keys        原始 citekey 列表（如 ["doe2020"]）
	 * @param displayText 构造时冻结的渲染文本（如 "[1]"、"(2)"）。
	 *                    绝不在此类中调用 _engine.getNumber() ——
	 *                    那会读取 mutable 全局状态，导致 eq() 误判。
	 * @param superscript 是否为上标格式
	 */
	constructor(
		private readonly keys: string[],
		private readonly displayText: string,
		private readonly superscript: boolean,
	) {
		super();
	}

	toDOM(_view: EditorView): HTMLElement {
		const span = document.createElement('span');
		span.addClass('custom-citation-inline');

		if (!this.displayText) {
			span.setText('[?]');
			span.style.opacity = '0.5';
		} else if (this.superscript) {
			const sup = document.createElement('sup');
			sup.setText(this.displayText);
			span.appendChild(sup);
		} else {
			span.setText(this.displayText);
		}

		span.setAttribute('data-citation-keys', this.keys.join(','));
		return span;
	}

	/**
	 * 关键修复：对比构造时冻结的 displayText，而非实时查询引擎。
	 *
	 * 旧 Bug：eq() 中调用 getDisplayText() → _engine.getNumber(k)
	 *   → 读取 mutable 全局 Map。compute() 已更新 Map 后，新旧 Widget
	 *   读到相同（新）值 → eq() 返回 true → CM6 复用旧 DOM → 序号不更新。
	 *
	 * 修复后：displayText 在构造函数中冻结，eq() 比较冻结值。
	 *   拖拽/粘贴改变顺序 → 新旧 displayText 不同 → eq() false → toDOM() 重建。
	 */
	eq(other: InlineCitationWidget): boolean {
		return this.keys.join(',') === other.keys.join(',')
			&& this.displayText === other.displayText;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

// ── 辅助：计算单个引注的渲染文本 ──

function computeDisplayText(keys: string[]): string {
	const numbers: number[] = [];
	for (const k of keys) {
		const num = _engine.getNumber(k);
		if (num > 0) numbers.push(num);
	}
	if (numbers.length === 0) return '';
	const fmt = _engine.getCitationFormat();
	const unique = [...new Set(numbers)].sort((a, b) => a - b);
	return fmt.prefix + unique.join(fmt.delimiter) + fmt.suffix;
}

// ── ViewPlugin ──

class CitationPluginValue implements PluginValue {
	decorations: DecorationSet;

	constructor(private view: EditorView) {
		this.decorations = this.compute();
	}

	update(update: ViewUpdate) {
		// 智能拦截 (Smart Trigger)：仅当变更涉及 [、]、@ 字符
		// 才触发全量重扫。普通文本输入由 CM6 自动映射装饰位置。
		const citationAffected = update.docChanged && this.changeAffectsCitations(update);
		if (citationAffected || update.viewportChanged || update.selectionSet) {
			this.decorations = this.compute();
		}
	}

	/**
	 * 检查 Transaction 变更是否涉及引注关键字符 [ ] @。
	 * 仅遍历已变更的范围 (iterChanges)，O(变更大小)，不扫描全文。
	 * 同时检查插入文本和删除文本，覆盖新增/删除/拖拽/粘贴所有场景。
	 */
	private changeAffectsCitations(update: ViewUpdate): boolean {
		let affects = false;
		update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			if (affects) return;
			// 插入的文本包含 [ ] @
			if (/[[\]@]/.test(inserted.toString())) {
				affects = true;
				return;
			}
			// 删除的文本包含 [ ] @（如删除引注、拖拽移走引注）
			if (fromA < toA) {
				const deleted = update.startState.doc.sliceString(fromA, toA);
				if (/[[\]@]/.test(deleted)) {
					affects = true;
				}
			}
		});
		return affects;
	}

	destroy() {
		// 无异步资源需清理
	}

	/**
	 * 构建当前文档的引注装饰集。
	 * 跳过代码块、光标行。仅装饰当前 viewport 内可见的引注。
	 */
	private compute(): DecorationSet {
		if (!_plugin?.settings.citationRenderingEnabled) {
			return Decoration.none;
		}

		const { state } = this.view;
		const docText = state.doc.toString();
		const scan = _engine.scanDocument(docText);

		if (scan.positions.length === 0) {
			debugLog('compute: no citekey positions found');
			return Decoration.none;
		}

		debugLog(`compute: doc ${docText.length} chars, ${scan.positions.length} positions`);

		const visibleRanges = this.view.visibleRanges;
		const superscript = _engine.getCitationFormat().superscript;
		const ranges: Array<{ from: number; to: number; keys: string[]; displayText: string }> = [];
		const unresolvedKeys = new Set<string>();
		let skippedCodeBlock = 0;
		let skippedCursor = 0;
		let skippedViewport = 0;

		for (const pos of scan.positions) {
			if (isInsideCodeBlock(state, pos.from)) {
				skippedCodeBlock++;
				continue;
			}

			// 光标/选区与引注重叠 → 暴露原始 [@citekey] 供编辑
			if (isCursorOverlapping(state, pos.from, pos.to)) {
				skippedCursor++;
				continue;
			}

			// 视口过滤：仅为可见引注生成 Decoration
			const isVisible = visibleRanges.some(r =>
				pos.from <= r.to && pos.to >= r.from
			);
			if (!isVisible) {
				skippedViewport++;
				continue;
			}

			for (const k of pos.keys) {
				if (!_engine.getCached(k)) {
					unresolvedKeys.add(k);
				}
			}

			// ★ 构造时冻结 displayText — 确保 eq() 比较稳定值
			const displayText = computeDisplayText(pos.keys);
			ranges.push({ from: pos.from, to: pos.to, keys: pos.keys, displayText });
		}

		debugLog(`  ranges=${ranges.length} skipped(code=${skippedCodeBlock} cursor=${skippedCursor} vp=${skippedViewport})`);

		// 异步解析未缓存的 citekey
		if (unresolvedKeys.size > 0) {
			_engine.resolveCiteKeys([...unresolvedKeys]).then(() => {
				this.decorations = this.compute();
				try { this.view.dispatch({}); } catch { /* view destroyed */ }
			});
		}

		// ★ v6.2 后台静默预缓存：文档扫描后立即拉取所有 citekey 的
		//   单篇参考文献 HTML + 元数据，确保 hover popover 零延迟直读。
		const allUniqueKeys = new Set<string>();
		for (const pos of scan.positions) {
			for (const k of (pos as any).keys) {
				allUniqueKeys.add(k);
			}
		}
		if (allUniqueKeys.size > 0) {
			_engine.precacheAllBibs([...allUniqueKeys]);
		}

		// 构建 Decoration.replace — 双重保险边界
		const decos = ranges.map(({ from, to, keys, displayText }) =>
			Decoration.replace({
				widget: new InlineCitationWidget(keys, displayText, superscript),
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
