/**
 * v7.2 Bibliography Writer — 智能标题生命周期 + CSL HTML→MD + 严格控行
 *
 * 恢复 CSL 引擎处理参考文献，固定使用 Nature 样式。
 * BBT 生成 HTML 后，本地转换为 Markdown（斜体→*、粗体→**、剥离其余标签）。
 *
 * 触发时机：
 *   仅通过全局命令 sync-bibliography 或悬浮球菜单手动触发。
 *   绝对禁止在引注插入/修改/删除时自动更新文末列表。
 *
 * 智能标题管理：
 *   场景 A：正文无引注 + 存在标题 → 彻底删除标题及下方旧列表
 *   场景 B：正文有引注 + 无标题 → 在文档 EOF 自动创建标题+列表
 *   场景 C：正文有引注 + 已有标题 → 紧贴标题更新列表（无空行）
 *
 * 状态指示：
 *   isBibOutOfSync — 正文引注变动时置 true，写入完成后置 false。
 *   悬浮球根据此标志切换 file-pen / file-text 图标。
 */
import { EditorView } from '@codemirror/view';
import type { CitationEngine } from './citationEngine';
import { citationStore } from './citationStore';

// ── 引注签名提取（防 HUD 误触发）──
const CITE_PATTERN = /\[@([^\]]+)\]/g;

/**
 * 从文档文本中提取引注签名。
 * 按文档位置顺序收集所有 citekey，用逗号连接。
 * 签名一致表示引注未变，HUD 无需切换为 out-of-sync 状态。
 */
export function extractCitationSignature(text: string): string {
	const keys: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = CITE_PATTERN.exec(text)) !== null) {
		const rawKeys = match[1]
			.split(';')
			.map(s => s.trim().replace(/^@/, ''))
			.filter(Boolean);
		keys.push(...rawKeys);
	}
	return keys.join(',');
}

/** 基于文件路径的引注签名缓存，防止跨文档污染 */
const _signatureCache = new Map<string, string>();

export function getLastCitationSignature(filePath: string): string | null {
	return _signatureCache.has(filePath) ? _signatureCache.get(filePath)! : null;
}

export function setLastCitationSignature(filePath: string, sig: string) {
	_signatureCache.set(filePath, sig);
}

// ── 模块级状态 ──
let _bibEngine: CitationEngine;
let _bibHeading = '参考文献';
export let isBibOutOfSync = false;

/** dirty 状态变更回调列表 */
const dirtyCallbacks: Array<(dirty: boolean) => void> = [];

/** 注册 dirty 状态变更回调（供 SyncFloatingButton 监听图标切换） */
export function onBibDirtyChange(cb: (dirty: boolean) => void): () => void {
	dirtyCallbacks.push(cb);
	return () => {
		const idx = dirtyCallbacks.indexOf(cb);
		if (idx >= 0) dirtyCallbacks.splice(idx, 1);
	};
}

function setBibDirty(dirty: boolean) {
	if (isBibOutOfSync === dirty) return;
	isBibOutOfSync = dirty;
	for (const cb of dirtyCallbacks) {
		try { cb(dirty); } catch { /* 静默 */ }
	}
}

/** 正文引注变动时调用（cm6LivePreview 触发） */
export function markBibDirty() {
	setBibDirty(true);
}

/** 参考文献写入完成后调用（sync-bibliography 命令触发） */
export function markBibClean() {
	setBibDirty(false);
}

export function initBibliographyWriter(engine: CitationEngine, heading: string) {
	_bibEngine = engine;
	_bibHeading = heading || '参考文献';
}

/** 运行时更新参考文献标题（设置变更时调用） */
export function setBibliographyHeading(heading: string) {
	_bibHeading = heading || '参考文献';
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

// ── CSL HTML → Markdown 转换 ──

/**
 * 将 CSL 引擎生成的单篇参考文献 HTML 转换为 Markdown。
 *
 * 规则：
 *   - <i> / <em> → *（斜体，单星号）
 *   - <b> / <strong> → **（粗体，双星号）
 *   - 剥离其余所有 HTML 标签
 *   - 解码常见 HTML 实体
 *
 * v7.2: 修复双重序号 — 转换后剥离 CSL 引擎自带的行首编号（如 1. [1] (1) 等）。
 */
function htmlToMarkdown(html: string): string {
	let md = html
		// 解码常见 HTML 实体
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		// 斜体：<i> / <em> → *
		.replace(/<\/?i\b[^>]*>/g, '*')
		.replace(/<\/?em\b[^>]*>/g, '*')
		// 粗体：<b> / <strong> → **
		.replace(/<\/?b\b[^>]*>/g, '**')
		.replace(/<\/?strong\b[^>]*>/g, '**')
		// 剥离剩余所有 HTML 标签
		.replace(/<[^>]*>/g, '')
		// 合并多余空白
		.replace(/\s+/g, ' ')
		.trim();

	// ★ v7.2: 暴力剔除 CSL 引擎自带的行首编号（修复双重序号 1. 1. xxx）
	// 处理格式：1.、[1]、1:、(1)、1 等，后跟可选空格
	md = md.replace(/^\s*\[?\d+\]?\s*[\.\:\)]\s*/, '').trim();

	return md;
}

// ── 安全区定位 ──

interface BibliographyZone {
	from: number;
	to: number;
}

/**
 * 在文档中定位参考文献标题，返回其下方的"安全区"。
 * 安全区起点为标题行末尾（含换行符），终点为下一个同级或更高级标题的位置。
 * 若未找到标题则返回 null。
 */
