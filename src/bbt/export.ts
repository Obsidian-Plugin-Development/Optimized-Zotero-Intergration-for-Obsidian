import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { Notice, TFile, htmlToMarkdown, moment, normalizePath, parseYaml } from 'obsidian';
import path from 'path';

import { t } from '../locale/i18n';
import { doesEXEExist, getVaultRoot } from '../helpers';
import {
  CustomProperty,
  DatabaseWithPort,
  ExportToMarkdownParams,
  IfColorRule,
  ImportProgress,
  ProgressCallback,
  PropertyItem,
  PropertyMapping,
  RenderCiteTemplateParams,
  ZoteroConnectorSettings,
} from '../types';
import { applyBasicTemplates } from './basicTemplates/applyBasicTemplates';
import { CiteKey, getCiteKeyFromAny, getCiteKeys } from './cayw';
import { processZoteroAnnotationNotes } from './exportNotes';
import { extractAnnotations } from './extractAnnotations';
import {
  ensureFolderExists,
  getColorCategory,
  getCustomProperties,
  getLocalURI,
  getPrimaryPath,
  getZoteroMappings,
  mkMDDir,
  sanitizeFilePath,
} from './helpers';
import { assembleMarkdown, buildPropertyRecord } from './templateEngine';
import { extractSmartField } from './smartExtractors';
import {
  getAttachmentsFromCiteKey,
  getBibFromCiteKey,
  getCollectionFromCiteKey,
  getIssueDateFromCiteKey,
  getItemJSONFromCiteKeys,
  getItemJSONFromRelations,
} from './jsonRPC';
import { extractFrontmatterBlock, mergeFrontmatterContent, removeFrontmatter } from './frontmatter';
import { extractImpactFactor, matchIfRule } from './styleManager';
import { PersistExtension, renderTemplate } from './template.env';
import {
  appendExportDate,
  getExistingAnnotations,
  getLastExport,
  getTemplates,
  removeStartingSlash,
  wrapAnnotationTemplate,
} from './template.helpers';

// ═══════════════════════════════════════════════
// v4.0 非破坏性同步 - 边界标记与安全合并
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// v5.0 自定义属性默认值 - 类型 → 空值映射
// ═══════════════════════════════════════════════

/**
 * 获取自定义属性的默认空值（YAML 格式化的字符串）。
 * 用于新笔记首次创建时注入预设属性。
 */
function getCustomPropertyDefault(cp: CustomProperty): string {
  // v5.1: 优先使用用户指定的默认值
  if (cp.value !== undefined && cp.value !== '') return cp.value;

  switch (cp.type) {
    case 'text':
      return "''";
    case 'list':
      return '[]';
    case 'number':
      return '0';
    case 'checkbox':
      return 'false';
    case 'date':
      return "''";
    default:
      return "''";
  }
}

/**
 * v5.0 安全注入：将自定义属性及其默认值追加到 YAML 块末尾。
 * 仅在新建文件时调用，更新时绝不触碰。
 */
function injectCustomPropertiesIntoYaml(
  yamlBlock: string,
  customProperties: CustomProperty[]
): string {
  if (!customProperties?.length) return yamlBlock;

  // 跳过已在 YAML 中存在的 key（v5.2: buildPropertyRecord 现在已包含自定义属性）
  const existingKeys = new Set(
    yamlBlock.split('\n')
      .map(line => line.split(':')[0]?.trim())
      .filter(Boolean)
  );
  const extraLines = customProperties
    .filter(cp => !existingKeys.has(cp.key))
    .map(cp => `${cp.key}: ${getCustomPropertyDefault(cp)}`);
  if (!extraLines.length) return yamlBlock;
  return yamlBlock + '\n' + extraLines.join('\n');
}

/**
 * v5.0 安全门：从 Zotero 映射中提取受保护的 key 集合。
 * 增量更新时，只允许修改这些 key，其他任何 YAML 字段绝对禁止触碰。
 */
function getMappedObsidianKeys(mappings?: PropertyMapping[]): Set<string> {
  if (!mappings?.length) return new Set<string>();
  return new Set(mappings.map((m) => m.obsidianKey).filter(Boolean));
}

/** Zotero 内容区域起始标记 */
const ZOTERO_START = '%% Zotero_Notes_Start %%';
/** Zotero 内容区域结束标记 */
const ZOTERO_END = '%% Zotero_Notes_End %%';

/**
 * 将生成的 Zotero 正文内容包裹在边界标记之间。
 */
