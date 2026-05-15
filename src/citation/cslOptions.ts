/**
 * v6.9 CSL 样式选项检测 —— 双保险策略
 *
 * 1. 优先尝试读取本地 Zotero 数据目录下的 styles/ 文件夹，
 *    解析 .csl 文件的 <title> 作为显示名称，绝对路径作为选项值。
 * 2. 若本地检测失败（无 fs 模块、目录不存在、权限不足），
 *    回退到硬编码的常用核心 CSL 样式列表。
 *
 * 结果在模块级缓存——同一 Obsidian 会话内不会重复检测。
 */

export interface CslOption {
	/** 存储在 settings 中的值（style name 或本地绝对路径） */
	value: string;
	/** 下拉菜单中的显示名称 */
	label: string;
}

/** CSL 行内引注格式外壳（prefix/suffix/superscript） */
export interface CslFormatHint {
	prefix: string;
	suffix: string;
	superscript: boolean;
}

// ── 已知 CSL 样式名 → 行内引注格式（同步，无需网络请求）──

const KNOWN_STYLE_FORMATS: Record<string, CslFormatHint> = {
	'nature': { prefix: '', suffix: '', superscript: true },
	'science': { prefix: '', suffix: '', superscript: true },
	'ieee': { prefix: '[', suffix: ']', superscript: false },
	'apa': { prefix: '(', suffix: ')', superscript: false },
	'cell': { prefix: '', suffix: '', superscript: true },
	'chicago-author-date': { prefix: '(', suffix: ')', superscript: false },
	'chicago-note-bibliography': { prefix: '', suffix: '', superscript: true },
	'gb-t-7714-2015-numeric': { prefix: '[', suffix: ']', superscript: false },
	'modern-language-association': { prefix: '(', suffix: ')', superscript: false },
	'harvard-cite-them-right': { prefix: '(', suffix: ')', superscript: false },
	'vancouver': { prefix: '', suffix: '', superscript: true },
	'american-medical-association': { prefix: '', suffix: '', superscript: true },
	'american-chemical-society': { prefix: '', suffix: '', superscript: true },
	'chinese-gb7714-2005-numeric': { prefix: '[', suffix: ']', superscript: false },
	'modern-language-association-9th-edition': { prefix: '(', suffix: ')', superscript: false },
};

// ── 从 CSL XML 提取 <citation> 内第一个 <layout> 的格式 ──

function extractFormatFromXml(xml: string): CslFormatHint | null {
	// 限定在 <citation> 节内查找，避免匹配到 <bibliography> 的 layout
	const citationMatch = xml.match(/<citation[^>]*>([\s\S]*?)<\/citation>/);
	const searchText = citationMatch ? citationMatch[1] : xml;
	const layoutMatch = searchText.match(/<layout\b([^>]*)>/);
	if (!layoutMatch) return null;
	const attrs = layoutMatch[1];
	const prefix = attrs.match(/prefix\s*=\s*"([^"]*)"/)?.[1] ?? '';
	const suffix = attrs.match(/suffix\s*=\s*"([^"]*)"/)?.[1] ?? '';
	const superscript = /vertical-align\s*=\s*"sup"/.test(attrs);
	return { prefix, suffix, superscript };
}

/**
 * 同步检测 CSL 样式对应的行内引注格式。
 *
 * 1. 本地绝对路径 → 同步读取 .csl 文件提取 <citation><layout> 属性
 * 2. 已知样式名 → 返回内置格式映射
 * 3. 否则返回 null（需异步获取 CSL XML）
 */
export function detectCslFormat(styleValue: string): CslFormatHint | null {
	if (!styleValue) return null;

	// 本地绝对路径 → 同步读取
	const isLocal = /^[A-Za-z]:\\/.test(styleValue) || /^\//.test(styleValue);
	if (isLocal) {
		try {
			const fs = require('fs');
			if (fs.existsSync(styleValue)) {
				const xml = fs.readFileSync(styleValue, 'utf-8') as string;
				return extractFormatFromXml(xml);
			}
		} catch { /* 权限不足 */ }
		return null;
	}

	// 样式名 → 已知格式映射（去 .csl 后缀后匹配）
	const name = styleValue.replace(/\.csl$/i, '');
	const known = KNOWN_STYLE_FORMATS[name];
	if (known) return known;

	// URL / 未知样式名 → 无法同步获取
	return null;
}

/** 将 CslFormatHint 转为可视化 HTML 片段 */
export function formatHintToHtml(hint: CslFormatHint | null): string {
	if (!hint) return '';
	if (hint.superscript) return '<sup>1</sup>';
	return `${hint.prefix}1${hint.suffix}`;
}

// ── 平台相关的 Zotero styles 目录候选列表 ──

