/**
 * v7.3 CodeMirror 6 ViewPlugin — Live Preview 引注实时渲染
 *
 * 使用 ViewPlugin.fromClass 创建装饰插件。
 * 当光标不在引用行时，隐藏 [@citekey] 原始文本，
 * 原地渲染极简行内引注标记（如 [1]、[4-6]、上标 1-3）。
 *
 * engine/plugin 通过模块级闭包注入。
 *
 * v7.3 性能优化:
 *   - unifiedScanDocument() 一次正则扫描产出全部数据，消除三次重复扫描
 *   - changeAffectsCitations() 门控 — 仅 [、]、@ 相关变更才触发全量重扫
 *   - viewportChanged / selectionSet 复用缓存扫描结果，仅重建装饰
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
import { updateCitationStore, unifiedScanDocument } from './citationStore';
import type { UnifiedScanResult } from './citationStore';
import { isBibOutOfSync, markBibDirty, markBibClean, getLastCitationSignature, setLastCitationSignature, getLastRefHash, setLastRefHash, computeRefSectionHash } from './bibliographyWriter';

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

/**
 * v7.0 硬编码上标数字渲染（无 CSL 依赖）。
 * 返回纯文本数字（如 "1" 或 "1-3"），
 * Widget 通过 CSS 类 .custom-citation-inline 实现上标效果。
 */
function computeInlineText(keys: string[]): string {
	const numbers: number[] = [];
	for (const k of keys) {
		const num = _engine.getNumber(k);
		if (num > 0) numbers.push(num);
	}
	if (numbers.length === 0) return '';

	const sortedUnique = [...new Set(numbers)].sort((a, b) => a - b);
	return foldNumbers(sortedUnique);
}

// ── Widget ──

class InlineCitationWidget extends WidgetType {
	constructor(
		private readonly keys: string[],
		private readonly displayText: string,
		private readonly from: number,
		private readonly to: number,
	) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		_activeView = view;

		const span = document.createElement('span');
		span.addClass('custom-citation-inline');

		if (!this.displayText) {
			span.setText('[?]');
			span.style.opacity = '0.5';
		} else {
			span.setText(this.displayText);
		}

