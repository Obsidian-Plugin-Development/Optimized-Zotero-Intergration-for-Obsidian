export type Format =
  | 'latex'
  | 'biblatex'
  | 'pandoc'
  | 'formatted-citation'
  | 'formatted-bibliography'
  | 'template';

export interface CitationFormat {
  name: string;
  format: Format;
  command?: string;
  brackets?: boolean;
  cslStyle?: string;
  template?: string;
}

export type Database = 'Zotero' | 'Juris-M' | 'Custom';
export type DatabaseWithPort = {
  database: Database;
  port?: string;
};

export type NotesToOpenAfterImport =
  | 'first-imported-note'
  | 'last-imported-note'
  | 'all-imported-notes';

export interface CalloutDef {
  type: string;
  prefix: string;
}

export enum GroupingOptions {
  Tag = 'tag',
  AnnotationDate = 'annotation-date',
  ExportDate = 'export-date',
  Color = 'color',
}

export enum SortingOptions {
  Color = 'color',
  Date = 'date',
  Location = 'location',
}

export interface ExportFormat {
  name: string;
  outputPathTemplate: string;
  imageOutputPathTemplate: string;
  imageBaseNameTemplate: string;

  templatePath?: string;
  cslStyle?: string;

  // Deprecated
  headerTemplatePath?: string;
  annotationTemplatePath?: string;
  footerTemplatePath?: string;
}

/** v4.0: 同步模式控制导出行为 */
export type SyncMode = 'full' | 'metadata' | 'annotations';

export interface ExportToMarkdownParams {
  settings: ZoteroConnectorSettings;
  database: DatabaseWithPort;
  exportFormat: ExportFormat;
  /** v4.0: 同步模式。full=完整导入, metadata=仅更新YAML, annotations=仅更新正文 */
  syncMode?: SyncMode;
}

export interface RenderCiteTemplateParams {
  database: DatabaseWithPort;
  format: CitationFormat;
}

export interface IfColorRule {
  id: string;
  min: number;
  max: number | null;
  bgColor: string;
  textColor: string;
  borderColor: string;
  className: string;
}

export interface PropertyMapping {
  zoteroField: string;
  obsidianKey: string;
}

/** v5.0: 用户自定义 Obsidian 属性预设（保留用于 helper 返回类型） */
export interface CustomProperty {
  key: string;
  type: 'text' | 'list' | 'number' | 'checkbox' | 'date';
  /** v5.1: 用户指定的默认值，优先级高于类型默认值 */
  value?: string;
}

/** v5.2: 统一属性项 — 合并 Zotero 字段映射与用户自定义属性 */
export interface PropertyItem {
  kind: 'zotero' | 'custom';
  /** Obsidian 属性名（两者共用） */
  obsidianKey: string;
  /** Zotero 字段名（仅 kind='zotero'） */
  zoteroField?: string;
  /** 自定义属性类型（仅 kind='custom'） */
  customType?: 'text' | 'list' | 'number' | 'checkbox' | 'date';
  /** 自定义属性默认值（仅 kind='custom'） */
  customValue?: string;
}

export interface SmartFieldOption {
  value: string;
  label: string;
}

export interface ZoteroConnectorSettings {
  citeFormats: CitationFormat[];
  citeSuggestTemplate?: string;
  database: Database;
  port?: string;
  exeVersion?: string;
  _exeInternalVersion?: number;
  exeOverridePath?: string;
  exportFormats: ExportFormat[];
  locale?: 'en' | 'zh-cn';
  ifColorRules?: IfColorRule[];
  titleMarqueeEnabled?: boolean;
  titleMarqueeDuration?: number;
  /** v5.2: 统一属性列表 — 替代旧的 propertyMappings + customProperties */
  propertyItems?: PropertyItem[];
  /** v5.2 已废弃，迁移到 propertyItems */
  propertyMappings?: PropertyMapping[];
  /** v5.2 已废弃，迁移到 propertyItems */
  customProperties?: CustomProperty[];
  /** v5.0: 悬浮球触发特征键，YAML 中包含此 key 时才判定为文献笔记 */
  triggerFeatureKey?: string;
  /** v5.1: 悬浮球触发特征值。设置了值则需要 key+value 同时匹配 */
  triggerFeatureValue?: string;
  /** v5.0: 悬浮球点击后可触发的命令 ID 列表（多选），弹出菜单供用户选择 */
  floatingButtonCommands?: string[];
  /** v5.2: 开卷自动同步 — 打开匹配触发条件的笔记时静默执行同步 */
  autoSyncOnOpen?: boolean;
  bodyTemplate?: string;
  /** v3.0: 智能多级文件夹路由的根存储目录 */
  baseStorageFolder?: string;
  openNoteAfterImport: boolean;
  pdfExportImageDPI?: number;
  pdfExportImageFormat?: string;
  pdfExportImageOCR?: boolean;
  pdfExportImageOCRLang?: string;
  pdfExportImageQuality?: number;
  pdfExportImageTessDataDir?: string;
  pdfExportImageTesseractPath?: string;
  settingsVersion?: number;
  shouldConcat?: boolean;
  whichNotesToOpenAfterImport: NotesToOpenAfterImport;
}

export interface ImportProgress {
  macro: string;
  micro?: string;
}

export type ProgressCallback = (progress: ImportProgress) => void;

export interface CiteKeyExport {
  libraryID: number;
  citekey: string;
  title: string;
}