const ZOTERO_STYLES_CANDIDATES: Record<string, string[]> = {
	win32: [
		'%APPDATA%\\Zotero\\Zotero\\styles',
		'%APPDATA%\\Zotero\\styles',
		'%USERPROFILE%\\Zotero\\styles',
	],
	darwin: [
		'%HOME%/Zotero/styles',
		'%HOME%/Library/Application Support/Zotero/styles',
	],
	linux: [
		'%HOME%/Zotero/styles',
		'%HOME%/.zotero/zotero/defaults/styles',
	],
};

// ── 硬编码保底列表（从 cslListRaw 精选最常用样式）──

function getFallbackOptions(): CslOption[] {
	return [
		{ value: 'nature', label: 'Nature (superscript numbers)' },
		{ value: 'science', label: 'Science (italic numbers)' },
		{ value: 'apa', label: 'APA 7th Edition (author-year)' },
		{ value: 'ieee', label: 'IEEE (bracket numbers)' },
		{ value: 'cell', label: 'Cell (author-year)' },
		{ value: 'chicago-author-date', label: 'Chicago Author-Date' },
		{ value: 'chicago-note-bibliography', label: 'Chicago Note-Bibliography' },
		{ value: 'gb-t-7714-2015-numeric', label: 'GB/T 7714-2015 Numeric' },
		{ value: 'modern-language-association', label: 'MLA 9th Edition' },
		{ value: 'harvard-cite-them-right', label: 'Harvard' },
		{ value: 'vancouver', label: 'Vancouver (superscript)' },
		{ value: 'american-medical-association', label: 'AMA 11th Edition' },
		{ value: 'american-chemical-society', label: 'ACS' },
		{ value: 'chinese-gb7714-2005-numeric', label: 'GB/T 7714-2005 (中文)' },
		{ value: 'modern-language-association-9th-edition', label: 'MLA 9th (full)' },
	];
}

// ── 辅助：展开路径中的环境变量 ──

function expandEnvVars(template: string, homedir: string): string {
	return template
		.replace(/%HOME%/g, homedir)
		.replace(/%USERPROFILE%/g, homedir)
		.replace(/%APPDATA%/g, (typeof process !== 'undefined' && process.env?.APPDATA) || homedir);
}

// ── 辅助：从 CSL XML 提取 <title> ──

function extractCslTitle(filePath: string, filename: string): string | null {
	try {
		const fs = require('fs');
		const content = fs.readFileSync(filePath, 'utf-8') as string;
		const m = content.match(/<title[^>]*>([^<]+)<\/title>/);
		if (m) return m[1].trim();
		// 回退：文件名去 .csl 后缀
		return filename.replace(/\.csl$/i, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	} catch {
		return null;
	}
}

// ── 模块级缓存 ──

let _cachedOptions: CslOption[] | null = null;

/**
 * 检测可用的 CSL 样式选项。
 * 优先本地 Zotero styles 目录，保底硬编码列表。
 * 结果在模块级缓存（幂等）。
 */
export function detectCslOptions(): CslOption[] {
	if (_cachedOptions) return _cachedOptions;

	try {
		const fs = require('fs');
		const os = require('os');
		const path = require('path');

		const platform: string = os.platform();
		const homedir: string = os.homedir();
		const candidates = ZOTERO_STYLES_CANDIDATES[platform] || [];

		let stylesDir: string | null = null;
		for (const raw of candidates) {
			const candidate = expandEnvVars(raw, homedir);
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
					stylesDir = candidate;
					break;
				}
			} catch { /* 权限不足或路径不存在 */ }
		}

		if (stylesDir) {
			const files: string[] = fs.readdirSync(stylesDir) as string[];
			const cslFiles = files.filter((f: string) => f.endsWith('.csl'));

			if (cslFiles.length > 0) {
				const options: CslOption[] = [];
				for (const filename of cslFiles) {
					const fullPath = path.join(stylesDir, filename);
					const label = extractCslTitle(fullPath, filename);
					if (label) {
						options.push({ value: fullPath, label });
					}
				}
				options.sort((a, b) => a.label.localeCompare(b.label));
				if (options.length > 0) {
					_cachedOptions = options;
					return _cachedOptions;
				}
			}
		}
	} catch {
		// fs/os/path 不可用（移动端/非 Node.js 环境）→ 回退
	}

	_cachedOptions = getFallbackOptions();
	return _cachedOptions;
}

/**
 * 清除模块级 CSL 选项缓存。
 * 设置面板每次打开时调用，确保新增的 Zotero CSL 文件被检测到。
 */
export function invalidateCslOptionCache(): void {
	_cachedOptions = null;
}

/**
 * 确保当前设置值在选项列表中可见。
 * 若 customValue 非空且不在 options 中，将其前置插入，
 * 保证用户已有的自定义 CSL 样式不会"凭空消失"。
 */
export function ensureCustomValueInOptions(
	options: CslOption[],
	currentValue: string | undefined,
): CslOption[] {
	if (!currentValue || currentValue.trim() === '') return options;
	const exists = options.some(
		opt => opt.value === currentValue || opt.label === currentValue,
	);
	if (exists) return options;

	return [
		{ value: currentValue, label: currentValue },
		...options,
	];
}