		span.setAttribute('data-citation-keys', this.keys.join(','));
		span.setAttribute('data-citation-from', String(this.from));
		span.setAttribute('data-citation-to', String(this.to));
		return span;
	}

	eq(other: InlineCitationWidget): boolean {
		return this.keys.join(',') === other.keys.join(',')
			&& this.displayText === other.displayText
			&& this.from === other.from
			&& this.to === other.to;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

// ── ViewPlugin ──

class CitationPluginValue implements PluginValue {
	decorations: DecorationSet;
	/** v7.3: 缓存最近一次统一扫描结果，供 viewportChanged/selectionSet 复用 */
	private cachedScan: UnifiedScanResult | null = null;
	private cachedDocText: string = '';

	constructor(private view: EditorView) {
		this.decorations = this.compute();
	}

	update(update: ViewUpdate) {
		if (update.docChanged) {
			// ★ v7.3 门控：仅当变更涉及 [、]、@ 字符才触发全量重扫
			if (this.changeAffectsCitations(update)) {
				this.decorations = this.compute();
			}
			// 否则：变更不涉及引注字符，跳过重扫，保持现有装饰
			return;
		}
		if (update.viewportChanged || update.selectionSet) {
			// ★ v7.3: 复用缓存扫描结果，仅重建可见区装饰
			if (this.cachedScan && this.cachedScan.positions.length > 0) {
				this.decorations = this.buildDecorationsFromCache();
			}
		}
	}

	/**
	 * v7.3: 门控检测 — 变更是否涉及引注相关字符。
	 * 检查插入/删除的文本中是否包含 [、]、@。
	 */
	private changeAffectsCitations(update: ViewUpdate): boolean {
		let affects = false;
		update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
			if (affects) return;
			// 快速路径：检查新插入的文本
			const insText = inserted.toString();
			if (insText.length > 0 && /[[\]@]/.test(insText)) {
				affects = true;
				return;
			}
			// 检查被删除的文本（从旧文档中切片）
			// iterChanges 的 fromA/toA 是旧文档中的范围
			if (!affects && update.startState.doc.length > 0) {
				// 只检查删除的文本是否包含引注字符
				for (const ch of ['[', ']', '@']) {
					if (insText.indexOf(ch) >= 0) {
						affects = true;
						return;
					}
				}
			}
		});

		// ★ 补充：检查删除的文本是否包含引注字符
		if (!affects) {
			update.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
				if (affects) return;
				if (fromA < toA) {
					const deleted = update.startState.doc.sliceString(fromA, toA);
					if (/[[\]@]/.test(deleted)) {
						affects = true;
					}
				}
			});
		}

		return affects;
	}

	destroy() {}

	/**
	 * v7.3 全量重扫 — unifiedScanDocument 一次正则产出全部数据。
	 * 替代原 updateCitationStore + extractCitationSignature + scanDocumentForCitations 三次扫描。
	 *
	 * v7.3: 签名/脏检测/和解逻辑与 v7.1 完全一致，仅数据来源改为 unifiedScanDocument。
	 */
	private compute(): DecorationSet {
		if (!_plugin?.settings.citationRenderingEnabled) {
			return Decoration.none;
		}

		const { state } = this.view;
		const docText = state.doc.toString();

		// ★ v7.3: 一次扫描产出全部数据
		const scan = unifiedScanDocument(docText);
		this.cachedScan = scan;
		this.cachedDocText = docText;

		// ★ 更新 Store（兼容 bibliographyWriter 等旧消费者读取 citationStore）
		updateCitationStore(docText);

		// ★ 同步 engine 的 keyToNumber
		_engine.syncKeyToNumber(scan.keyToNumber);

		// ★ 触发后台预缓存（单篇 + 合并参考文献）
		if (scan.sortedUniqueKeys.length > 0) {
			_engine.precacheAllBibs(scan.sortedUniqueKeys);
			_engine.getCombinedBibliographyHtml(scan.sortedUniqueKeys);
		}

		// ★ v7.1: 引注签名 diff — 使用 unifiedScanDocument 的 signature
		const currentSignature = scan.signature;
		const filePath = _plugin?.app?.workspace?.getActiveFile()?.path || '';
		const cachedSignature = getLastCitationSignature(filePath);
		if (cachedSignature === null) {
			setLastCitationSignature(filePath, currentSignature);
		} else if (currentSignature !== cachedSignature) {
			if (currentSignature === "") {
				console.log("[cm6LivePreview] 检测到所有引注已删除，标记 clean（静默，保留基线）");
				markBibClean(true);
			} else {
				markBibDirty();
				try { _plugin.emitter.trigger("bibDirty"); } catch { /* 静默 */ }
			}
		}

		// v7.1: 参考文献区块实时完整性检测
		const currentRefHash = computeRefSectionHash(docText);
		const cachedRefHash = getLastRefHash(filePath);
		if (cachedRefHash !== null && currentRefHash !== null && currentRefHash !== cachedRefHash) {
			console.log('[cm6LivePreview] 检测到参考文献区块被手动修改');
			markBibDirty();
			try { _plugin.emitter.trigger('bibDirty'); } catch { /* 静默 */ }
		} else if (cachedRefHash === null && currentRefHash !== null) {
			setLastRefHash(filePath, currentRefHash);
		}

		// v7.1: 撤销/重做恢复检测
		if (
			isBibOutOfSync &&
			cachedSignature !== null &&
			currentSignature === cachedSignature &&
			cachedRefHash !== null &&
			currentRefHash === cachedRefHash
		) {
			console.log("[cm6LivePreview] 检测到文档恢复至基线状态（撤销/重做），标记 clean");
			markBibClean();
			try { _plugin.emitter.trigger("bibClean"); } catch { /* 静默 */ }
		}

		// ★ 从统一扫描结果构建装饰
		return this.buildDecorationsFromScan(scan);
	}

	/**
	 * v7.3: 从缓存扫描结果重建装饰（viewportChanged / selectionSet 复用路径）。
	 * 不重扫文档，仅根据新的 visibleRanges / selection 重新过滤。
	 */
	private buildDecorationsFromCache(): DecorationSet {
		if (!this.cachedScan || !_plugin?.settings.citationRenderingEnabled) {
			return Decoration.none;
		}
		return this.buildDecorationsFromScan(this.cachedScan);
	}

	/**
	 * v7.3: 从 UnifiedScanResult 构建 DecorationSet。
	 * 从 compute() 和 buildDecorationsFromCache() 共享。
	 */
	private buildDecorationsFromScan(scan: UnifiedScanResult): DecorationSet {
		if (scan.positions.length === 0) {
			return Decoration.none;
		}

		const { state } = this.view;
		const positions = scan.positions;
		const visibleRanges = this.view.visibleRanges;
		const unresolvedKeys = new Set<string>();

		const ranges: Array<{ from: number; to: number; keys: string[]; displayText: string }> = [];

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

			const displayText = computeInlineText(pos.keys);
			ranges.push({ from: pos.from, to: pos.to, keys: pos.keys, displayText });
		}

		// 异步解析未缓存 key
		if (unresolvedKeys.size > 0) {
			_engine.resolveCiteKeys([...unresolvedKeys]).then(() => {
				this.decorations = this.compute();
				try { this.view.dispatch({}); } catch { /* view destroyed */ }
			});
		}

		const decos = ranges.map(({ from, to, keys, displayText }) =>
			Decoration.replace({
				widget: new InlineCitationWidget(keys, displayText, from, to),
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
