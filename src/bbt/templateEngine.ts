import { extractSmartField } from './smartExtractors';
import { IfColorRule, PropertyItem } from '../types';
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

// ── 自定义属性值解析 ──

/**
 * 将用户输入的原始字符串按目标类型解析为 JS 值，
 * 确保 recordToYaml 输出正确的 YAML 类型标记。
 */
function parseCustomValue(raw: string, type: string): any {
  switch (type) {
    case 'number': {
      const n = parseFloat(raw);
      return isNaN(n) ? raw : n;
    }
    case 'checkbox':
      return raw === 'true' || raw === '1' || raw === 'yes';
    case 'list':
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    default:
      return raw;
  }
}

// ── Record 构建 ──

export function buildPropertyRecord(
  item: any,
  propertyItems: PropertyItem[],
  ifColorRules?: IfColorRule[]
): Record<string, any> {
  const record: Record<string, any> = {};
  const cssclasses: string[] = [];

  for (const pi of propertyItems) {
    if (!pi.obsidianKey) continue;

    // ── 自定义属性：注入默认值 ──
    if (pi.kind === 'custom') {
      if (pi.customValue !== undefined && pi.customValue !== '') {
        record[pi.obsidianKey] = parseCustomValue(pi.customValue, pi.customType || 'text');
      } else {
        switch (pi.customType || 'text') {
          case 'text':   record[pi.obsidianKey] = ''; break;
          case 'list':   record[pi.obsidianKey] = []; break;
          case 'number': record[pi.obsidianKey] = 0; break;
          case 'checkbox': record[pi.obsidianKey] = false; break;
          case 'date':   record[pi.obsidianKey] = ''; break;
          default:       record[pi.obsidianKey] = ''; break;
        }
      }
      continue;
    }

    // ── Zotero 字段映射 ──
    if (!pi.zoteroField) continue;

    let value = extractSmartField(pi.zoteroField, item);

    // 跳过无效值
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;

    // IF 纯数字存储，颜色规则匹配；小数尾缀 .0 由 styleManager 在视图层注入
    if (pi.zoteroField === 'impact_factor_smart' && typeof value === 'number') {
      record[pi.obsidianKey] = value;
      const matchedRule = matchIfRule(value, ifColorRules || []);
      if (matchedRule) {
        cssclasses.push(matchedRule.className);
      }
      continue;
    }

    // 强类型转换：单值字段 vs 列表字段
    if (SINGLE_VALUE_FIELDS.has(pi.zoteroField)) {
      value = Array.isArray(value) ? value[0] : value;
    } else {
      value = Array.isArray(value) ? value : [value];
    }

    record[pi.obsidianKey] = value;
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

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      const items = value.map((v: any) => {
        if (typeof v === 'number') return v.toString();
        return yamlEscape(String(v));
      });
      lines.push(`${key}: [${items.join(', ')}]`);
    } else if (typeof value === 'number') {
      const formatted = Number.isInteger(value) ? value.toFixed(1) : value.toString();
      lines.push(`${key}: ${formatted}`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else {
      const strValue = String(value);
      if (strValue === '') {
        lines.push(`${key}: ''`);
      } else {
        lines.push(`${key}: ${yamlEscape(strValue)}`);
      }
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
