import { IfColorRule } from '../types';

/**
 * 从 libraryCatalog 字段中提取影响因子数值。
 * 支持格式："IF: 12.3"、"IF 1.9"、"IF:5"、纯数字 "12.3" 等。
 */
export function extractImpactFactor(libraryCatalog?: string): number | null {
  if (!libraryCatalog) return null;

  const match = libraryCatalog.match(/IF[:\s]*(\d+\.?\d*)/i);
  if (match) {
    return parseFloat(match[1]);
  }

  // 尝试直接解析纯数字
  const numeric = parseFloat(libraryCatalog.trim());
  if (!isNaN(numeric)) {
    return numeric;
  }

  return null;
}

/**
 * 将 IF 数值与用户配置的规则数组进行匹配。
 * 遍历规则，返回首条 min <= ifValue <= max 的规则。
 * max 为 null 表示正无穷。
 */
export function matchIfRule(
  ifValue: number | null,
  rules: IfColorRule[]
): IfColorRule | null {
  if (ifValue === null || !rules.length) return null;

  for (const rule of rules) {
    if (ifValue >= rule.min && (rule.max === null || ifValue <= rule.max)) {
      return rule;
    }
  }

  return null;
}

/**
 * 创建一条默认 IF 颜色规则。
 * className 基于索引自动生成。
 */
export function createIfRule(index: number): IfColorRule {
  return {
    id: `if-rule-${Date.now()}`,
    min: 0,
    max: null,
    bgColor: '#4CAF50',
    textColor: '#FFFFFF',
    borderColor: '#388E3C',
    className: `if-dynamic-${index}`,
  };
}

/**
 * 动态生成并注入 CSS 到 document.head。
 * 为每条规则生成精确命中 Obsidian Properties 面板的选择器。
 */
export function injectIfStyles(rules: IfColorRule[]): void {
  const styleId = 'zotero-if-dynamic-styles';
  let styleEl = document.head.querySelector<HTMLStyleElement>(`#${styleId}`);

  if (!rules.length) {
    if (styleEl) styleEl.remove();
    return;
  }

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }

  const css = rules
    .map(
      (rule) =>
        `.${rule.className} .metadata-property[data-property-key="影响因子"] .multi-select-pill { background-color: ${rule.bgColor} !important; color: ${rule.textColor} !important; border: 1px solid ${rule.borderColor} !important; padding-left: 8px !important; padding-right: 8px !important; }`
    )
    .join('\n');

  styleEl.textContent = css;
}

/**
 * 移除动态注入的 IF 样式标签。
 * 在插件卸载时调用。
 */
export function removeIfStyles(): void {
  const styleEl = document.head.querySelector<HTMLStyleElement>(
    '#zotero-if-dynamic-styles'
  );
  if (styleEl) styleEl.remove();
}
