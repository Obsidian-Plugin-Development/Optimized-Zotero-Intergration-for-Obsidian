import { extractImpactFactor } from './styleManager';
import { SmartFieldOption } from '../types';

// ── 字段选项定义 ──

export const SMART_FIELD_OPTIONS: SmartFieldOption[] = [
  { value: 'title_smart', label: '标题 (包含超链接)' },
  { value: 'authors_smart', label: '作者 (智能处理 et al. 与通讯)' },
  { value: 'year', label: '日期 (提取年份)' },
  { value: 'collections_path', label: '文库和分类 (多级路径)' },
  { value: 'impact_factor_smart', label: '文库编目 (提取 IF 值)' },
  { value: 'type_tags_smart', label: '标签：文献类型 (#)' },
  { value: 'status_tags_smart', label: '标签：阅读状态 (/)' },
  { value: 'priority_tags_smart', label: '标签：星标优先级 (⭐)' },
  { value: 'extra_translation', label: '其他 (提取附加翻译)' },
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

function extractAuthorsSmart(item: any): string {
  const creators = item.creators || [];
  if (creators.length === 0) return '';

  const firstAuthor = creatorFullName(creators[0]);

  if (creators.length === 1) {
    return firstAuthor;
  }

  const lastCreator = creators[creators.length - 1];
  const corresponding = creatorFullName(lastCreator);

  if (creators.length === 2) {
    return `${firstAuthor}, ${corresponding} ✉︎`;
  }

  return `${firstAuthor}, et al., ${corresponding} ✉︎`;
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

function extractStatusTagsSmart(item: any): string[] {
  if (!item.tags || !Array.isArray(item.tags)) return [];
  const statusMarkers = ['/unread', '/reading', '/done'];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of item.tags) {
    const tag = (t.tag || t).toString();
    const matched = statusMarkers.find((m) => tag.includes(m));
    if (matched && !seen.has(tag)) {
      seen.add(tag);
      const cleaned = tag.replace(/\//g, '');
      if (cleaned) result.push(cleaned);
    }
  }
  return result;
}

function extractPriorityTagsSmart(item: any): string[] {
  if (!item.tags || !Array.isArray(item.tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of item.tags) {
    const tag = (t.tag || t).toString();
    if (/[⭐★🌟✨]/.test(tag) && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
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
