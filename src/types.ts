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
  propertyMappings?: PropertyMapping[];
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
