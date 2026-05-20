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
import { isBibOutOfSync, markBibDirty, markBibClean, extractCitationSignature, getLastCitationSignature, setLastCitationSignature, getLastRefHash, setLastRefHash, clearLastRefHash, computeRefSectionHash } from './bibliographyWriter';

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
			// v7.0: 纯文本 + CSS 上标（无 <sup> 标签、无 HTML 注入）
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
		if (update.docChanged || update.viewportChanged || update.selectionSet) {
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

		// ★ v7.1: 引注签名 diff — 仅当 citekey 真正变化时才标记 dirty
		const currentSignature = extractCitationSignature(docText);
		const filePath = _plugin?.app?.workspace?.getActiveFile()?.path || '';
		const cachedSignature = getLastCitationSignature(filePath);
		if (cachedSignature === null) {
			// 首次遇到该文档 → 建立基线签名，假设已同步
			setLastCitationSignature(filePath, currentSignature);
		} else if (currentSignature !== cachedSignature) {
			// v6.5.4: 签名变更分两路处理
			//   - 签名变为空 → 用户删除了所有引注 → 标记 clean + 更新基线
			//     （若参考文献区块仍存在，silentDiffCheck 下次 focus 时会检测到数量不对等并纠正）
			//   - 签名变为非空 → 正常标记 dirty
				if (currentSignature === "") {
					// v6.5.4-alpha.3: 静默模式 — 不触发 bibClean 事件，
					// 避免 refreshCitationCachesAfterSync 清空 _refHashCache，
					// 从而保留基线供 Ctrl+Z 撤销检测。
					console.log("[cm6LivePreview] 检测到所有引注已删除，标记 clean（静默，保留基线）");
					markBibClean(true);
				} else {
					markBibDirty();
					try { _plugin.emitter.trigger("bibDirty"); } catch { /* 静默 */ }
				}
		}

		// v6.5.4: 参考文献区块实时完整性检测
		// 每次 compute 时计算当前参考文献哈希，与同步后基线比对
		//   用户手动删改参考文献条目 → refHash 变更 → 实时标记 dirty
		//   基线由 refreshCitationCachesAfterSync / silentDiffCheck 在同步后写入
		const currentRefHash = computeRefSectionHash(docText);
		const cachedRefHash = getLastRefHash(filePath);
		if (cachedRefHash !== null && currentRefHash !== null && currentRefHash !== cachedRefHash) {
			console.log('[cm6LivePreview] 检测到参考文献区块被手动修改');
			markBibDirty();
			try { _plugin.emitter.trigger('bibDirty'); } catch { /* 静默 */ }
		} else if (cachedRefHash === null && currentRefHash !== null) {
			// 首次遇到参考文献区块 → 建立基线（后续修改将被检测）
			setLastRefHash(filePath, currentRefHash);
		} else if (currentRefHash === null && cachedRefHash !== null) {
			// v6.5.4-alpha.3: 不删除基线，保留旧值供 Ctrl+Z 撤销检测
			// refBlock 被删除但缓存保留，若恢复则哈希自动匹配
			
		}

		// v6.5.4-alpha.3: 撤销/重做恢复检测
		// 当引注签名和参考文献哈希同时匹配基线，但 isBibOutOfSync 仍为 true 时，
		// 说明用户通过 Ctrl+Z 撤销了之前的破坏性编辑，文档已恢复至同步后基线状态。
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

		const positions = scanDocumentForCitations(docText);
		if (positions.length === 0) {
			return Decoration.none;
		}

		const visibleRanges = this.view.visibleRanges;
		const ranges: Array<{ from: number; to: number; keys: string[]; displayText: string }> = [];
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

			const displayText = computeInlineText(pos.keys);
			ranges.push({ from: pos.from, to: pos.to, keys: pos.keys, displayText });
		}

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
