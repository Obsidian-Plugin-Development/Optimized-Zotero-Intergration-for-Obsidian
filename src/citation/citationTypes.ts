/**
 * v6.0 引注渲染系统共享类型定义
 */

/** 文档中一处 [@citekey] 引用的解析位置 */
export interface CiteKeyPosition {
	key: string;      // e.g., "doe2020"
	from: number;     // byte offset of '['
	to: number;       // byte offset after ']'
	rawText: string;  // original "[@doe2020]" or "[@key1; @key2]"
}

/** 已解析的引注数据（从 Zotero BBT 获取） */
export interface CitationData {
	number: number;            // 文档内全局引用编号（1-based）
	formattedHtml: string;     // CSL 格式化后的参考文献 HTML
	inlineText: string;        // e.g., "[1]"
	doi?: string;
	url?: string;
	zoteroSelectUri?: string;  // zotero://select/library/items/ABCD...
	itemKey?: string;          // Zotero 条目 key
	libraryID?: number;
	noteExists?: boolean;      // [citekey].md 是否存在于 vault
}

/** 缓存条目 */
export interface CitationCacheEntry {
	resolvedAt: number;        // Date.now()
	data: CitationData;
}

/** 文档扫描结果 */
export interface DocumentScanResult {
	/** 按文档出现顺序排列的所有引用位置 */
	positions: CiteKeyPosition[];
	/** citekey → 全局引用编号（按首次出现顺序分配） */
	keyToNumber: Map<string, number>;
}

/**
 * 从 CSL XML 中提取的行内引注格式外壳。
 * 用于驱动 Widget 渲染，确保方括号/圆括号/上标等格式
 * 完全遵循当前 CSL 样式规范，不硬编码。
 */
export interface CitationFormat {
	/** 引注编号前缀，如 "[" 或 "(" */
	prefix: string;
	/** 引注编号后缀，如 "]" 或 ")" */
	suffix: string;
	/** 多引注分隔符，如 ", " 或 ";" */
	delimiter: string;
	/** 是否为上标格式（Nature 等期刊样式） */
	superscript: boolean;
}