function wrapZoteroSection(content: string): string {
  return `\n${ZOTERO_START}\n${content}\n${ZOTERO_END}\n`;
}

/**
 * 从现有文件内容中提取 Zotero 标记区域之外的用户内容。
 * 返回 { before, after } — 标记前和标记后的内容。
 * 如果找不到标记，返回 null。
 */
function extractUserContent(
  fileContent: string
): { before: string; after: string } | null {
  const startIdx = fileContent.indexOf(ZOTERO_START);
  const endIdx = fileContent.indexOf(ZOTERO_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  return {
    before: fileContent.slice(0, startIdx),
    after: fileContent.slice(endIdx + ZOTERO_END.length),
  };
}

/**
 * 安全替换或追加 Zotero 内容区域。
 *
 * - 如果文件中已存在标记区域，仅替换标记内的内容，外部内容原封不动。
 * - 如果文件中不存在标记区域，将新的 Zotero 内容追加到文件末尾。
 *
 * @param existingContent - 文件的当前完整内容
 * @param newZoteroBody   - 新生成的 Zotero 正文内容（不含标记）
 * @returns 合并后的完整文件内容
 */
function replaceOrAppendZoteroSection(
  existingContent: string,
  newZoteroBody: string
): string {
  const userContent = extractUserContent(existingContent);

  if (userContent) {
    // 标记存在：仅替换标记内区域，外部用户内容 100% 保留
    return (
      userContent.before +
      wrapZoteroSection(newZoteroBody) +
      userContent.after
    );
  }

  // 标记不存在：在文件末尾追加 Zotero 区域
  return existingContent.trimEnd() + wrapZoteroSection(newZoteroBody);
}

async function processNote(
  citeKey: CiteKey,
  note: any,
  importDate: moment.Moment,
  database: DatabaseWithPort,
  cslStyle?: string
) {
  if (note.note) {
    note.note = htmlToMarkdown(
      await processZoteroAnnotationNotes(citeKey.key, note.note, {})
    );
  }
  if (note.dateAdded) {
    note.dateAdded = moment(note.dateAdded);
  }
  if (note.dateModified) {
    note.dateModified = moment(note.dateModified);
  }
  note.desktopURI = getLocalURI('select', note.uri);
  note.relations = await getRelations(
    note,
    citeKey.library,
    importDate,
    database,
    cslStyle
  );
}

function processAttachment(attachment: any) {
  if (attachment.dateAdded) {
    attachment.dateAdded = moment(attachment.dateAdded);
  }

  if (attachment.dateModified) {
    attachment.dateModified = moment(attachment.dateModified);
  }

  if (attachment.uri) {
    attachment.itemKey = attachment.uri.split('/').pop();
    attachment.desktopURI =
      attachment.select || getLocalURI('select', attachment.uri);

    if (attachment.path?.endsWith('.pdf')) {
      attachment.pdfURI = getLocalURI('open-pdf', attachment.uri);
    }
  }
}

function processAnnotation(
  annotation: any,
  attachment: any,
  imageRelativePath: any
) {
  annotation.date = moment(annotation.date);
  annotation.attachment = attachment;
  annotation.source = 'pdf';

  if (annotation.imagePath) {
    annotation.imageBaseName = path.basename(annotation.imagePath);
    annotation.imageExtension = path.extname(annotation.imagePath).slice(1);
    annotation.imageRelativePath = normalizePath(
      path.join(imageRelativePath, annotation.imageBaseName)
    );
  }

  if (attachment.path?.endsWith('.pdf')) {
    annotation.desktopURI = getLocalURI('open-pdf', attachment.uri, {
      page: annotation.pageLabel,
    });
  }
}

function convertNativeAnnotation(
  annotation: any,
  attachment: any,
  imageOutputPath: string,
  imageRelativePath: string,
  imageBaseName: string,
  copy: boolean = false
) {
  const annot: Record<string, any> = {
    date: moment(annotation.dateModified),
    attachment,
    id: annotation.key,
    type: annotation.annotationType,
    color: annotation.annotationColor,
    colorCategory: getColorCategory(annotation.annotationColor),
    source: 'zotero',
  };

  if (attachment.path?.endsWith('.pdf')) {
    annot.pageLabel = annotation.annotationPageLabel;
    annot.desktopURI = getLocalURI('open-pdf', attachment.uri, {
      page: annotation.annotationPageLabel,
      annotation: annotation.key,
    });
  }

  if (annotation.annotationPosition) {
    if (annotation.annotationPosition.pageIndex) {
      annot.page = annotation.annotationPosition.pageIndex + 1
    }

    if (annotation.annotationPosition.rects) {
      annot.x = annotation.annotationPosition.rects[0][0];
      annot.y = annotation.annotationPosition.rects[0][1];
    }
  }

  if (annotation.annotationText) {
    annot.annotatedText = annotation.annotationText;
  }

  if (annotation.annotationComment) {
    annot.comment = annotation.annotationComment;
  }

  if (annotation.annotationImagePath) {
    const parsed = path.parse(annotation.annotationImagePath);

    annot.imageBaseName = `${imageBaseName}-${annot.page}-x${Math.round(
      annot.x
    )}-y${Math.round(annot.y)}${parsed.ext}`;
    annot.imageRelativePath = normalizePath(
      path.join(imageRelativePath, annot.imageBaseName)
    );
    annot.imageExtension = parsed.ext.slice(1);

    const imagePath = path.join(imageOutputPath, annot.imageBaseName);

    if (copy) {
      if (!existsSync(imageOutputPath)) {
        mkdirSync(imageOutputPath, { recursive: true });
      }

      let input = path.join(parsed.dir, `${annotation.key}${parsed.ext}`);
      try {
        if (!existsSync(input)) {
          const origInput = input;
          input = annotation.annotationImagePath;
          if (!existsSync(input)) {
            throw new Error('Cannot find annotation image: ' + origInput);
          }
        }

        copyFileSync(input, imagePath);
      } catch (e) {
        new Notice(
          t('notice.cannotCopyImage'),
          7000
        );
        console.error(e);
      }
    }

    annot.imagePath = imagePath;
  }

  if (annotation.tags?.length) {
    annot.tags = annotation.tags;
    annot.allTags = annotation.tags.map((t: any) => t.tag).join(', ');
    annot.hashTags = annotation.tags
      .map((t: any) => `#${t.tag.replace(/\s+/g, '-')}`)
      .join(', ');
  }

  return annot;
}

function concatAnnotations(annots: Array<Record<string, any>>) {
  const output: Array<Record<string, any>> = [];
  const re = /^\+\s*/;

  annots.forEach((a) => {
    if (typeof a.comment === 'string' && re.test(a.comment)) {
      a.comment = a.comment.replace(re, '');

      const last = output[output.length - 1];

      if (last) {
        last.annotatedText = last.annotatedText
          ? last.annotatedText + '...' + a.annotatedText
          : a.annotatedText;
        last.comment = last.comment
          ? last.comment + '...' + a.comment
          : a.comment;

        return;
      }
    }

    output.push(a);
  });

  return output;
}

async function getRelations(
  item: any,
  libraryID: any,
  importDate: moment.Moment,
  database: DatabaseWithPort,
  cslStyle?: string
) {
  if (item.relations && !Array.isArray(item.relations)) {
    const relations: string[] = [];
    for (const val of Object.values(item.relations)) {
      if (Array.isArray(val)) relations.push(...val);
    }
    item.relations = relations;
  }
  if (!item.relations?.length) return [];

  const relatedItems = await getItemJSONFromRelations(
    libraryID,
    item.relations,
    database
  );

  for (const related of relatedItems) {
    if (getCiteKeyFromAny(related)) {
      await processItem(related, importDate, database, cslStyle, true);
    }
  }

  return relatedItems;
}

async function processItem(
  item: any,
  importDate: moment.Moment,
  database: DatabaseWithPort,
  cslStyle?: string,
  skipRelations?: boolean
) {
  const citekey = getCiteKeyFromAny(item);
  item.importDate = importDate;
  // legacy
  item.exportDate = importDate;
  item.desktopURI =
    item.select || getLocalURI('select', item.uri, item.itemKey);

  if (item.accessDate) {
    item.accessDate = moment(item.accessDate);
  }

  if (item.dateAdded) {
    item.dateAdded = moment(item.dateAdded);
  }

  if (item.dateModified) {
    item.dateModified = moment(item.dateModified);
  }

  if (citekey) {
    if (!item.citekey) {
      item.citekey = citekey.key;
    }

    if (!item.citationKey) {
      item.citationKey = citekey.key;
    }

    try {
      item.date = await getIssueDateFromCiteKey(citekey, database);
    } catch {
      // We don't particularly care about this
    }

    try {
      item.collections = await getCollectionFromCiteKey(citekey, database);
    } catch {
      // We don't particularly care about this
    }

    try {
      item.bibliography = await getBibFromCiteKey(citekey, database, cslStyle);
    } catch {
      item.bibliography = 'Error generating bibliography';
    }
  }

  if (item.notes) {
    for (const note of item.notes) {
      await processNote(citekey, note, importDate, database, cslStyle);
    }
  }

  if (item.attachments) {
    for (const attachment of item.attachments) {
      processAttachment(attachment);
    }
  }

  if (!skipRelations) {
    item.relations = await getRelations(
      item,
      item.libraryID,
      importDate,
      database,
      cslStyle
    );
  }
}

function generateHelpfulTemplateError(e: Error, template: string) {
  const message = e.message;

  try {
    if (message) {
      const match = message.match(/\[Line (\d+), Column (\d+)]/);

      if (match) {
        const lines = template.split(/\n/g);
        const line = lines[Number(match[1]) - 1];
        const indicator = ' '.repeat(Number(match[2]) - 1) + '^';

        return `${message}\n\n${line}\n${indicator}`;
      }
    }
  } catch {
    //
  }

  return message;
}

function errorToHelpfulNotification(
  e: Error,
  templatePath: string,
  template: string
) {
  new Notice(
    createFragment((f) => {
      f.createSpan({
        text: `${t('error.parsingTemplate', templatePath)} `,
      });
      f.createEl('code', {
        text: generateHelpfulTemplateError(e, template),
      });
    }),
    10000
  );
}

function errorToHelpfulError(e: Error, templatePath: string, template: string) {
  return new Error(
    `Error parsing template "${templatePath}": ${generateHelpfulTemplateError(
      e,
      template
    )}`
  );
}

export async function renderTemplates(
  params: ExportToMarkdownParams,
  templateData: Record<any, any>,
  existingAnnotations: string,
  settings: ZoteroConnectorSettings,
  shouldThrow?: boolean
) {
  const { template, headerTemplate, annotationTemplate, footerTemplate } =
    await getTemplates(params);

  // v2.0 新引擎：无 Nunjucks 模板但配置了属性映射时，使用可视化映射生成 YAML
  if (!template && !headerTemplate && !annotationTemplate && !footerTemplate) {
    if (settings.propertyItems?.length) {
      const record = templateData._propertyRecord || {};
      const rendered = assembleMarkdown(record, settings.bodyTemplate || '');
      return rendered;
    }
    throw new Error(
      `No templates found for export ${params.exportFormat.name}`
    );
  }

  let main = '';
  let hasPersist = false;

  if (template) {
    try {
      main = await renderTemplate(
        params.exportFormat.templatePath,
        template,
        templateData
      );
      hasPersist = PersistExtension.hasPersist(main);
    } catch (e) {
      if (shouldThrow) {
        throw errorToHelpfulError(
          e,
          params.exportFormat.templatePath,
          template
        );
      } else {
        errorToHelpfulNotification(
          e,
          params.exportFormat.templatePath,
          template
        );
        return false;
      }
    }

    return hasPersist ? appendExportDate(main) : main;
  }

  // Legacy templates
  let header = '';
  let annotations = '';
  let footer = '';

  try {
    header = headerTemplate
      ? await renderTemplate(
          params.exportFormat.headerTemplatePath,
          headerTemplate,
          templateData
        )
      : '';
  } catch (e) {
    if (shouldThrow) {
      throw errorToHelpfulError(
        e,
        params.exportFormat.headerTemplatePath,
        headerTemplate
      );
    } else {
      errorToHelpfulNotification(
        e,
        params.exportFormat.headerTemplatePath,
        headerTemplate
      );
      return false;
    }
  }

  try {
    annotations = annotationTemplate
      ? await renderTemplate(
          params.exportFormat.annotationTemplatePath,
          annotationTemplate,
          templateData
        )
      : '';
  } catch (e) {
    if (shouldThrow) {
      throw errorToHelpfulError(
        e,
        params.exportFormat.annotationTemplatePath,
        annotationTemplate
      );
    } else {
      errorToHelpfulNotification(
        e,
        params.exportFormat.annotationTemplatePath,
        annotationTemplate
      );
      return false;
    }
  }

  try {
    footer = footerTemplate
      ? await renderTemplate(
          params.exportFormat.footerTemplatePath,
          footerTemplate,
          templateData
        )
      : '';
  } catch (e) {
    if (shouldThrow) {
      throw errorToHelpfulError(
        e,
        params.exportFormat.footerTemplatePath,
        footerTemplate
      );
    } else {
      errorToHelpfulNotification(
        e,
        params.exportFormat.footerTemplatePath,
        footerTemplate
      );
      return false;
    }
  }

  const output: string[] = [];

  if (headerTemplate && header.trim()) {
    output.push(header);
  }

  const haveAnnotations =
    annotationTemplate && (existingAnnotations + annotations).trim();

  if (haveAnnotations) {
    output.push(wrapAnnotationTemplate(existingAnnotations + annotations));
  }

  if (footerTemplate && footer.trim()) {
    output.push(footer);
  }

  return haveAnnotations ? appendExportDate(output.join('')) : output.join('');
}

export function getATemplatePath({ exportFormat }: ExportToMarkdownParams) {
  return (
    exportFormat.templatePath ||
    exportFormat.headerTemplatePath ||
    exportFormat.annotationTemplatePath ||
    exportFormat.footerTemplatePath ||
    ''
  );
}

async function getAttachmentData(item: any, database: DatabaseWithPort) {
  let mappedAttachments: Record<string, any> = {};

  try {
    const citekey = getCiteKeyFromAny(item);
    if (citekey) {
      const fullAttachmentData = await getAttachmentsFromCiteKey(
        citekey,
        database
      );

      mappedAttachments = ((fullAttachmentData || []) as any[]).reduce<
        Record<string, any>
      >((col, a) => {
        if (a?.path) {
          col[a.path] = a;
        }
        return col;
      }, {});
    }
  } catch (e) {
    console.error(e);
  }

  return mappedAttachments;
}

async function getTemplateData(
  markdownPath: string,
  item: any,
  lastImportDate: moment.Moment,
  ifColorRules?: IfColorRule[],
  propertyItems?: PropertyItem[]
) {
  const firstAnnots = item.attachments.find(
    (a: any) => a.annotations?.length
  );

  item.annotations = firstAnnots?.annotations ?? [];
  item.lastImportDate = lastImportDate;
  item.lastExportDate = lastImportDate;
  item.isFirstImport = lastImportDate.valueOf() === 0;

  // IF 提取与规则匹配
  if (ifColorRules?.length) {
    const ifValue = extractImpactFactor(item.libraryCatalog);
    const matchedRule = matchIfRule(ifValue, ifColorRules);
    if (matchedRule) {
      item.ifColorClass = matchedRule.className;
      item.ifValue = ifValue;
    }
  }

  // 构建属性映射 Record（v2.0 新引擎）
  if (propertyItems?.length) {
    item._propertyRecord = buildPropertyRecord(item, propertyItems, ifColorRules);
  }

  return await applyBasicTemplates(markdownPath, item);
}

/**
 * v3.0 智能多级文件夹路由：解析文件的最终存储路径。
 *
 * - 如果用户配置了 baseStorageFolder，则从 Zotero 分类中计算主路径，
 *   组合为 baseStorageFolder/主分类路径/文件名。
 * - 如果未配置 baseStorageFolder，回退到原模板生成的路径。
 *
 * @param templatePath  - 模板生成的原始文件路径
 * @param item          - Zotero 文献条目
 * @param baseFolder    - 用户配置的根存储目录
 * @returns 最终的 Obsidian 绝对路径
 */
async function resolveSmartPath(
  templatePath: string,
  item: any,
  baseFolder?: string
): Promise<string> {
  // 未配置智能路由时，回退到原模板路径
  if (!baseFolder) {
    return templatePath;
  }

  const fileName = path.posix.basename(templatePath);
  const collectionPaths = (extractSmartField('collections_path', item) || []) as string[];
  const primaryCollection = getPrimaryPath(collectionPaths);
  const smartDir = path.posix.join(baseFolder, primaryCollection);

  return normalizePath(path.posix.join(smartDir, fileName));
}

export async function exportToMarkdown(
  params: ExportToMarkdownParams,
  explicitCiteKeys?: CiteKey[],
  onProgress?: ProgressCallback
): Promise<string[]> {
  const importDate = moment();
  const { database, exportFormat, settings } = params;
  const sourcePath = getATemplatePath(params);
  const canExtract = doesEXEExist();

  const emit = (macro: string, micro?: string) => {
    if (onProgress) onProgress({ macro, micro });
  };

  const citeKeys = explicitCiteKeys
    ? explicitCiteKeys
    : await getCiteKeys(database);
  if (!citeKeys.length) return [];

  const libraryID = citeKeys[0].library;
  let itemData: any;
  try {
    itemData = await getItemJSONFromCiteKeys(citeKeys, database, libraryID);
  } catch (e) {
    return [];
  }

  // Variable to store the paths of the markdown files that will be created on import.
  // This is an array of an interface defined by a citekey and a path.
  // We first store the citekey in the order of the retrieved item data to save the order input by the user.
  // Further down below, when the Markdown file path has been sanitized, we associate the path to the key.
  const createdOrUpdatedMarkdownFiles: string[] = [];

  const total = itemData.length;
  for (let idx = 0; idx < total; idx++) {
    const item = itemData[idx];
    emit(
      `📦 正在处理 ${idx + 1}/${total} 篇文献...`,
      '⏳ 获取元数据与引用...'
    );
    await processItem(item, importDate, database, exportFormat.cslStyle);
  }

  const vaultRoot = getVaultRoot();
  const toRender: Map<
    string,
    {
      item: any;
      file: TFile;
      fileContent: string;
      lastImportDate: moment.Moment;
      existingAnnotations: string;
    }
  > = new Map();

  const queueRender = async (markdownPath: string, item: any) => {
    if (!toRender.has(markdownPath)) {
      const existingMarkdownFile = app.vault.getAbstractFileByPath(
        markdownPath
      ) as TFile;
      const existingMarkdown = existingMarkdownFile
        ? await app.vault.read(existingMarkdownFile as TFile)
        : '';
      const existingAnnotations = existingMarkdownFile
        ? getExistingAnnotations(existingMarkdown)
        : '';
      const lastImportDate = existingMarkdownFile
        ? getLastExport(existingMarkdown)
        : moment(0);

      toRender.set(markdownPath, {
        item,
        file: existingMarkdownFile,
        fileContent: existingMarkdown,
        lastImportDate,
        existingAnnotations,
      });
    }
  };

  const getMarkdownPath = async (pathTemplateData: any) => {
    return normalizePath(
      sanitizeFilePath(
        removeStartingSlash(
          await renderTemplate(
            sourcePath,
            exportFormat.outputPathTemplate,
            pathTemplateData
          )
        )
      )
    );
  };

  for (let i = 0, len = itemData.length; i < len; i++) {
    const item = itemData[i];
    const attachments = item.attachments as any[];
    emit(
      `📦 正在处理 ${i + 1}/${len} 篇文献...`,
      `⏳ 检查附件与 PDF 批注...`
    );
    const attachmentData = await getAttachmentData(item, database);

    if (!attachments.length) {
      const pathTemplateData = await applyBasicTemplates(sourcePath, {
        annotations: [],
        ...item,
      });
      const markdownPath = await getMarkdownPath(pathTemplateData);

      await queueRender(markdownPath, item);
      continue;
    }

    for (let j = 0, jLen = attachments.length; j < jLen; j++) {
      const attachment = attachments[j];
      const attachmentPath = attachment.path;
      const isPDF = attachmentPath?.endsWith('.pdf');

      const pathTemplateData = await applyBasicTemplates(sourcePath, {
        annotations: [],
        ...attachment,
        ...item,
      });

      const imageRelativePath = exportFormat.imageOutputPathTemplate
        ? normalizePath(
            sanitizeFilePath(
              removeStartingSlash(
                await renderTemplate(
                  sourcePath,
                  exportFormat.imageOutputPathTemplate,
                  pathTemplateData
                )
              )
            )
          )
        : '';

      const imageOutputPath = path.resolve(vaultRoot, imageRelativePath);

      const imageBaseName = exportFormat.imageBaseNameTemplate
        ? sanitizeFilePath(
            removeStartingSlash(
              await renderTemplate(
                sourcePath,
                exportFormat.imageBaseNameTemplate,
                pathTemplateData
              )
            )
          )
        : 'image';

      const markdownPath = await getMarkdownPath(pathTemplateData);

      let annots: any[] = [];

      attachmentData[attachmentPath]?.annotations?.forEach((annot: any) => {
        annots.push(
          convertNativeAnnotation(
            annot,
            attachment,
            imageOutputPath,
            imageRelativePath,
            imageBaseName,
            true
          )
        );
      });

      if (annots.length && settings.shouldConcat) {
        annots = concatAnnotations(annots);
      }

      if (isPDF && canExtract) {
        emit(
          `📦 正在处理 ${i + 1}/${len} 篇文献...`,
          '⏳ 正在解析 PDF 高亮与批注...'
        );
        try {
          const res = await extractAnnotations(
            attachmentPath,
            {
              imageBaseName: imageBaseName,
              imageDPI: settings.pdfExportImageDPI,
              imageFormat: settings.pdfExportImageFormat,
              imageOutputPath: imageOutputPath,
              imageQuality: settings.pdfExportImageQuality,
              attemptOCR: settings.pdfExportImageOCR,
              ocrLang: settings.pdfExportImageOCRLang,
              tesseractPath: settings.pdfExportImageTesseractPath,
              tessDataDir: settings.pdfExportImageTessDataDir,
            },
            settings.exeOverridePath
          );

          let extracted = JSON.parse(res);

          for (const e of extracted) {
            processAnnotation(e, attachment, imageRelativePath);
          }

          if (settings.shouldConcat && extracted.length) {
            extracted = concatAnnotations(extracted);
          }

          annots.push(...extracted);
        } catch (e) {
          //
        }
      }

      if (annots.length) {
        attachment.annotations = annots;
      }

      await queueRender(markdownPath, item);
    }
  }

  let renderIdx = 0;
  const renderTotal = toRender.size;
  for (const [markdownPath, data] of toRender.entries()) {
    renderIdx++;
    emit(
      `📦 正在生成文件 ${renderIdx}/${renderTotal}...`,
      '⏳ 组装 Markdown 与 YAML 元数据...'
    );
    try {
      const { existingAnnotations, file, fileContent, item, lastImportDate } =
        data;

      const templateData = await getTemplateData(
        markdownPath,
        item,
        lastImportDate,
        settings.ifColorRules,
        settings.propertyItems
      );
      const rendered = await renderTemplates(
        params,
        PersistExtension.prepareTemplateData(templateData, fileContent),
        existingAnnotations,
        settings
      );

      if (!rendered) continue;

      const syncMode = params.syncMode || 'full';

      if (file) {
        const updateYaml = syncMode === 'full' || syncMode === 'metadata';
        const updateBody = syncMode === 'full' || syncMode === 'annotations';

        if (updateYaml) {
          // ── v5.0 绝对安全 YAML 更新 ──
          // 安全门：只修改 Zotero 映射字段，绝不触碰用户自定义属性
          const renderedYaml = extractFrontmatterBlock(rendered);
          if (renderedYaml) {
            const renderedFm = parseYaml(renderedYaml) || {};
            const allowedKeys = getMappedObsidianKeys(getZoteroMappings(settings.propertyItems || []));
            // 只过滤，不过滤掉 cssclasses 等系统键
            await app.fileManager.processFrontMatter(file, (fm: any) => {
              for (const [key, value] of Object.entries(renderedFm)) {
                // 安全门：只写入 Zotero 映射的 key（+ cssclasses 系统字段）
                if (key === 'cssclasses' || allowedKeys.has(key)) {
                  fm[key] = value;
                }
              }
            });
          }
        }

        if (updateBody) {
          // ── v4.0 正文区域隔离合并 ──
          // Zotero 内容包裹在 %% Zotero_Notes_Start/End %% 标记内
          // 标记外的用户手写笔记 / 批注 100% 保留
          const renderedBody = removeFrontmatter(rendered);
          const updatedContent = await app.vault.read(file);
          const mergedBody = replaceOrAppendZoteroSection(
            updatedContent,
            renderedBody
          );
          if (mergedBody !== updatedContent) {
            await app.vault.modify(file, mergedBody);
          }
        }

        createdOrUpdatedMarkdownFiles.push(markdownPath);
      } else if (syncMode !== 'metadata' && syncMode !== 'annotations') {
        // ── v3.0 智能多级文件夹路由 ──
        const finalPath = await resolveSmartPath(
          markdownPath,
          item,
          settings.baseStorageFolder
        );

        // v4.0: 确保正文包裹在边界标记内，以便后续导入时安全更新
        const renderedBody = removeFrontmatter(rendered);
        const hasMarkers =
          renderedBody.includes(ZOTERO_START) && renderedBody.includes(ZOTERO_END);
        const safeContent = hasMarkers
          ? rendered
          : rendered.replace(
              renderedBody,
              wrapZoteroSection(renderedBody)
            );

        // ── v5.0 注入自定义属性默认值 ──
        // 仅在新文件首次创建时写入空值，后续更新绝不触碰
        let finalContent = safeContent;
        const customProps = getCustomProperties(settings.propertyItems || []);
        if (customProps.length) {
          const fm = extractFrontmatterBlock(safeContent);
          if (fm) {
            const augmentedFm = injectCustomPropertiesIntoYaml(
              fm,
              customProps
            );
            finalContent = safeContent.replace(
              `---\n${fm}\n---`,
              `---\n${augmentedFm}\n---`
            );
          }
        }

        await ensureFolderExists(app.vault, path.posix.dirname(finalPath));
        await app.vault.create(finalPath, finalContent);
        createdOrUpdatedMarkdownFiles.push(finalPath);
      }
    } catch (e) {
      new Notice(
        t('notice.importFailed', markdownPath),
        7000
      );
      console.error(e);
    }
  }

  return createdOrUpdatedMarkdownFiles;
}

export async function renderCiteTemplate(params: RenderCiteTemplateParams) {
  const importDate = moment();
  const { database, format } = params;
  const citeKeys = await getCiteKeys(database);

  if (!citeKeys.length) return null;

  const libraryID = citeKeys[0].library;
  let itemData: any[];
  try {
    itemData = await getItemJSONFromCiteKeys(citeKeys, database, libraryID);
  } catch (e) {
    return null;
  }

  if (itemData.length === 0) {
    return null;
  }

  const output: string[] = [];

  for (const item of itemData) {
    await processItem(item, importDate, database, format.cslStyle);

    const attachments = (item.attachments as any[]) || [];
    const firstAnnots = item.attachments.find(
      (a: any) => a.annotations?.length
    );

    const templateData = {
      attachment: firstAnnots || attachments.length ? attachments[0] : null,
      ...item,
    };

    output.push(await renderTemplate('', format.template, templateData));
  }

  return output.join(' ');
}

function getAStyle(settings: ZoteroConnectorSettings) {
  const exportStyle = settings.exportFormats.find((f) => !!f.cslStyle);

  if (exportStyle) {
    return exportStyle.cslStyle;
  }

  const citeStyle = settings.citeFormats.find((f) => !!f.cslStyle);

  if (citeStyle) {
    return citeStyle.cslStyle;
  }
}

export async function dataExplorerPrompt(settings: ZoteroConnectorSettings) {
  const database = { database: settings.database, port: settings.port };
  const citeKeys = await getCiteKeys(database);
  const canExtract = doesEXEExist();

  if (!citeKeys.length) return null;

  const libraryID = citeKeys[0].library;
  let itemData: any;
  try {
    itemData = await getItemJSONFromCiteKeys(citeKeys, database, libraryID);
  } catch (e) {
    return null;
  }

  const importDate = moment();
  const style = getAStyle(settings);
  const vaultRoot = getVaultRoot();

  for (const item of itemData) {
    await processItem(item, importDate, database, style);

    const attachments = item.attachments;
    const attachmentData = await getAttachmentData(item, database);

    for (const attachment of attachments) {
      const attachmentPath = attachment.path;
      let annots: any[] = [];

      attachmentData[attachmentPath]?.annotations?.forEach((annot: any) => {
        annots.push(
          convertNativeAnnotation(
            annot,
            attachment,
            path.join(vaultRoot, 'output_path'),
            'base_name',
            'output_path'
          )
        );
      });

      if (settings.shouldConcat && annots.length) {
        annots = concatAnnotations(annots);
      }

      if (attachmentPath?.endsWith('.pdf') && canExtract) {
        try {
          const res = await extractAnnotations(
            attachmentPath,
            {
              noWrite: true,
              imageBaseName: 'base_name',
              imageDPI: settings.pdfExportImageDPI,
              imageFormat: settings.pdfExportImageFormat,
              imageOutputPath: path.join(vaultRoot, 'output_path'),
              imageQuality: settings.pdfExportImageQuality,
              attemptOCR: settings.pdfExportImageOCR,
              ocrLang: settings.pdfExportImageOCRLang,
              tesseractPath: settings.pdfExportImageTesseractPath,
              tessDataDir: settings.pdfExportImageTessDataDir,
            },
            settings.exeOverridePath
          );

          let extracted = JSON.parse(res);

          for (const e of extracted) {
            processAnnotation(e, attachment, 'output_path');
          }

          if (settings.shouldConcat && extracted.length) {
            extracted = concatAnnotations(extracted);
          }

          annots.push(...extracted);
        } catch (e) {
          return false;
        }
      }

      if (annots.length) {
        attachment.annotations = annots;
      }
    }
  }

  await Promise.all(
    itemData.map(async (data: any) => {
      await getTemplateData('', data, moment(0), settings.ifColorRules);
    })
  );

  return itemData;
}
