# Design: 作者属性列表化格式优化

**日期：** 2026-05-14
**范围：** `src/bbt/smartExtractors.ts` - `extractAuthorsSmart` 函数

## 目标

将 `extractAuthorsSmart` 从返回单一字符串改为返回 `string[]`，三个字段独立存储在作者属性中。

## 设计

### 输出格式

| 作者数 | 返回数组 |
|--------|---------|
| 0 | `[]` |
| 1 | `["Author ‡", "Author ✉︎"]` — 同一作者分别作为第一作者和通讯作者 |
| 2 | `["Author1 ‡", "Author2 ✉︎"]` |
| 3+ | `["Author1 ‡", "AuthorN ✉︎", "et al."]` |

### 符号

- 第一作者标记：`\u2021` (‡ 双匕首 / double dagger)
- 通讯作者标记：`✉︎` (`\u2709\uFE0E` envelope，保持不变)

### 数据流

1. `extractAuthorsSmart` → 返回 `string[]`
2. `extractSmartField` → 透传
3. `buildPropertyRecord` → `authors_smart` 不在 SINGLE_VALUE_FIELDS 中，数组原样保留
4. `recordToYaml` → 序列化为 `作者: [item1, item2, item3]`

### 不变部分

- `templateEngine.ts` — 无需改动，已支持数组
- `types.ts` — 无需改动
- `main.ts` — 无需改动（默认映射 `authors_smart → 作者` 不变）
