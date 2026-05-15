import Fuse from 'fuse.js';
import { EditableFileView, Editor, Events, Notice, Plugin, TFile, htmlToMarkdown } from 'obsidian';
import { shellPath } from 'shell-path';

import { DataExplorerView, viewType } from './DataExplorerView';
import { LoadingModal } from './bbt/LoadingModal';
import { getCiteKeys } from './bbt/cayw';
import {
  injectBeautifyStyles,
  removeBeautifyStyles,
} from './bbt/styleManager';
import { exportToMarkdown } from './bbt/export';
import {
  filesFromNotes,
  insertNotesIntoCurrentDoc,
  noteExportPrompt,
} from './bbt/exportNotes';
import { getBibFromCiteKeys } from './bbt/jsonRPC';
import { SyncFloatingButton } from './bbt/SyncFloatingButton';
import { CitationEngine } from './citation/citationEngine';
import { citationLivePreviewPlugin } from './citation/cm6LivePreview';
import { createCitationPostProcessor } from './citation/readingMode';
import { CitationPopoverManager } from './citation/hoverPopover';
import './bbt/template.helpers';
import { setLocale, t } from './locale/i18n';
import {
  currentVersion,
  downloadAndExtract,
  internalVersion,
} from './settings/AssetDownloader';
import { ZoteroConnectorSettingsTab } from './settings/settings';
import {
  CiteKeyExport,
  ExportFormat,
  PropertyItem,
  ZoteroConnectorSettings,
} from './types';

const commandPrefix = 'obsidian-zotero-desktop-connector:';
const exportCommandIDPrefix = 'zdc-exp-';
const DEFAULT_SETTINGS: ZoteroConnectorSettings = {
  database: 'Zotero',
  locale: 'en',
  baseStorageFolder: '',
  pdfExportImageDPI: 120,
  pdfExportImageFormat: 'jpg',
  pdfExportImageQuality: 90,
  exportFormats: [],
  ifColorRules: [],
  titleMarqueeEnabled: false,
  titleMarqueeDuration: 15,
  propertyItems: [
    { kind: 'zotero', zoteroField: 'title_smart', obsidianKey: '标题' },
    { kind: 'zotero', zoteroField: 'authors_smart', obsidianKey: '作者' },
    { kind: 'zotero', zoteroField: 'year', obsidianKey: '年份' },
    { kind: 'zotero', zoteroField: 'journal', obsidianKey: '出版物' },
  ],
  floatingButtonTriggers: [{ key: '文献标题', value: '' }],
  autoSyncTriggers: [{ key: '文献标题', value: '' }],
  syncTargets: ['metadata'],
  floatingButtonCommands: ['zdc-update-metadata'],
  inlineCslStyle: '',
  bibliographyCslStyle: '',
  cslStyle: '',
  citationRenderingEnabled: true,
  autoSyncOnOpen: false,
  bodyTemplate: '## Abstract\n\n{{abstract}}\n\n## Notes\n\n{{markdownNotes}}',
  openNoteAfterImport: false,
  whichNotesToOpenAfterImport: 'first-imported-note',
};

async function fixPath() {
  if (process.platform === 'win32') {
    return;
  }

  try {
    const path = await shellPath();

    process.env.PATH =
      path ||
      [
        './node_modules/.bin',
        '/.nodebrew/current/bin',
        '/usr/local/bin',
        process.env.PATH,
      ].join(':');
  } catch (e) {
    console.error(e);
  }
}

export default class ZoteroConnector extends Plugin {
  settings: ZoteroConnectorSettings;
  emitter: Events;
  fuse: Fuse<CiteKeyExport>;
  citationEngine!: CitationEngine;
  citationPopover!: CitationPopoverManager;