function findBibliographyZone(docText: string): BibliographyZone | null {
	const headingPattern = buildHeadingPattern();
	const match = headingPattern.exec(docText);
	if (!match) return null;

	const headingLevel = match[1].length;
	const headingEnd = match.index + match[0].length;

	// 安全区起点：标题行末尾（包含标题行换行符，杜绝空行累加）
	const zoneStart = Math.min(headingEnd, docText.length);

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

// ── 辅助：获取按物理位置排序的 citekey 列表 ──

function getPositionSortedKeys(): string[] {
	const { sortedUniqueKeys, keyPositions } = citationStore;
	return [...sortedUniqueKeys].sort(
		(a, b) => (keyPositions.get(a) ?? Infinity) - (keyPositions.get(b) ?? Infinity),
	);
}

// ── 辅助：从缓存组装 Markdown 条目列表 ──

function assembleEntries(positionSorted: string[]): string[] | null {
	const entries: string[] = [];
	let allCached = true;

	for (let i = 0; i < positionSorted.length; i++) {
		const key = positionSorted[i];
		const html = _bibEngine.getIndividualBibHtmlCached(key);
		if (html === undefined) {
			allCached = false;
			break;
		}
		const md = htmlToMarkdown(html);
		if (md) {
			entries.push(`${i + 1}. ${md}`);
		}
	}

	if (!allCached) {
		_bibEngine.precacheAllBibs(positionSorted);
		return null;
	}

	return entries;
}

// ── 核心写入逻辑 ──

/**
 * v7.2 参考文献全自动生命周期管理。
 *
 * 场景 A — 引注为空，打扫战场：
 *   删除标题所在整行 + 下方旧列表，直到下一个同级标题或 EOF。
 *
 * 场景 B — 有引注，无标题，自动创建：
 *   在文档 EOF 追加 \n\n## 标题\n列表\n（标题与列表间无空行）。
 *
 * 场景 C — 有引注，已有标题，精确更新：
 *   安全区覆盖标题行末尾 \n，插入 \n列表\n\n（标题与列表间永无空行）。
 */
export function updateBibliographyText(view: EditorView, filePath?: string) {
	const docText = view.state.doc.toString();
	const headingPattern = buildHeadingPattern();
	const headingMatch = headingPattern.exec(docText);

	const positionSorted = getPositionSortedKeys();

	// ═══════════════════════════════════════════
	// 场景 A：无引注 + 存在标题 → 彻底打扫战场
	// ═══════════════════════════════════════════
	if (positionSorted.length === 0 && headingMatch) {
		const headingStart = headingMatch.index;
		const headingLevel = headingMatch[1].length;

		// 终点：下一个同级或更高级标题，若没有则到 EOF
		const searchStart = headingMatch.index + headingMatch[0].length;
		const searchText = docText.slice(searchStart);
		const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
		const nextMatch = nextHeadingPattern.exec(searchText);
		const deleteEnd = nextMatch ? searchStart + nextMatch.index : docText.length;

		console.log('[BibWriter] Scenario A: deleting bibliography section ' +
			headingStart + '-' + deleteEnd);
		view.dispatch({
			changes: { from: headingStart, to: deleteEnd, insert: '' },
		});

		setBibDirty(false);
		setLastCitationSignature(filePath || '', '');
		return;
	}

	// 无引注且无标题 → 无事可做
	if (positionSorted.length === 0) return;

	// ── 从缓存组装条目 ──
	const entries = assembleEntries(positionSorted);
	if (entries === null) return;       // 缓存 miss，已触发后台拉取
	if (entries.length === 0) return;

	const markdownList = entries.join('\n');

	// ═══════════════════════════════════════════
	// 场景 B：有引注 + 无标题 → 在 EOF 自动创建
	// ═══════════════════════════════════════════
	if (!headingMatch) {
		const headingText = _bibHeading;
		// 标题下方紧跟列表，无空行
		const insertText = '\n\n## ' + headingText + '\n' + markdownList + '\n';
		const eof = docText.length;

		console.log('[BibWriter] Scenario B: auto-creating bibliography at EOF (' +
			entries.length + ' entries)');
		view.dispatch({
			changes: { from: eof, to: eof, insert: insertText },
		});

		setBibDirty(false);
		setLastCitationSignature(filePath || '', extractCitationSignature(view.state.doc.toString()));
		return;
	}

	// ═══════════════════════════════════════════
	// 场景 C：有引注 + 已有标题 → 精确更新
	// ═══════════════════════════════════════════
	const zone = findBibliographyZone(docText);
	if (!zone) return;

	// 标题与列表间不留空行
	const finalInsertText = '\n' + markdownList.trim() + '\n\n';

	const oldText = docText.slice(zone.from, zone.to);

	// 严格 Diff 比对（防死循环）
	if (finalInsertText === oldText) return;

	if (zone.from > zone.to || zone.from > docText.length) {
		console.warn('[BibWriter] Invalid zone bounds from=' + zone.from +
			' to=' + zone.to + ' docLen=' + docText.length + ' — skipping');
		return;
	}

	console.log('[BibWriter] Scenario C: updating bibliography (' +
		entries.length + ' entries) zone ' + zone.from + '-' + zone.to);
	view.dispatch({
		changes: { from: zone.from, to: zone.to, insert: finalInsertText },
	});

	// 写入成功 → 标记为已同步
	setBibDirty(false);
	setLastCitationSignature(filePath || '', extractCitationSignature(view.state.doc.toString()));
}
