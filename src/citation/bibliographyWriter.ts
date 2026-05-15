/**
 * v6.7 Bibliography Text Writer — 原生标题驱动的纯文本静默同步
 *
 * 彻底废弃 Widget 渲染与特殊锚点（HTML 注释、代码块）。
 * 使用用户自定义的 Markdown 标题定位，在其下方安全区内写入纯文本有序列表。
 *
 * 触发时机：
 *   1. cm6LivePreview 扫描到引注变动
 *   2. 用户在悬浮窗 Edit Modal 中修改完成
 *
 * 安全阀（三层防死循环）：
 *   1. 1000ms 防抖 — 连续编辑合并为单次扫描
 *   2. 严禁写时 Fetch — 缓存 miss 直接 return，等待后台预缓存
 *   3. 严格 Diff 比对 — newText.trim() === oldText.trim() → 跳过写入
 *
 * v6.8: 按文档物理位置排序参考文献（keyPositions），使用 individual cache 替代 combined cache。
 */
import { EditorView } from '@codemirror/view';
import type { CitationEngine } from './citationEngine';
import { citationStore } from './citationStore';

// ── 模块级状态 ──
let _bibEngine: CitationEngine;
let _bibHeading = '参考文献';
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingView: EditorView | null = null;
const DEBOUNCE_MS = 1000;

export function initBibliographyWriter(engine: CitationEngine, heading: string) {
	_bibEngine = engine;
	_bibHeading = heading || '参考文献';
}

/** 运行时更新参考文献标题（设置变更时调用） */
export function setBibliographyHeading(heading: string) {
	_bibHeading = heading || '参考文献';
}

export function scheduleBibliographyUpdate(view: EditorView) {
	_pendingView = view;
	if (_debounceTimer) return;
	_debounceTimer = setTimeout(() => {
		_debounceTimer = null;
		const v = _pendingView;
		_pendingView = null;
		if (v && !(v as any).isDestroyed) updateBibliographyText(v);
	}, DEBOUNCE_MS);
}

// ── 辅助：正则特殊字符转义 ──

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 辅助：构建当前生效的标题匹配正则 ──

function buildHeadingPattern(): RegExp {
	const escaped = escapeRegex(_bibHeading);
	return new RegExp(`^(#+)\\s+(${escaped})\\s*$`, 'im');
}

// ── 单个 entry HTML → 纯文本（去 CSL 序号）──

function entryHtmlToPlainText(html: string, index: number): string {
	if (!html) return '';
	const doc = new DOMParser().parseFromString(html, 'text/html');

	// 尝试提取 .csl-entry
	const entryDiv = doc.body.querySelector('.csl-entry');
	if (entryDiv) {
		let text = (entryDiv.textContent || '').replace(/\s+/g, ' ').trim();
		if (!text) return '';
		// 剔除 CSL 原生序号
		text = text.replace(/^[\[\(]?\d+[\]\)]?[\.\:]?\s*/, '').trim();
		return text ? `${index}. ${text}` : '';
	}

	// 回退：整体提取文本
	const rawText = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
	if (!rawText) return '';
	const cleanText = rawText.replace(/^[\[\(]?\d+[\]\)]?[\.\:]?\s*/, '').trim();
	return cleanText ? `${index}. ${cleanText}` : '';
}

// ── 安全区定位 ──

interface BibliographyZone {
	from: number;
	to: number;
}

/**
 * 在文档中定位参考文献标题，返回其下方的"安全区"。
 * 使用用户设置的自定义标题构建动态正则。
 * 若未找到标题则返回 null。
 */
function findBibliographyZone(docText: string): BibliographyZone | null {
	const headingPattern = buildHeadingPattern();
	const match = headingPattern.exec(docText);
	if (!match) return null;

	const headingLevel = match[1].length;
	const headingEnd = match.index + match[0].length;

	// 安全区起点：标题行之后（不超过文档末尾）
	const zoneStart = Math.min(headingEnd + 1, docText.length);

	// 安全区终点：下一个 # 数量 ≤ headingLevel 的标题
	const searchText = docText.slice(zoneStart);
	const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
	const nextMatch = nextHeadingPattern.exec(searchText);
	const zoneEnd = nextMatch ? zoneStart + nextMatch.index : docText.length;

	// 防御：起点不得大于终点
	if (zoneStart > zoneEnd) return null;

	return { from: zoneStart, to: zoneEnd };
}

// ── 公开检测函数（供状态栏）──

export function hasBibHeading(docText: string): boolean {
	return buildHeadingPattern().test(docText);
}

// ── 核心写入逻辑（纯同步！按文档物理位置排序）──

function updateBibliographyText(view: EditorView) {
	const docText = view.state.doc.toString();

	// 1. 定位原生参考文献标题（动态正则）
	const zone = findBibliographyZone(docText);
	if (!zone) return;

	// 2. 获取当前有序 citekey 列表 + 物理位置
	const { sortedUniqueKeys, keyPositions } = citationStore;
	if (sortedUniqueKeys.length === 0) return;

	// 3. ★ 按文档物理位置升序排序
	const positionSorted = [...sortedUniqueKeys].sort(
		(a, b) => (keyPositions.get(a) ?? Infinity) - (keyPositions.get(b) ?? Infinity),
	);

	// 4. ★ 从 individual cache 按位置顺序提取每条文献文本（严禁写时 Fetch）
	const entries: string[] = [];
	let allCached = true;
	for (let i = 0; i < positionSorted.length; i++) {
		const key = positionSorted[i];
		const cachedHtml = _bibEngine.getIndividualBibHtmlCached(key);
		if (cachedHtml === undefined) {
			allCached = false;
			break;
		}
		const entryText = entryHtmlToPlainText(cachedHtml, i + 1);
		if (entryText) entries.push(entryText);
	}

	if (!allCached) {
		// 缓存 miss：触发后台异步拉取（fire-and-forget），本次放弃写入
		_bibEngine.precacheAllBibs(positionSorted);
		return;
	}

	if (entries.length === 0) return;
	const newText = '\n' + entries.join('\n') + '\n';

	// 5. 提取安全区内旧文本
	const oldText = docText.slice(zone.from, zone.to);

	// 6. ★ 严格 Diff 比对（核心防死循环）
	if (newText.trim() === oldText.trim()) return;

	// 7. 原子化静默写入
	if (zone.from > zone.to || zone.from > docText.length) {
		console.warn('[BibWriter] Invalid zone bounds from=' + zone.from +
			' to=' + zone.to + ' docLen=' + docText.length + ' — skipping');
		return;
	}
	console.log('[BibWriter] Writing bibliography (' +
		entries.length + ' entries, position-sorted) zone ' + zone.from + '-' + zone.to);
	view.dispatch({
		changes: { from: zone.from, to: zone.to, insert: newText },
	});
}
