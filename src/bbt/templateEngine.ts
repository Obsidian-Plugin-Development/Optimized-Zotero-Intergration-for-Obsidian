import { extractSmartField } from './smartExtractors';
import { IfColorRule, PropertyMapping } from '../types';
import { matchIfRule } from './styleManager';

// ── YAML 强类型规范 ──

/**
 * 单值字段：输出为 `key: value`
 * 其他字段：强制输出为 `key: [item1, item2]`
 */
const SINGLE_VALUE_FIELDS = new Set([
  'title_smart',
  'journal_full',
  'journal_abbr',
  'journal_smart',
  'impact_factor_smart',
  'year',
  'extra_translation'
]);

// ── Record 构建 ──

export function buildPropertyRecord(
  item: any,
  propertyMappings: PropertyMapping[],
  ifColorRules?: IfColorRule[]
): Record<string, any> {
  const record: Record<string, any> = {};
  const cssclasses: string[] = [];

  for (const mapping of propertyMappings) {
    if (!mapping.zoteroField || !mapping.obsidianKey) continue;

    let value = extractSmartField(mapping.zoteroField, item);

    // 跳过无效值
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;

    // IF 纯数字存储，颜色规则匹配；小数尾缀 .0 由 styleManager 在视图层注入
    if (mapping.zoteroField === 'impact_factor_smart' && typeof value === 'number') {
      record[mapping.obsidianKey] = value;
      const matchedRule = matchIfRule(value, ifColorRules || []);
      if (matchedRule) {
        cssclasses.push(matchedRule.className);
      }
      continue;
    }

    // 强类型转换：单值字段 vs 列表字段
    if (SINGLE_VALUE_FIELDS.has(mapping.zoteroField)) {
      // 单值字段：如果是数组，取第一个元素
      value = Array.isArray(value) ? value[0] : value;
    } else {
      // 列表字段：如果不是数组，包装成数组
      value = Array.isArray(value) ? value : [value];
    }

    record[mapping.obsidianKey] = value;
  }

  if (cssclasses.length > 0) {
    record.cssclasses = cssclasses;
  }

  return record;
}

// ── YAML 序列化 ──

function yamlEscape(value: string): string {
  if (!value) return value;
  // 含双引号或特殊字符（含零宽空格 \u200B）→ 单引号包裹
  if (value.includes('"') || value.includes(':') || value.includes('#') ||
      value.includes('{') || value.includes('}') || value.includes('[') ||
      value.includes(']') || value.includes('|') || value.includes('>') ||
      value.includes('&') || value.includes('*') || value.includes('!') ||
      value.startsWith(' ') || value.endsWith(' ') || value.includes('@')) {
    // 单引号内需要转义单引号为两个单引号
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
  }
  // 纯数字字符串需要引号
  if (/^\d+\.?\d*$/.test(value.trim())) {
    return `'${value}'`;
  }
  return value;
}

export function recordToYaml(record: Record<string, any>): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    if (Array.isArray(value)) {
      const items = value.map((v: any) => {
        if (typeof v === 'number') return v.toString();
        return yamlEscape(String(v));
      });
      lines.push(`${key}: [${items.join(', ')}]`);
    } else if (typeof value === 'number') {
      const formatted = Number.isInteger(value) ? value.toFixed(1) : value.toString();
      lines.push(`${key}: ${formatted}`);
    } else {
      lines.push(`${key}: ${yamlEscape(String(value))}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// ── 正文模板变量替换 ──

export function renderBodyTemplate(
  template: string,
  data: Record<string, any>
): string {
  if (!template) return '';

  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = data[key];
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  });
}

// ── v4.0 边界标记 ──

export const ZOTERO_BODY_START = '%% Zotero_Notes_Start %%';
export const ZOTERO_BODY_END = '%% Zotero_Notes_End %%';

// ── 组装完整 Markdown ──

/**
 * 组装最终 Markdown 文件内容。
 * v4.0: 正文内容包裹在 Zotero 边界标记之间，
 * 确保再导入时只替换标记内区域，不覆盖用户手写笔记。
 */
export function assembleMarkdown(
  record: Record<string, any>,
  bodyTemplate: string
): string {
  const yaml = recordToYaml(record);
  const body = renderBodyTemplate(bodyTemplate, record);
  const wrappedBody = body
    ? `\n${ZOTERO_BODY_START}\n${body}\n${ZOTERO_BODY_END}\n`
    : '';
  return yaml + wrappedBody;
}
