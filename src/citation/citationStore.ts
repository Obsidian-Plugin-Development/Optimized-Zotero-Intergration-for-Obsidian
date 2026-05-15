/**
 * v6.5 Citation Store — 模块级引注状态共享（替代 StateField）
 *
 * 原因：Obsidian 的 registerEditorExtension 对 CM6 StateField 支持不完整 —
 * StateField.create() 正常触发，但 update() 从不被调用。
 *
 * 新方案：cm6LivePreview.compute() 每次重扫文档时更新此 Store，
 * bibliographyWriter 直接读取，无 StateField 依赖。
 *
 * v6.7: 移除 bibBlock（改用原生标题定位，不再需要特殊锚点扫描）。
 * v6.8: 添加 keyPositions 追踪每个 citekey 的文档物理位置，供文末参考文献按位置排序。
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

/** 扫描文档全文，更新 Store + 返回结果 */
export function updateCitationStore(docText: string): CitationStore {
	const keyToNumber = new Map<string, number>();
	const keyPositions = new Map<string, number>();
	const sortedUniqueKeys: string[] = [];
	let nextNum = 1;

	// 扫描 [@citekey] 引注
	const citePattern = /\[@([^\]]+)\]/g;
	let match: RegExpExecArray | null;
	while ((match = citePattern.exec(docText)) !== null) {
		const rawKeys = match[1]
			.split(';')
			.map(s => s.trim().replace(/^@/, ''))
			.filter(Boolean);
		for (const k of rawKeys) {
			if (!keyToNumber.has(k)) {
				keyToNumber.set(k, nextNum++);
				sortedUniqueKeys.push(k);
				// 记录首次出现的物理位置（v6.8 供文末参考文献按位置排序）
				keyPositions.set(k, match.index);
			}
		}
	}

	citationStore.sortedUniqueKeys = sortedUniqueKeys;
	citationStore.keyToNumber = keyToNumber;
	citationStore.keyPositions = keyPositions;

	return citationStore;
}
