import { extractImpactFactor } from './styleManager';
import { SmartFieldOption } from '../types';
import {
  extractStatusFromTags,
  processItemRating,
} from './ZoteroDataProcessor';

// ── 字段选项定义 ──

export const SMART_FIELD_OPTIONS: SmartFieldOption[] = [
  { value: 'title_smart', label: '文献标题' },
  { value: 'authors_smart', label: '文献作者' },
  { value: 'journal_full', label: '期刊全称' },
  { value: 'journal_abbr', label: '期刊简称' },
  { value: 'journal_smart', label: '期刊智能' },
  { value: 'year', label: '发表年份' },
  { value: 'collections_path', label: '文库分类' },
  { value: 'impact_factor_smart', label: '影响因子' },
  { value: 'type_tags_smart', label: '文献类型' },
  { value: 'status_tags_smart', label: '阅读状态 (/)' },
  { value: 'priority_tags_smart', label: '星标评级 (动态双轨)' },
  { value: 'extra_translation', label: '附加信息' },
];

// ── 辅助函数 ──

function creatorFullName(c: any): string {
  if (c.name) return c.name;
  if (c.firstName && c.lastName) return `${c.firstName} ${c.lastName}`;
  if (c.lastName) return c.lastName;
  return c.firstName || '';
}

// ── 智能清洗函数 ──

function extractTitleSmart(item: any): string {
  const rawTitle = (item.title || '').replace(/"/g, '\\"');
  const url = item.url || item.DOI
    ? (item.url ? item.url : `https://doi.org/${item.DOI}`)
    : '';

  if (url) {
    return `[${rawTitle}](${url})`;
  }
  return rawTitle;
}

function extractAuthorsSmart(item: any): string[] {
  const creators = item.creators || [];
  if (creators.length === 0) return [];

  const firstAuthor = creatorFullName(creators[0]);

  if (creators.length === 1) {
    return [`${firstAuthor} \u2021 \u2709\uFE0E`];
  }

  const lastCreator = creators[creators.length - 1];
  const corresponding = creatorFullName(lastCreator);

  if (creators.length === 2) {
    return [`${firstAuthor} \u2021`, `${corresponding} \u2709\uFE0E`];
  }

  return [`${firstAuthor} \u2021`, `${corresponding} \u2709\uFE0E`, 'et al.'];
}

function extractYear(item: any): string {
  if (!item.date) return '';
  // date 可能是 moment 对象或字符串
  if (typeof item.date === 'string') {
    const match = item.date.match(/(\d{4})/);
    return match ? match[1] : item.date;
  }
  // moment 对象
  if (item.date.year && typeof item.date.year === 'function') {
    return item.date.year().toString();
  }
  if (item.date.format && typeof item.date.format === 'function') {
    return item.date.format('YYYY');
  }
  return '';
}

function extractCollectionsPath(item: any): string[] {
  if (!item.collections || !Array.isArray(item.collections)) return [];
  return item.collections
    .map((c: any) => c.fullPath || c.name || '')
    .filter((s: string) => s.length > 0);
}

function extractImpactFactorSmart(item: any): number | null {
  return extractImpactFactor(item.libraryCatalog);
}

function extractTypeTagsSmart(item: any): string[] {
  if (!item.tags || !Array.isArray(item.tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of item.tags) {
    const tag = (t.tag || t).toString();
    if (tag.startsWith('#') && !seen.has(tag)) {
      seen.add(tag);
      const cleaned = tag.replace(/^#/, '');
      if (cleaned) result.push(cleaned);
    }
  }
  return result;
}

/**
 * 提取阅读状态标签并翻译为三字中文短语。
 * 使用 ZoteroDataProcessor 的统一状态翻译逻辑。
 * 返回列表类型，如 ["待阅读"]、["阅读中"]、["已完成"]。
 */
function extractStatusTagsSmart(item: any): string[] {
  const status = extractStatusFromTags(item.tags);
  return status ? [status] : [];
}

/**
 * 提取星标优先级 - 动态双轨语义评价系统 (v5.1.0 双符号体系)。
 *
 * 废弃旧的 Emoji 标签提取逻辑，改用 ZoteroDataProcessor
 * 的状态感知双轨算法，输出格式：
 *   [5位Unicode符号串] ([语义评语])
 *
 * 目标系 (待阅读/阅读中)：菱形符号 ◆◇，上限3，固定5字符
 * 评估系 (已完成)：星星符号 ★☆，1-5，固定5字符
 *
 * 示例：
 *   Zotero评2分，状态unread  → ◆◆◇◇◇ (值得关注)
 *   Zotero评5分，状态reading → ◆◆◆◇◇ (重点精读)
 *   Zotero评4分，状态done    → ★★★★☆ (高度相关)
 *   Zotero评5分，状态done    → ★★★★★ (关键研究)
 */
function extractPriorityTagsSmart(item: any): string[] {
  const rating = processItemRating(item);
  return rating ? [rating] : [];
}

function extractJournalFull(item: any): string {
  return item.publicationTitle || item.repository || item.institution || '';
}

function extractJournalAbbr(item: any): string {
  return item.journalAbbreviation || '';
}

function extractJournalSmart(item: any): string {
  // 优先使用简称，否则使用全称，兼容预印本
  const abbr = item.journalAbbreviation;
  const full = item.publicationTitle;

  if (abbr) return abbr;
  if (full) return full;

  // 预印本平台
  return item.repository || item.institution || '';
}

function extractExtraTranslation(item: any): string | null {
  const extra = item.extra || '';
  const match = extra.match(/titleTranslation:\s*(.*)/);
  return match ? match[1].trim() : null;
}

// ── 分发入口 ──

const extractorMap: Record<string, (item: any) => any> = {
  title_smart: extractTitleSmart,
  authors_smart: extractAuthorsSmart,
  journal_full: extractJournalFull,
  journal_abbr: extractJournalAbbr,
  journal_smart: extractJournalSmart,
  year: extractYear,
  collections_path: extractCollectionsPath,
  impact_factor_smart: extractImpactFactorSmart,
  type_tags_smart: extractTypeTagsSmart,
  status_tags_smart: extractStatusTagsSmart,
  priority_tags_smart: extractPriorityTagsSmart,
  extra_translation: extractExtraTranslation,
};

export function extractSmartField(zoteroField: string, item: any): any {
  const fn = extractorMap[zoteroField];
  if (fn) return fn(item);
  return null;
}
