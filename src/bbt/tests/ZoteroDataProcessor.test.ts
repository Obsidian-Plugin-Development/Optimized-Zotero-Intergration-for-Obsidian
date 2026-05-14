import {
  assembleRating,
  extractRawRating,
  extractStatusFromTags,
  processItemRating,
  translateStatus,
  STAR_FILLED,
  STAR_HOLLOW,
  DIAMOND_FILLED,
  DIAMOND_HOLLOW,
  PRE_READ_DICT,
  POST_READ_DICT,
  DEFAULT_STATUS,
} from '../ZoteroDataProcessor';

// ═══════════════════════════════════════════════
// 步骤 1：Unicode 几何符号定义测试 (v5.1.0)
// ═══════════════════════════════════════════════

describe('Unicode 几何符号定义', () => {
  it('STAR_FILLED 应为 Unicode \u2605', () => {
    expect(STAR_FILLED).toBe('\u2605');
    expect(STAR_FILLED).toHaveLength(1);
  });

  it('STAR_HOLLOW 应为 Unicode \u2606', () => {
    expect(STAR_HOLLOW).toBe('\u2606');
    expect(STAR_HOLLOW).toHaveLength(1);
  });

  it('DIAMOND_FILLED 应为 Unicode \u25C6', () => {
    expect(DIAMOND_FILLED).toBe('\u25C6');
    expect(DIAMOND_FILLED).toHaveLength(1);
  });

  it('DIAMOND_HOLLOW 应为 Unicode \u25C7', () => {
    expect(DIAMOND_HOLLOW).toBe('\u25C7');
    expect(DIAMOND_HOLLOW).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════
// 步骤 2：阅读状态中文化测试
// ═══════════════════════════════════════════════

describe('translateStatus - 阅读状态中文化', () => {
  it('unread → 待阅读', () => {
    expect(translateStatus('unread')).toBe('待阅读');
  });

  it('reading → 阅读中', () => {
    expect(translateStatus('reading')).toBe('阅读中');
  });

  it('done → 已完成', () => {
    expect(translateStatus('done')).toBe('已完成');
  });

  it('大小写不敏感', () => {
    expect(translateStatus('UNREAD')).toBe('待阅读');
    expect(translateStatus('Reading')).toBe('阅读中');
    expect(translateStatus('DONE')).toBe('已完成');
  });

  it('前后空格容错', () => {
    expect(translateStatus('  reading  ')).toBe('阅读中');
  });

  it('空值默认返回 待阅读', () => {
    expect(translateStatus(null as any)).toBe('待阅读');
    expect(translateStatus(undefined)).toBe('待阅读');
    expect(translateStatus('')).toBe('待阅读');
  });

  it('异常状态默认返回 待阅读', () => {
    expect(translateStatus('unknown_status')).toBe('待阅读');
  });

  it('带斜杠前缀的标签兼容', () => {
    // 如果 rawStatus 是 "/reading"，include 匹配应找到 "reading"
    expect(translateStatus('/reading')).toBe('阅读中');
    expect(translateStatus('/unread')).toBe('待阅读');
    expect(translateStatus('/done')).toBe('已完成');
  });
});

// ═══════════════════════════════════════════════
// 步骤 3：动态双轨映射字典测试
// ═══════════════════════════════════════════════

describe('动态双轨映射字典', () => {
  it('预读字典应有 1-3 星的映射', () => {
    expect(PRE_READ_DICT[1]).toBe('简单泛读');
    expect(PRE_READ_DICT[2]).toBe('值得关注');
    expect(PRE_READ_DICT[3]).toBe('重点精读');
  });

  it('已读字典应有 1-5 星的映射', () => {
    expect(POST_READ_DICT[1]).toBe('知识储备');
    expect(POST_READ_DICT[2]).toBe('可供参考');
    expect(POST_READ_DICT[3]).toBe('值得借鉴');
    expect(POST_READ_DICT[4]).toBe('高度相关');
    expect(POST_READ_DICT[5]).toBe('关键研究');
  });
});

// ═══════════════════════════════════════════════
// 步骤 4：核心算法测试
// ═══════════════════════════════════════════════

describe('assembleRating - 状态感知与双符号组装算法 (v5.1.0)', () => {
  // ── 目标系 (待阅读/阅读中)：菱形符号，上限3 ──

  it('Zotero评2分，状态unread → ◆◆◇◇◇ (值得关注)', () => {
    const result = assembleRating(2, '待阅读');
    expect(result.rating).toBe(2);
    expect(result.symbolString).toBe('\u25C6\u25C6\u25C7\u25C7\u25C7');
    expect(result.comment).toBe('值得关注');
    expect(result.formatted).toBe('◆◆◇◇◇ (值得关注)');
  });

  it('Zotero评5分，状态reading → ◆◆◆◇◇ (重点精读) (触发大于3分强制拦截)', () => {
    const result = assembleRating(5, '阅读中');
    expect(result.rating).toBe(3); // 强制修正为 3
    expect(result.symbolString).toBe('\u25C6\u25C6\u25C6\u25C7\u25C7');
    expect(result.comment).toBe('重点精读');
    expect(result.formatted).toBe('◆◆◆◇◇ (重点精读)');
  });

  it('评1分，状态待阅读 → ◆◇◇◇◇ (简单泛读)', () => {
    const result = assembleRating(1, '待阅读');
    expect(result.rating).toBe(1);
    expect(result.formatted).toBe('◆◇◇◇◇ (简单泛读)');
  });

  it('评3分，状态阅读中 → ◆◆◆◇◇ (重点精读)', () => {
    const result = assembleRating(3, '阅读中');
    expect(result.rating).toBe(3);
    expect(result.formatted).toBe('◆◆◆◇◇ (重点精读)');
  });

  it('评4分，状态待阅读 → ◆◆◆◇◇ (重点精读) (触发拦截)', () => {
    const result = assembleRating(4, '待阅读');
    expect(result.rating).toBe(3);
    expect(result.formatted).toBe('◆◆◆◇◇ (重点精读)');
  });

  // ── 评估系 (已完成)：星星符号，1-5 ──

  it('Zotero评4分，状态done → ★★★★☆ (高度相关)', () => {
    const result = assembleRating(4, '已完成');
    expect(result.rating).toBe(4);
    expect(result.symbolString).toBe('\u2605\u2605\u2605\u2605\u2606');
    expect(result.comment).toBe('高度相关');
    expect(result.formatted).toBe('★★★★☆ (高度相关)');
  });

  it('Zotero评5分，状态done → ★★★★★ (关键研究)', () => {
    const result = assembleRating(5, '已完成');
    expect(result.rating).toBe(5);
    expect(result.symbolString).toBe('\u2605\u2605\u2605\u2605\u2605');
    expect(result.comment).toBe('关键研究');
    expect(result.formatted).toBe('★★★★★ (关键研究)');
  });

  it('评1分，状态已完成 → ★☆☆☆☆ (知识储备)', () => {
    const result = assembleRating(1, '已完成');
    expect(result.rating).toBe(1);
    expect(result.formatted).toBe('★☆☆☆☆ (知识储备)');
  });

  it('评2分，状态已完成 → ★★☆☆☆ (可供参考)', () => {
    const result = assembleRating(2, '已完成');
    expect(result.formatted).toBe('★★☆☆☆ (可供参考)');
  });

  it('评3分，状态已完成 → ★★★☆☆ (值得借鉴)', () => {
    const result = assembleRating(3, '已完成');
    expect(result.formatted).toBe('★★★☆☆ (值得借鉴)');
  });

  // ── 边界与异常测试 ──

  it('异常状态走评估系兜底（星星）', () => {
    const result = assembleRating(3, '某个未知状态');
    expect(result.comment).toBe('值得借鉴'); // 已读字典 3 分
    expect(result.rating).toBe(3);
  });

  it('rawRating 为 0 时修正为 1', () => {
    const result = assembleRating(0, '已完成');
    expect(result.rating).toBe(1);
    expect(result.formatted).toBe('★☆☆☆☆ (知识储备)');
  });

  it('rawRating 为负数时修正为 1', () => {
    const result = assembleRating(-1, '待阅读');
    expect(result.rating).toBe(1);
  });
});

// ═══════════════════════════════════════════════
// extractRawRating - 原始评星数提取测试
// ═══════════════════════════════════════════════

describe('extractRawRating - 从标签提取原始评星数', () => {
  it('提取 ⭐ 标签数量', () => {
    const tags = [{ tag: '⭐' }];
    expect(extractRawRating(tags)).toBe(1);
  });

  it('提取多个星标标签中的最大数', () => {
    const tags = [{ tag: '⭐⭐' }, { tag: '⭐⭐⭐⭐⭐' }];
    expect(extractRawRating(tags)).toBe(5);
  });

  it('提取 ★ 标签数量', () => {
    const tags = [{ tag: '★★★' }];
    expect(extractRawRating(tags)).toBe(3);
  });

  it('混合类型星标取最大数', () => {
    const tags = [{ tag: '⭐' }, { tag: '★★★' }, { tag: '✨✨' }];
    expect(extractRawRating(tags)).toBe(3);
  });

  it('无星标标签返回 0', () => {
    const tags = [{ tag: '#important' }, { tag: '/unread' }];
    expect(extractRawRating(tags)).toBe(0);
  });

  it('空标签返回 0', () => {
    expect(extractRawRating([])).toBe(0);
    expect(extractRawRating(null as any)).toBe(0);
    expect(extractRawRating(undefined as any)).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// extractStatusFromTags - 阅读状态提取测试
// ═══════════════════════════════════════════════

describe('extractStatusFromTags - 从标签提取阅读状态', () => {
  it('提取 /unread 状态', () => {
    const tags = [{ tag: '/unread' }];
    expect(extractStatusFromTags(tags)).toBe('待阅读');
  });

  it('提取 /reading 状态', () => {
    const tags = [{ tag: '/reading' }];
    expect(extractStatusFromTags(tags)).toBe('阅读中');
  });

  it('提取 /done 状态', () => {
    const tags = [{ tag: '/done' }];
    expect(extractStatusFromTags(tags)).toBe('已完成');
  });

  it('无状态标签返回默认状态', () => {
    const tags = [{ tag: '#important' }];
    expect(extractStatusFromTags(tags)).toBe('待阅读');
  });

  it('空标签返回默认状态', () => {
    expect(extractStatusFromTags([])).toBe('待阅读');
    expect(extractStatusFromTags(null as any)).toBe('待阅读');
    expect(extractStatusFromTags(undefined as any)).toBe('待阅读');
  });
});

// ═══════════════════════════════════════════════
// processItemRating - 一站式集成测试
// ═══════════════════════════════════════════════

describe('processItemRating - 一站式文献评级处理', () => {
  it('评2分+状态unread → 预读轨', () => {
    const item = {
      tags: [{ tag: '⭐⭐' }, { tag: '/unread' }],
    };
    expect(processItemRating(item)).toBe('◆◆◇◇◇ (值得关注)');
  });

  it('评5分+状态reading → 预读轨拦截', () => {
    const item = {
      tags: [{ tag: '⭐⭐⭐⭐⭐' }, { tag: '/reading' }],
    };
    expect(processItemRating(item)).toBe('◆◆◆◇◇ (重点精读)');
  });

  it('评4分+状态done → 已读轨', () => {
    const item = {
      tags: [{ tag: '★★★★' }, { tag: '/done' }],
    };
    expect(processItemRating(item)).toBe('★★★★☆ (高度相关)');
  });

  it('评5分+状态done → 已读轨满星', () => {
    const item = {
      tags: [{ tag: '⭐⭐⭐⭐⭐' }, { tag: '/done' }],
    };
    expect(processItemRating(item)).toBe('★★★★★ (关键研究)');
  });

  it('无星标标签返回空字符串', () => {
    const item = {
      tags: [{ tag: '#important' }, { tag: '/reading' }],
    };
    expect(processItemRating(item)).toBe('');
  });

  it('有星标但无状态标签 → 默认状态为待阅读走预读轨', () => {
    const item = {
      tags: [{ tag: '★★★' }],
    };
    expect(processItemRating(item)).toBe('◆◆◆◇◇ (重点精读)');
  });

  it('无tags数组返回空字符串', () => {
    expect(processItemRating({})).toBe('');
  });

  it('使用 ★ 星标的场景', () => {
    const item = {
      tags: [{ tag: '★★★★' }, { tag: '/done' }],
    };
    expect(processItemRating(item)).toBe('★★★★☆ (高度相关)');
  });
});
