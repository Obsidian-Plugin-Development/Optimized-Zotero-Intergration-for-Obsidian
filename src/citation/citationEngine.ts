/**
 * v7.0 引注引擎（轻量化）
 *
 * 职责：扫描文档 [@citekey]、批量解析 BBT 数据、按首次出现顺序分配编号、缓存结果。
 * 无 CSL 依赖 — 行内渲染硬编码上标，文末参考文献由 bibliographyWriter 本地组装。
 */
import type ZoteroConnector from '../main';
import { getBibFromCiteKey, getBibFromCiteKeys, getItemJSONFromCiteKeys } from '../bbt/jsonRPC';
import type { CiteKey } from '../bbt/cayw';
import type { DatabaseWithPort } from '../types';
import type { CitationCacheEntry, CitationData, DocumentScanResult } from './citationTypes';

/** 5 分钟缓存有效期 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** BBT 批量解析防抖延迟 */
const RESOLVE_DEBOUNCE_MS = 300;

/**
 * v6.2 从 Zotero 条目 JSON 中鲁棒提取 URL 和 DOI。
 *
 * 优先级链：
 *   1. item.url / item.URL
 *   2. item.extra 字段中的 URL: ... 行
 *   3. item.DOI / item.doi → 拼接 https://doi.org/${doi}
 *   4. item.extra 中的 DOI: ... 行 → 拼接
 */
function extractUrl(item: any): { url?: string; doi?: string } {
	const url =
		item.url || item.URL ||
		(item.extra && item.extra.match(/^URL:\s*(\S+)/m)?.[1]) ||
		undefined;

	const doi =
		item.DOI || item.doi ||
		(item.extra && item.extra.match(/^DOI:\s*(\S+)/im)?.[1]) ||
		undefined;

	return { url, doi };
}

export class CitationEngine {
	private plugin: ZoteroConnector;
	private cache = new Map<string, CitationCacheEntry>();
	private resolveTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingKeys = new Set<string>();
	private resolvePromise: Promise<Map<string, CitationData>> | null = null;
	/** 当前文档的 citekey → 全局序号映射（由 scanDocument 填充） */
	private currentKeyToNumber = new Map<string, number>();
	/** 逐篇参考文献 HTML 缓存（供 hover popover 精准渲染） */
	private individualBibHtmlCache = new Map<string, string>();
	/** 逐篇元数据缓存（DOI、URL）— 独立于 batch fetch 的 formattedHtml */
	private individualMetaCache = new Map<string, { doi?: string; url?: string }>();
	/** 合并参考文献 HTML 缓存（供 hover popover 批量渲染） */
	private combinedBibCache = new Map<string, string>();
	/** v7.0: 逐篇 CSL-JSON 元数据缓存（供 bibliographyWriter 本地组装 Nature 格式） */
	private individualJsonCache = new Map<string, any>();

	constructor(plugin: ZoteroConnector) {
		this.plugin = plugin;
	}