  async onload() {
    try {
    this.emitter = new Events();
    await this.loadSettings();
    setLocale(this.settings.locale || 'en');

    // 统一注入美化样式（IF 颜色 + 标题跑马灯，动态属性名）
    injectBeautifyStyles(
      this.settings.propertyItems || [],
      this.settings.ifColorRules || [],
      this.settings.titleMarqueeEnabled || false,
      this.settings.titleMarqueeDuration || 15
    );
    this.emitter.on('settingsUpdated', () => {
      injectBeautifyStyles(
        this.settings.propertyItems || [],
        this.settings.ifColorRules || [],
        this.settings.titleMarqueeEnabled || false,
        this.settings.titleMarqueeDuration || 15
      );
      // CSL 样式变更时清除引注缓存
      this.citationEngine?.invalidateCache();
    });

    this.updatePDFUtility();
    this.addSettingTab(new ZoteroConnectorSettingsTab(this.app, this));
    this.registerView(viewType, (leaf) => new DataExplorerView(this, leaf));

    // ── v6.0：引注渲染引擎初始化 ──
    this.citationEngine = new CitationEngine(this);

    // 注册 CM6 ViewPlugin（Live Preview 引注渲染）
    // registerEditorExtension 在 Obsidian >=0.15.0 可用；旧版类型定义未声明此方法
    const ext = citationLivePreviewPlugin(this.citationEngine, this);
    // registerEditorExtension 在 Obsidian >=0.15.0 可用；旧版类型定义未声明此方法
    if (typeof (this as any).registerEditorExtension === 'function') {
      (this as any).registerEditorExtension(ext);
    } else {
      console.warn('[Zotero Plugin] registerEditorExtension not available — Live Preview citation rendering disabled');
    }

    // 注册 MarkdownPostProcessor（Reading Mode 引注渲染）
    this.registerMarkdownPostProcessor(
      createCitationPostProcessor(
        this.citationEngine,
        () => !!this.settings.citationRenderingEnabled
      )
    );

    // 注册悬停弹窗管理器
    this.citationPopover = new CitationPopoverManager(this, this.citationEngine);
    this.citationPopover.register();

    this.settings.exportFormats.forEach((f) => {
      this.addExportCommand(f);
    });

    // ── v6.0：智能同步 + 行内引注 + 参考文献生成 ──

    // 命令 1：智能同步（根据 syncTargets 执行 metadata + annotations 更新）
    this.addCommand({
      id: 'zdc-smart-sync',
      name: t('command.smartSync'),
      editorCallback: async (editor) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        const cache = this.app.metadataCache.getFileCache(file);
        const citeKey = (cache?.frontmatter?.citekey || cache?.frontmatter?.citationKey || file.basename) as string;
        if (!citeKey) {
          new Notice('⚠️ 无法从当前文件提取 citeKey', 4000);
          return;
        }
        try {
          await this.runSilentAutoSync(citeKey, 1, file.path);
          new Notice(t('notice.autoSyncCompleted'), 3000);
        } catch (e) {
          new Notice(t('notice.autoSyncFailed'), 4000);
        }
      },
    });

    // 命令 A：插入文中引注 — 直接插入 [@citekey] 纯文本
    this.addCommand({
      id: 'zdc-insert-inline-citation',
      name: t('command.insertInlineCitation'),
      editorCallback: async (editor) => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        try {
          const citeKeys = await getCiteKeys(database);
          if (!citeKeys.length) return;
          const refs = citeKeys.map((k) => `[@${k.key}]`).join('; ');
          editor.replaceSelection(refs);
          new Notice(t('notice.inlineCitationInserted'), 3000);
        } catch (e) {
          new Notice(
            `❌ ${e instanceof Error ? e.message : 'Unknown error'}`,
            5000
          );
        }
      },
    });

    // 命令 B：扫描 [@citekey] 引用，批量生成/更新参考文献列表
    this.addCommand({
      id: 'zdc-generate-bibliography',
      name: t('command.generateBibliography'),
      editorCallback: async (editor) => {
        await this.generateBibliographyForEditor(editor);
      },
    });

    // ── v4.0 保留命令 ──

