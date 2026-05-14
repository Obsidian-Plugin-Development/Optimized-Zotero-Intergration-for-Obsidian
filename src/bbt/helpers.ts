import path from 'path';
import { CustomProperty, Database, PropertyItem, PropertyMapping } from '../types';

export const defaultHeaders = {
  'Content-Type': 'application/json',
  'User-Agent': 'obsidian/zotero',
  Accept: 'application/json',
  Connection: 'keep-alive',
};

export function getPort(database: Database, port?: string) {
  if (database === 'Zotero') return '23119';
  if (database === 'Juris-M') return '24119';
  if (!port) return '23119';
  return port;
}

/**
 * 递归目录生成器 (v3.0 Smart Directory Routing)
 *
 * Obsidian 的 app.vault.createFolder() 不支持一次性创建多级不存在的目录。
 * 本函数将目标路径按 / 拆分，逐级检查并创建，确保多级目录树安全构建。
 *
 * @param vault - Obsidian Vault 实例 (app.vault)
 * @param fullPath - 完整的 Obsidian 路径，如 "Base/A/B/C"
 */
export async function ensureFolderExists(
  vault: { adapter: { exists: (p: string) => Promise<boolean> }; createFolder: (p: string) => Promise<void> },
  fullPath: string
): Promise<void> {
  if (!fullPath || fullPath === '/' || fullPath === '.') return;

  const segments = fullPath.split('/').filter(Boolean);
  let accumulated = '';

  for (const segment of segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    if (!(await vault.adapter.exists(accumulated))) {
      await vault.createFolder(accumulated);
    }
  }
}

/**
 * @deprecated 使用 ensureFolderExists 替代。
 * 保留此函数以兼容旧有调用，内部委托给 ensureFolderExists。
 */
export async function mkMDDir(mdPath: string) {
  const dir = path.dirname(mdPath);
  await ensureFolderExists(app.vault, dir);
}

/**
 * 多路径冲突解决算法 (v3.0 Smart Directory Routing)
 *
 * 一篇 Zotero 文献可能同时属于多个分类（collections_path 数组长度 > 1），
 * 但物理文件只能在一个目录中。采用"最长路径优先 (Most Specific/Deepest)"策略：
 *
 * - 无分类 → 返回默认后备文件夹 "Uncategorized"
 * - 单分类 → 直接返回该路径
 * - 多分类 → 选路径字符串最长的（分类最具体、最深层）
 *
 * @param collectionPaths - Zotero 分类路径数组，如 ["A/B", "A/B/C", "D"]
 * @returns 选定的主路径
 */
export function getPrimaryPath(collectionPaths: string[]): string {
  if (!collectionPaths || collectionPaths.length === 0) {
    return 'Uncategorized';
  }

  if (collectionPaths.length === 1) {
    return collectionPaths[0];
  }

  // 最长路径优先：选最深层、最具体的分类
  return collectionPaths.reduce((longest, current) =>
    current.length > longest.length ? current : longest
  );
}

export function replaceIllegalChars(str: string) {
  return str
    .replace(/\s*[*?]+\s*/g, ' ')
    .trim()
    .replace(/\s*[:"<>|]+\s*/g, ' - ')
    .trim();
}

export function sanitizeFilePath(filePath: string) {
  const parsed = path.posix.parse(filePath);
  const dir = replaceIllegalChars(parsed.dir);
  const name = replaceIllegalChars(parsed.name);

  return path.posix.join(dir, `${name}${parsed.ext}`);
}

function hexToHSL(str: string) {
  let rStr = '0',
    gStr = '0',
    bStr = '0';

  if (str.length == 4) {
    rStr = '0x' + str[1] + str[1];
    gStr = '0x' + str[2] + str[2];
    bStr = '0x' + str[3] + str[3];
  } else if (str.length == 7) {
    rStr = '0x' + str[1] + str[2];
    gStr = '0x' + str[3] + str[4];
    bStr = '0x' + str[5] + str[6];
  }

  const r = +rStr / 255;
  const g = +gStr / 255;
  const b = +bStr / 255;

  const cmin = Math.min(r, g, b),
    cmax = Math.max(r, g, b),
    delta = cmax - cmin;

  let h = 0,
    s = 0,
    l = 0;

  if (delta == 0) h = 0;
  else if (cmax == r) h = ((g - b) / delta) % 6;
  else if (cmax == g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;

  h = Math.round(h * 60);

  if (h < 0) h += 360;

  l = (cmax + cmin) / 2;
  s = delta == 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  s = +(s * 100).toFixed(1);
  l = +(l * 100).toFixed(1);

  return { h, s, l };
}

export function getColorCategory(hex: string) {
  const { h, s, l } = hexToHSL(hex);

  // define color category based on HSL
  if (l < 12) {
    return 'Black';
  }
  if (l > 98) {
    return 'White';
  }
  if (s < 2) {
    return 'Gray';
  }
  if (h < 15) {
    return 'Red';
  }
  if (h < 45) {
    return 'Orange';
  }
  if (h < 65) {
    return 'Yellow';
  }
  if (h < 170) {
    return 'Green';
  }
  if (h < 190) {
    return 'Cyan';
  }
  if (h < 255) {
    return 'Blue';
  }
  if (h < 280) {
    return 'Purple';
  }
  if (h < 335) {
    return 'Magenta';
  }
  return 'Red';
}

/**
 * Open a PDF at a given page (or try to)
 *
 * zotero://open-pdf/library/items/[itemKey]?page=[page]
 * zotero://open-pdf/groups/[groupID]/items/[itemKey]?page=[page]
 *
 * Also supports ZotFile format:
 * zotero://open-pdf/[libraryID]_[key]/[page]
 */

/**
 * Select an item
 *
 * zotero://select/library/items/[itemKey]
 * zotero://select/groups/[groupID]/items/[itemKey]
 *
 * Deprecated:
 *
 * zotero://select/[type]/0_ABCD1234
 * zotero://select/[type]/1234 (not consistent across synced machines)
 */
export function getLocalURI(
  ext: 'select' | 'open-pdf',
  uri: string,
  params?: Record<string, string>
) {
  const itemId = uri.split('/').pop();
  const prefix = `zotero://${ext}`;
  let url = '';

  if (/group/.test(uri)) {
    url = uri.replace('http://zotero.org', prefix);
  } else {
    url = `${prefix}/library/items/${itemId}`;
  }

  if (params) {
    const p = new URLSearchParams(params);
    url += `?${p}`;
  }

  return url;
}

/**
 * 从统一属性列表中提取 Zotero 字段映射（供下游代码使用）。
 */
export function getZoteroMappings(items: PropertyItem[]): PropertyMapping[] {
  return items
    .filter(item => item.kind === 'zotero' && item.zoteroField)
    .map(item => ({ zoteroField: item.zoteroField!, obsidianKey: item.obsidianKey }));
}

/**
 * 从统一属性列表中提取用户自定义属性（供下游代码使用）。
 */
export function getCustomProperties(items: PropertyItem[]): CustomProperty[] {
  return items
    .filter(item => item.kind === 'custom')
    .map(item => ({ key: item.obsidianKey, type: item.customType || 'text', value: item.customValue }));
}