	/** 获取 citekey 在当前文档中的全局序号（1‑based），未扫描到时返回 0 */
	getNumber(key: string): number {
		return this.currentKeyToNumber.get(key) || 0;
	}
		/**
		 * v6.5 从 cm6LivePreview 同步 key→number 映射。
		 * 由 CitationPluginValue.compute() 调用。
		 */
		syncKeyToNumber(map: Map<string, number>): void {
			this.currentKeyToNumber = map;
		}
	/**
	 * 扫描文档全文，返回所有 [@citekey] 的位置与全局编号。
	 * 编号按首次出现顺序分配（多引注 [@a; @b] 中每个 key 独立编号）。
	 */
	scanDocument(docText: string): DocumentScanResult {
		const pattern = /\[@([^\]]+)\]/g;
		const positions: Array<{ keys: string[]; from: number; to: number; rawText: string }> = [];
		const keyToNumber = new Map<string, number>();
		let nextNumber = 1;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(docText)) !== null) {
			const rawKeys = match[1]
				.split(';')
				.map((s) => s.trim().replace(/^@/, ''))
				.filter(Boolean);

			for (const k of rawKeys) {
				if (!keyToNumber.has(k)) {
					keyToNumber.set(k, nextNumber++);
				}
			}

			positions.push({
				keys: rawKeys,
				from: match.index,
				to: match.index + match[0].length,
				rawText: match[0],
			});
		}

		// 更新全局序号映射
		this.currentKeyToNumber = keyToNumber;
		return { positions, keyToNumber };
	}

	/**
	 * v6.1 全局引注映射刷新（供 CM6 ViewPlugin / PostProcessor 实时更新用）。
	 * 扫描文档全文，重新分配 key→number 序号映射。
	 * 返回当前有效的 Map<string, number>。
	 */
	refreshGlobalCitationMap(docText: string): Map<string, number> {
		return this.scanDocument(docText).keyToNumber;
	}

	/**
	 * 批量解析 citekey → CitationData。
	 * 带 300ms 防抖，积攒所有待解析 key 后一次性调用 BBT。
	 */
	async resolveCiteKeys(keys: string[]): Promise<Map<string, CitationData>> {
		const unique = [...new Set(keys)].filter(Boolean);
		if (unique.length === 0) return new Map();

		// 1. 检查缓存
		const result = new Map<string, CitationData>();
		const unresolved: string[] = [];
		const now = Date.now();

		for (const key of unique) {
			const cached = this.cache.get(key);
			if (cached && (now - cached.resolvedAt) < CACHE_TTL_MS) {
				result.set(key, cached.data);
			} else {
				unresolved.push(key);
			}
		}

		if (unresolved.length === 0) return result;

		// 2. 积攒到 pending 队列，防抖批量解析
		for (const key of unresolved) {
			this.pendingKeys.add(key);
		}

		if (!this.resolvePromise) {
			this.resolvePromise = new Promise<Map<string, CitationData>>((resolve) => {
				clearTimeout(this.resolveTimer!);
				this.resolveTimer = setTimeout(async () => {
					const batch = [...this.pendingKeys];
					this.pendingKeys.clear();
					this.resolvePromise = null;
					this.resolveTimer = null;

					const batchResult = await this.fetchBatch(batch);
					resolve(batchResult);
				}, RESOLVE_DEBOUNCE_MS);
			});
		}

		// 3. 等待批量解析完成，合并结果
		const batchResult = await this.resolvePromise;
		for (const [key, data] of batchResult) {
			result.set(key, data);
		}
		return result;
	}

	/**
	 * 实际调用 BBT JSON-RPC 批量获取参考文献和元数据。
	 */
	private async fetchBatch(keys: string[]): Promise<Map<string, CitationData>> {
		const result = new Map<string, CitationData>();
		if (keys.length === 0) return result;

		const database: DatabaseWithPort = {
			database: this.plugin.settings.database,
			port: (this.plugin.settings as any).port,
		};

		// v7.0: 硬编码 Nature CSL 用于 BBT 格式化
		const bibCsl = 'nature';

		// 构造 CiteKey[] — library 默认 1，BBT 会正确解析
		const citeKeyObjs: CiteKey[] = keys.map((k) => ({ key: k, library: 1 }));

		try {
			// 批量获取参考文献 HTML（Nature 格式，用于悬浮弹窗）
			const bibHtml = await getBibFromCiteKeys(citeKeyObjs, database, bibCsl, 'html', true);

			// 批量获取条目 JSON（含完整 CSL-JSON 元数据 + DOI、URL、itemKey、libraryID）
			let itemsJson: any[] = [];
			try {
				const raw = await getItemJSONFromCiteKeys(citeKeyObjs, database, 1);
				if (Array.isArray(raw)) {
					itemsJson = raw;
				}
			} catch {
				// 非致命：JSON 获取失败不影响参考文献渲染
			}

			// 为每个 citekey 构建 CitationData + 缓存 CSL-JSON
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				const item = itemsJson[i] || {};
				const itemKey = item.key || item.itemID || '';
				const libraryID = item.libraryID || item.library || 1;
				const doi = item.DOI || item.doi || '';
				const url = item.url || '';
				const num = this.currentKeyToNumber.get(key) || 0;

				// v7.0: 缓存完整 CSL-JSON 元数据供 bibliographyWriter 本地组装
				if (item && Object.keys(item).length > 0) {
					this.individualJsonCache.set(key, item);
				}

				const data: CitationData = {
					number: num,
					formattedHtml: bibHtml || '',
					inlineText: num > 0 ? `[${num}]` : '[?]',
					doi: doi || undefined,
					url: url || undefined,
					zoteroSelectUri: itemKey ? `zotero://select/library/items/${itemKey}` : undefined,
					itemKey: itemKey || undefined,
					libraryID,
				};

				this.cache.set(key, { resolvedAt: Date.now(), data });
				result.set(key, data);
			}
		} catch (e) {
			console.error('[CitationEngine] BBT resolve failed:', e);
			// 返回部分结果：未解析的 key 标记为未知
			for (const key of keys) {
				if (!result.has(key)) {
					const num = this.currentKeyToNumber.get(key) || 0;
					const data: CitationData = {
						number: num,
						formattedHtml: '',
						inlineText: num > 0 ? `[${num}]` : '[?]',
					};
					this.cache.set(key, { resolvedAt: Date.now(), data });
					result.set(key, data);
				}
			}
		}

		return result;
	}

	/**
	 * v6.1 获取单篇文献的参考文献 HTML（逐 citekey 调用 BBT）。
	 * 独立于 fetchBatch() 的组合 HTML，确保 hover popover 精准渲染。
	 * 结果缓存于 individualBibHtmlCache，invalidateCache() 时清除。
	 */
	async getIndividualBibHtml(key: string): Promise<string> {
		const cached = this.individualBibHtmlCache.get(key);
		if (cached !== undefined) return cached;

		const database: DatabaseWithPort = {
			database: this.plugin.settings.database,
			port: (this.plugin.settings as any).port,
		};
		const citeKey: CiteKey = { key, library: 1 };

		try {
			const html = await getBibFromCiteKey(citeKey, database, 'nature', 'html', true);
			const result = html || '';
			this.individualBibHtmlCache.set(key, result);
			return result;
		} catch {
			this.individualBibHtmlCache.set(key, '');
			return '';
		}
	}

	/**
	 * v6.2 同步读取缓存的单篇参考文献 HTML。
	 * 供 hover popover 零延迟渲染；若缓存未就绪则返回 undefined。
	 */
	getIndividualBibHtmlCached(key: string): string | undefined {
		const cached = this.individualBibHtmlCache.get(key);
		return cached !== undefined ? cached : undefined;
	}

	/**
	 * v7.0 同步读取缓存的单篇 CSL-JSON 元数据。
	 * 供 bibliographyWriter 本地组装 Nature 格式参考文献。
	 * 若缓存未就绪则返回 undefined。
	 */
	getIndividualJsonCached(key: string): any | undefined {
		return this.individualJsonCache.get(key);
	}

	/**
	 * v6.1 获取单篇文献的元数据（DOI、URL）。
	 * 独立于 batch fetch，确保 popover 每个卡片拿到自己的链接。
	 * 静默模式：不发 LoadingModal、不弹 Notice。
	 */
	async getIndividualMeta(key: string): Promise<{ doi?: string; url?: string }> {
		const cached = this.individualMetaCache.get(key);
		if (cached) return cached;

		const database: DatabaseWithPort = {
			database: this.plugin.settings.database,
			port: (this.plugin.settings as any).port,
		};
		const citeKey: CiteKey = { key, library: 1 };

		try {
			const raw = await getItemJSONFromCiteKeys([citeKey], database, 1, true);
			const items: any[] = Array.isArray(raw) ? raw : [];
			const item = items[0] || {};
			const meta = extractUrl(item);
			this.individualMetaCache.set(key, meta);
			return meta;
		} catch {
			const empty = { doi: undefined, url: undefined };
			this.individualMetaCache.set(key, empty);
			return empty;
		}
	}

	/**
	 * v6.2 同步读取缓存的单篇文献元数据。
	 * 供 hover popover 零延迟渲染；若缓存未就绪则返回 undefined。
	 */
	getIndividualMetaCached(key: string): { doi?: string; url?: string } | undefined {
		return this.individualMetaCache.get(key);
	}

	/**
	 * v6.2 后台静默预缓存：在文档扫描后异步拉取所有 citekey 的
	 * 单篇参考文献 HTML + 元数据，存入 individualBibHtmlCache / individualMetaCache。
	 *
	 * ★ 绝对静默：无 LoadingModal、无 Notice、无 console noise。
	 * ★ 异步 fire‑and‑forget：调用方不等待、不阻塞主线程。
	 * ★ 自动跳过已缓存 key，仅拉取缺失项。
	 */
	precacheAllBibs(keys: string[]): void {
		const unique = [...new Set(keys)].filter(Boolean);
		if (unique.length === 0) return;

		const uncachedBib = unique.filter(k => this.individualBibHtmlCache.get(k) === undefined);
		const uncachedMeta = unique.filter(k => !this.individualMetaCache.has(k));
		const uncachedJson = unique.filter(k => !this.individualJsonCache.has(k));

		if (uncachedBib.length === 0 && uncachedMeta.length === 0 && uncachedJson.length === 0) return;

		// Fire‑and‑forget：不阻塞、不等待
		(async () => {
			const database: DatabaseWithPort = {
				database: this.plugin.settings.database,
				port: (this.plugin.settings as any).port,
			};

			// 逐篇拉取 bib HTML（Nature 格式，独立请求，确保每篇文献 HTML 隔离）
			for (const key of uncachedBib) {
				try {
					const html = await getBibFromCiteKey(
						{ key, library: 1 }, database, 'nature', 'html', true,
					);
					this.individualBibHtmlCache.set(key, html || '');
				} catch {
					this.individualBibHtmlCache.set(key, '');
				}
			}

			// v7.0: 批量拉取 CSL-JSON 元数据（供 bibliographyWriter 本地组装）
			if (uncachedJson.length > 0) {
				try {
					const citeKeyObjs: CiteKey[] = uncachedJson.map(k => ({ key: k, library: 1 }));
					const raw = await getItemJSONFromCiteKeys(citeKeyObjs, database, 1, true);
					const items: any[] = Array.isArray(raw) ? raw : [];
					for (let i = 0; i < uncachedJson.length; i++) {
						const key = uncachedJson[i];
						const item = items[i] || {};
						if (item && Object.keys(item).length > 0) {
							this.individualJsonCache.set(key, item);
						}
					}
				} catch {
					// 静默失败
				}
			}

			// 批量拉取元数据（DOI/URL — 一次 BBT 调用覆盖所有 key，高效）
			if (uncachedMeta.length > 0) {
				try {
					const citeKeyObjs: CiteKey[] = uncachedMeta.map(k => ({ key: k, library: 1 }));
					const raw = await getItemJSONFromCiteKeys(citeKeyObjs, database, 1, true);
					const items: any[] = Array.isArray(raw) ? raw : [];
					for (let i = 0; i < uncachedMeta.length; i++) {
						const key = uncachedMeta[i];
						const item = items[i] || {};
						this.individualMetaCache.set(key, extractUrl(item));
					}
				} catch {
					for (const key of uncachedMeta) {
						if (!this.individualMetaCache.has(key)) {
							this.individualMetaCache.set(key, { doi: undefined, url: undefined });
						}
					}
				}
			}
		})().catch(() => {}); // 静默处理所有异常
		}

		// ── v6.4 合并参考文献 HTML（供 bibliography widget）──

		/** 同步读取合并参考文献 HTML 缓存 */
		getCombinedBibliographyCached(keys: string[]): string | undefined {
			const cacheKey = [...keys].sort().join(',');
			return this.combinedBibCache.get(cacheKey);
		}

		/**
		 * v6.4 异步获取一组 citekey 的合并参考文献 HTML。
		 * 使用 bibliography CSL 样式，返回全部条目拼接的 HTML。
		 * 结果缓存于 combinedBibCache。
		 */
		async getCombinedBibliographyHtml(keys: string[]): Promise<string> {
			if (keys.length === 0) return '';
			const cacheKey = [...keys].sort().join(',');
			const cached = this.combinedBibCache.get(cacheKey);
			if (cached !== undefined) return cached;
			const database: DatabaseWithPort = {
				database: this.plugin.settings.database,
				port: (this.plugin.settings as any).port,
			};
			const citeKeyObjs: CiteKey[] = keys.map(k => ({ key: k, library: 1 }));
			try {
				const html = await getBibFromCiteKeys(citeKeyObjs, database, 'nature', 'html', true);
				// 清洗 CSL 残留内联样式
				const cleaned = (html || '')
					.replace(/color\s*:\s*[^;>"]+[;>"]?\s*/gi, '')
					.replace(/opacity\s*:\s*[^;>"]+[;>"]?\s*/gi, '');
				this.combinedBibCache.set(cacheKey, cleaned);
				return cleaned;
			} catch {
				const fallback = '';
				this.combinedBibCache.set(cacheKey, fallback);
				return fallback;
			}
		}

		/** 清除所有缓存（CSL 样式或数据库变更时调用） */
		invalidateCache(): void {
		this.cache.clear();
		this.individualBibHtmlCache.clear();
		this.individualMetaCache.clear();
		this.individualJsonCache.clear();
		this.combinedBibCache.clear();
	}

	/** 查询缓存中的单个 citekey */
	getCached(key: string): CitationCacheEntry | undefined {
		const entry = this.cache.get(key);
		if (entry && (Date.now() - entry.resolvedAt) < CACHE_TTL_MS) {
			return entry;
		}
		return undefined;
	}

}