    this.addCommand({
      id: 'zdc-insert-notes',
      name: t('command.insertNotes'),
      editorCallback: (editor) => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        noteExportPrompt(
          database,
          this.app.workspace.getActiveFile()?.parent.path
        ).then((notes) => {
          if (notes) {
            insertNotesIntoCurrentDoc(editor, notes);
          }
        });
      },
    });

    this.addCommand({
      id: 'zdc-import-notes',
      name: t('command.importNotes'),
      callback: () => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        noteExportPrompt(database, (this.settings.baseStorageFolder || ''))
          .then((notes) => {
            if (notes) {
              return filesFromNotes((this.settings.baseStorageFolder || ''), notes);
            }
            return [] as string[];
          })
          .then((notes) => this.openNotes(notes));
      },
    });

    this.addCommand({
      id: 'show-zotero-debug-view',
      name: t('command.dataExplorer'),
      callback: () => {
        this.activateDataExplorer();
      },
    });

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          this.emitter.trigger('fileUpdated', file);
        }
      })
    );

    app.workspace.trigger('parse-style-settings');

    // v5.0: 磁吸悬浮同步球
    new SyncFloatingButton(this);

    fixPath();
    } catch (e) {
      console.error('[Zotero Plugin] onload error:', e);
      new Notice(`Zotero插件加载失败: ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
  }

  onunload() {
    this.settings.exportFormats.forEach((f) => {
      this.removeExportCommand(f);
    });

    this.citationPopover?.unregister();
    removeBeautifyStyles();
    this.app.workspace.detachLeavesOfType(viewType);
  }

  addExportCommand(format: ExportFormat) {
    this.addCommand({
      id: `${exportCommandIDPrefix}${format.name}`,
      name: format.name,
      callback: async () => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        const progressNotice = new Notice('', 0);
        try {
          const paths = await exportToMarkdown(
            { settings: this.settings, database, exportFormat: format },
            undefined,
            ({ macro, micro }) => {
              progressNotice.noticeEl.empty();
              progressNotice.noticeEl.createSpan({ text: macro });
              if (micro) {
                progressNotice.noticeEl.createEl('br');
                const microEl = progressNotice.noticeEl.createSpan({
                  text: micro,
                });
                microEl.style.fontSize = '0.85em';
                microEl.style.opacity = '0.8';
              }
            }
          );
          progressNotice.noticeEl.empty();
          progressNotice.noticeEl.createSpan({
            text: `✅ 导入完成：${paths.length} 篇文献`,
          });
          setTimeout(() => progressNotice.hide(), 3000);
          this.openNotes(paths);
        } catch (e) {
          progressNotice.noticeEl.empty();
          progressNotice.noticeEl.createSpan({
            text: `❌ 导入失败：${e instanceof Error ? e.message : '未知错误'}`,
          });
          setTimeout(() => progressNotice.hide(), 5000);
        }
      },
    });
  }

  /**
   * v6.0 文末参考文献生成器：扫描 [@citekey] 引用 → 调用 Zotero BBT 批量格式化 → 写入「## 参考文献」区域。
   * @param silent 为 true 时不弹出 Notice（由调用方自行处理通知）
   */
  async generateBibliographyForEditor(editor: Editor, silent = false): Promise<void> {
    const database = {
      database: this.settings.database,
      port: this.settings.port,
    };

    // 扫描文档中所有 [@citekey] 引用
    const docText = editor.getValue();
    const citeKeyPattern = /\[@([^\]]+)\]/g;
    const seenKeys = new Set<string>();
    let match;
    while ((match = citeKeyPattern.exec(docText)) !== null) {
      // 支持多引用 [@key1; @key2]
      const keys = match[1].split(';').map((s) => s.trim().replace(/^@/, ''));
      for (const k of keys) {
        if (k) seenKeys.add(k);
      }
    }

    if (seenKeys.size === 0) {
      if (!silent) new Notice(t('notice.noCiteKeysFound'), 4000);
      return;
    }

    const citeKeyObjs: CiteKeyExport[] = Array.from(seenKeys).map((key) => ({
      key,
      library: 1,
      citekey: key,
      title: '',
    }));

    const bib = await getBibFromCiteKeys(
      citeKeyObjs as any,
      database,
      this.settings.bibliographyCslStyle || this.settings.cslStyle || undefined
    );
    if (!bib) {
      if (!silent) new Notice(t('notice.emptyBib'), 5000);
      return;
    }

    let markdownBib = htmlToMarkdown(bib);
    // 将编号条目拆分为独立行（匹配「. 」后紧跟「N. 」的条目边界）
    markdownBib = markdownBib.replace(/([.)])\s+(?=\d+\.\s)/g, '$1\n');
    // v6.1 清除 CSL 残留的内联颜色样式（BBT 可能输出灰色文本）
    markdownBib = markdownBib.replace(/color\s*:\s*[^;>]+[;>]?\s*/gi, '');
    markdownBib = markdownBib.replace(/opacity\s*:\s*[^;>]+[;>]?\s*/gi, '');

    // 查找或创建 ## 参考文献 标题
    const headingPattern = /^## 参考文献\s*$/m;
    const existingMatch = headingPattern.exec(docText);

    if (existingMatch) {
      // 替换已有参考文献区域（使用 replaceRange 保留光标和撤销历史）
      const headingIndex = existingMatch.index;
      const afterHeading = docText.indexOf('\n', headingIndex);
      const nextHeadingIndex = docText.slice(afterHeading + 1).search(/^## /m);
      const endIndex = nextHeadingIndex >= 0
        ? afterHeading + 1 + nextHeadingIndex
        : docText.length;

      // 使用 from/to offset 方式
      const fromPos = editor.offsetToPos(afterHeading + 1);
      const toPos = editor.offsetToPos(endIndex);
      editor.replaceRange('\n\n' + markdownBib + '\n', fromPos, toPos);
    } else {
      // 追加到文档末尾
      const lastLine = editor.lastLine();
      const lastCh = editor.getLine(lastLine).length;
      const endPos = { line: lastLine, ch: lastCh };
      editor.replaceRange('\n\n## 参考文献\n\n' + markdownBib + '\n', endPos, endPos);
    }

    if (!silent) {
      new Notice(
        t('notice.bibliographyGenerated', String(seenKeys.size)),
        3000
      );
    }
  }

  removeExportCommand(format: ExportFormat) {
    (this.app as any).commands.removeCommand(
      `${commandPrefix}${exportCommandIDPrefix}${format.name}`
    );
  }

  async runImport(name: string, citekey: string, library: number = 1) {
    const format = this.settings.exportFormats.find((f) => f.name === name);

    if (!format) {
      throw new Error(t('notice.importFormatNotFound', name));
    }

    const database = {
      database: this.settings.database,
      port: this.settings.port,
    };

    if (citekey.startsWith('@')) citekey = citekey.substring(1);

    await exportToMarkdown(
      {
        settings: this.settings,
        database,
        exportFormat: format,
      },
      [{ key: citekey, library }]
    );
  }

  /**
   * v6.0 静默自动同步：根据 syncTargets 在后台执行 metadata / annotations 更新。
   * 全程无 Modal、无进度提示，成功/失败仅通过右上角 Notice 通知。
   */
  async runSilentAutoSync(citeKey: string, library: number = 1, targetFilePath?: string): Promise<void> {
    const database = { database: this.settings.database, port: this.settings.port };
    const targets = this.settings.syncTargets || ['metadata'];

    const outputPath = targetFilePath || `{{citekey}}.md`;
    const plainExportFormat: ExportFormat = {
      name: '__auto_sync__',
      outputPathTemplate: outputPath,
      imageOutputPathTemplate: '{{citekey}}/',
      imageBaseNameTemplate: 'image',
    };

    if (citeKey.startsWith('@')) citeKey = citeKey.substring(1);

    const errors: string[] = [];

    // 静默执行 metadata 更新
    if (targets.includes('metadata')) {
      try {
        const paths = await exportToMarkdown(
          { settings: this.settings, database, exportFormat: plainExportFormat, syncMode: 'metadata' },
          [{ key: citeKey, library }]
        );
      } catch (e) {
        errors.push(`元数据: ${e instanceof Error ? e.message : 'Unknown'}`);
      }
    }

    // 静默执行 annotations 更新
    if (targets.includes('annotations')) {
      try {
        const paths = await exportToMarkdown(
          { settings: this.settings, database, exportFormat: plainExportFormat, syncMode: 'annotations' },
          [{ key: citeKey, library }]
        );
      } catch (e) {
        errors.push(`批注: ${e instanceof Error ? e.message : 'Unknown'}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }

  async openNotes(createdOrUpdatedMarkdownFilesPaths: string[]) {
    const pathOfNotesToOpen: string[] = [];
    if (this.settings.openNoteAfterImport) {
      // Depending on the choice, retreive the paths of the first, the last or all imported notes
      switch (this.settings.whichNotesToOpenAfterImport) {
        case 'first-imported-note': {
          pathOfNotesToOpen.push(createdOrUpdatedMarkdownFilesPaths[0]);
          break;
        }
        case 'last-imported-note': {
          pathOfNotesToOpen.push(
            createdOrUpdatedMarkdownFilesPaths[
              createdOrUpdatedMarkdownFilesPaths.length - 1
            ]
          );
          break;
        }
        case 'all-imported-notes': {
          pathOfNotesToOpen.push(...createdOrUpdatedMarkdownFilesPaths);
          break;
        }
      }
    }

    // Force a 1s delay after importing the files to make sure that notes are created before attempting to open them.
    // A better solution could surely be found to refresh the vault, but I am not sure how to proceed!
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const path of pathOfNotesToOpen) {
      const note = this.app.vault.getAbstractFileByPath(path);
      const open = leaves.find(
        (leaf) => (leaf.view as EditableFileView).file === note
      );
      if (open) {
        app.workspace.revealLeaf(open);
      } else if (note instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(note);
      }
    }
  }

  async loadSettings() {
    const loadedSettings = await this.loadData();

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
    };

    // v6.0: floatingButtonCommands → syncTargets 迁移
    if (!this.settings.syncTargets?.length && this.settings.floatingButtonCommands?.length) {
      const targets: string[] = [];
      const cmdToTarget: Record<string, string> = {
        'zdc-update-metadata': 'metadata',
        'zdc-sync-annotations': 'annotations',
      };
      for (const cmd of this.settings.floatingButtonCommands) {
        const target = cmdToTarget[cmd];
        if (target && !targets.includes(target)) targets.push(target);
      }
      this.settings.syncTargets = targets.length > 0 ? targets : ['metadata'];
    }

    // v6.1: 迁移旧 cslStyle → inlineCslStyle + bibliographyCslStyle
    if (!this.settings.inlineCslStyle && !this.settings.bibliographyCslStyle && this.settings.cslStyle) {
      this.settings.inlineCslStyle = this.settings.cslStyle;
      this.settings.bibliographyCslStyle = this.settings.cslStyle;
      // 保留 cslStyle 字段供旧代码兼容（不 delete）
      await this.saveSettings();
    }

    // v5.4: 迁移旧 triggerFeatureKey/triggerFeatureValue → floatingButtonTriggers + autoSyncTriggers
    if (!this.settings.floatingButtonTriggers?.length && (this.settings as any).triggerFeatureKey) {
      const oldKey = (this.settings as any).triggerFeatureKey as string;
      const oldValue = ((this.settings as any).triggerFeatureValue as string) || '';
      this.settings.floatingButtonTriggers = [{ key: oldKey, value: oldValue }];
      this.settings.autoSyncTriggers = [{ key: oldKey, value: oldValue }];
      delete (this.settings as any).triggerFeatureKey;
      delete (this.settings as any).triggerFeatureValue;
      await this.saveSettings();
    }

    // v5.2: 迁移旧格式 propertyMappings + customProperties → propertyItems
    if (!this.settings.propertyItems?.length && (this.settings.propertyMappings?.length || this.settings.customProperties?.length)) {
      const items: PropertyItem[] = [];
      for (const m of this.settings.propertyMappings || []) {
        items.push({ kind: 'zotero', obsidianKey: m.obsidianKey, zoteroField: m.zoteroField });
      }
      for (const c of this.settings.customProperties || []) {
        items.push({ kind: 'custom', obsidianKey: c.key, customType: c.type, customValue: c.value });
      }
      this.settings.propertyItems = items;
      delete this.settings.propertyMappings;
      delete this.settings.customProperties;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    this.emitter.trigger('settingsUpdated');
    await this.saveData(this.settings);
  }

  deactivateDataExplorer() {
    this.app.workspace.detachLeavesOfType(viewType);
  }

  async activateDataExplorer() {
    this.deactivateDataExplorer();
    const leaf = this.app.workspace.createLeafBySplit(
      this.app.workspace.activeLeaf,
      'vertical'
    );

    await leaf.setViewState({
      type: viewType,
    });
  }

  async updatePDFUtility() {
    const { exeOverridePath, _exeInternalVersion, exeVersion } = this.settings;
    if (exeOverridePath || !exeVersion) return;

    if (
      exeVersion !== currentVersion ||
      !_exeInternalVersion ||
      _exeInternalVersion !== internalVersion
    ) {
      const modal = new LoadingModal(
        app,
        t('modal.updatingPDFUtility')
      );
      modal.open();

      try {
        const success = await downloadAndExtract();

        if (success) {
          this.settings.exeVersion = currentVersion;
          this.settings._exeInternalVersion = internalVersion;
          this.saveSettings();
        }
      } catch {
        //
      }

      modal.close();
    }
  }
}
