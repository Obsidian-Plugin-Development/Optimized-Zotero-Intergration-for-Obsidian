/**
 * v7.3 Citation Store — 模块级引注状态共享（替代 StateField）
 *
 * 原因：Obsidian 的 registerEditorExtension 对 CM6 StateField 支持不完整 —
 * StateField.create() 正常触发，但 update() 从不被调用。
 *
 * 新方案：cm6LivePreview.compute() 每次重扫文档时更新此 Store，
 * bibliographyWriter 直接读取，无 StateField 依赖。
 *
 * v7.3: unifiedScanDocument() 一次正则扫描产出全部数据 —
 *   positions, signature, keyToNumber, keyPositions，消除 cm6LivePreview 中
 *   三次重复全文档正则扫描。
 */
/** 文档中一处引注的位置信息 */
export interface CitePos {
	keys: string[];
	from: number;
	to: number;
}

export interface CitationStore {
	/** 按首次出现顺序排列的全局唯一 citekey 列表 */
	sortedUniqueKeys: string[];
	/** citekey → 全局编号 (1-based) */
	keyToNumber: Map<string, number>;
	/** citekey → 文档中首次出现的物理位置（from 索引），用于文末参考文献物理排序 */
	keyPositions: Map<string, number>;
}

export const citationStore: CitationStore = {
	sortedUniqueKeys: [],
	keyToNumber: new Map(),
	keyPositions: new Map(),
};

/** 一次扫描的全部产出 */
export interface UnifiedScanResult {
	positions: CitePos[];
	/** 排序去重后的 citekey 签名，用于 bibliographyWriter 脏检测 */
	signature: string;
	keyToNumber: Map<string, number>;
	keyPositions: Map<string, number>;
	sortedUniqueKeys: string[];
}

const CITE_PATTERN = /\[@([^\]]+)\]/g;

/**
 * v7.3 统一文档扫描 — 一次正则扫描产出全部数据。
 *
 * 替代原来分散在 bibliographyWriter.extractCitationSignature、
 * citationStore.updateCitationStore、cm6LivePreview.scanDocumentForCitations
 * 的三次独立全文档正则扫描。
 */
export function unifiedScanDocument(docText: string): UnifiedScanResult {
	const positions: CitePos[] = [];
	const keyToNumber = new Map<string, number>();
	const keyPositions = new Map<string, number>();
	const sortedUniqueKeys: string[] = [];
	const allKeys: string[] = []; // 收集所有 key 用于签名计算
	let nextNum = 1;

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

		for (const k of rawKeys) {
			allKeys.push(k);
			if (!keyToNumber.has(k)) {
				keyToNumber.set(k, nextNum++);
				sortedUniqueKeys.push(k);
				keyPositions.set(k, match.index);
			}
		}
	}

	// ★ 签名：Set 去重 + 排序，确保相同集合生成相同签名
	const signature = [...new Set(allKeys)].join(',');

	return { positions, signature, keyToNumber, keyPositions, sortedUniqueKeys };
}

/**
 * v7.3 兼容旧接口：cm6LivePreview 和 bibliographyWriter 仍调用此函数。
 * 内部委托给 unifiedScanDocument，更新模块级 citationStore 并返回。
 */
export function updateCitationStore(docText: string): CitationStore {
	const result = unifiedScanDocument(docText);

	citationStore.sortedUniqueKeys = result.sortedUniqueKeys;
	citationStore.keyToNumber = result.keyToNumber;
	citationStore.keyPositions = result.keyPositions;

	return citationStore;
}
