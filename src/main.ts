import Fuse from 'fuse.js';
import { EditableFileView, Events, Notice, Plugin, TFile, htmlToMarkdown } from 'obsidian';
import { shellPath } from 'shell-path';

import { DataExplorerView, viewType } from './DataExplorerView';
import { LoadingModal } from './bbt/LoadingModal';
import { getCAYW, getCiteKeys } from './bbt/cayw';
import {
  injectBeautifyStyles,
  removeBeautifyStyles,
} from './bbt/styleManager';
import { exportToMarkdown, renderCiteTemplate } from './bbt/export';
import {
  filesFromNotes,
  insertNotesIntoCurrentDoc,
  noteExportPrompt,
} from './bbt/exportNotes';
import { getItemJSONFromCiteKeys, getIssueDateFromCiteKey, getBibFromCiteKeys } from './bbt/jsonRPC';
import { buildPropertyRecord, recordToYaml } from './bbt/templateEngine';
import { SyncFloatingButton } from './bbt/SyncFloatingButton';
import './bbt/template.helpers';
import { setLocale, t } from './locale/i18n';
import {
  currentVersion,
  downloadAndExtract,
  internalVersion,
} from './settings/AssetDownloader';
import { ZoteroConnectorSettingsTab } from './settings/settings';
import {
  CitationFormat,
  CiteKeyExport,
  ExportFormat,
  PropertyItem,
  ZoteroConnectorSettings,
} from './types';

const commandPrefix = 'obsidian-zotero-desktop-connector:';
const citationCommandIDPrefix = 'zdc-';
const exportCommandIDPrefix = 'zdc-exp-';
const DEFAULT_SETTINGS: ZoteroConnectorSettings = {
  database: 'Zotero',
  locale: 'en',
  baseStorageFolder: '',
  pdfExportImageDPI: 120,
  pdfExportImageFormat: 'jpg',
  pdfExportImageQuality: 90,
  citeFormats: [],
  exportFormats: [],
  citeSuggestTemplate: '[[{{citekey}}]]',
  ifColorRules: [],
  titleMarqueeEnabled: false,
  titleMarqueeDuration: 15,
  propertyItems: [
    { kind: 'zotero', zoteroField: 'title_smart', obsidianKey: '标题' },
    { kind: 'zotero', zoteroField: 'authors_smart', obsidianKey: '作者' },
    { kind: 'zotero', zoteroField: 'year', obsidianKey: '年份' },
    { kind: 'zotero', zoteroField: 'journal', obsidianKey: '出版物' },
  ],
  triggerFeatureKey: '文献标题',
  triggerFeatureValue: '',
  floatingButtonCommands: ['zdc-update-metadata'],
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

  async onload() {
    try {
    await this.loadSettings();
    setLocale(this.settings.locale || 'en');
    this.emitter = new Events();

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
    });

    this.updatePDFUtility();
    this.addSettingTab(new ZoteroConnectorSettingsTab(this.app, this));
    this.registerView(viewType, (leaf) => new DataExplorerView(this, leaf));

    this.settings.citeFormats.forEach((f) => {
      this.addFormatCommand(f);
    });

    this.settings.exportFormats.forEach((f) => {
      this.addExportCommand(f);
    });

    // ── v4.0：三个插入当前笔记的命令 ──

    // 命令：插入条目信息（YAML frontmatter）
    this.addCommand({
      id: 'zdc-insert-item-info',
      name: t('command.insertItemInfo'),
      editorCallback: async (editor) => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        try {
          const citeKeys = await getCiteKeys(database);
          if (!citeKeys.length) return;

          const libraryID = citeKeys[0].library;
          const itemData = await getItemJSONFromCiteKeys(citeKeys, database, libraryID);
          if (!itemData?.length) return;

          const results: string[] = [];
          for (const item of itemData) {
            try {
              item.date = await getIssueDateFromCiteKey(
                { key: item.citekey || item.key, library: libraryID },
                database
              );
            } catch { /* date is optional */ }

            const record = buildPropertyRecord(
              item,
              this.settings.propertyItems || [],
              this.settings.ifColorRules || []
            );
            results.push(recordToYaml(record));
          }

          editor.replaceSelection(results.join('\n\n'));
          new Notice(
            t('notice.itemInfoInserted', String(results.length)),
            3000
          );
        } catch (e) {
          new Notice(
            `❌ ${e instanceof Error ? e.message : 'Unknown error'}`,
            5000
          );
        }
      },
    });

    // 命令：插入笔记与批注（Zotero notes + PDF annotations）
    this.addCommand({
      id: 'zdc-insert-annotations',
      name: t('command.insertAnnotations'),
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
            new Notice(
              t('notice.annotationsInserted', String(Object.keys(notes).length)),
              3000
            );
          }
        });
      },
    });

    // 命令：插入参考文献（formatted bibliography）
    this.addCommand({
      id: 'zdc-insert-bibliography',
      name: t('command.insertBibliography'),
      editorCallback: async (editor) => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        try {
          const citeKeys = await getCiteKeys(database);
          if (!citeKeys.length) return;

          const bib = await getBibFromCiteKeys(citeKeys, database);
          if (bib) {
            // getBibFromCiteKeys returns HTML; convert to Markdown
            const markdownBib = htmlToMarkdown(bib);
            editor.replaceSelection(markdownBib);
            new Notice(
              t('notice.bibInserted', String(citeKeys.length)),
              3000
            );
          }
        } catch (e) {
          new Notice(
            `❌ ${e instanceof Error ? e.message : 'Unknown error'}`,
            5000
          );
        }
      },
    });

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
      id: 'zdc-quick-import',
      name: t('command.quickImport'),
      callback: async () => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        const plainExportFormat: ExportFormat = {
          name: '__quick_import__',
          outputPathTemplate: '{{citekey}}.md',
          imageOutputPathTemplate: '{{citekey}}/',
          imageBaseNameTemplate: 'image',
        };
        const progressNotice = new Notice('', 0);
        try {
          const paths = await exportToMarkdown(
            { settings: this.settings, database, exportFormat: plainExportFormat },
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

    // ── v4.0 模块二：三个解耦命令 ──

    // 命令 1：仅更新 YAML 元数据（不触碰正文）
    this.addCommand({
      id: 'zdc-update-metadata',
      name: t('command.updateMetadata'),
      callback: async () => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        const plainExportFormat: ExportFormat = {
          name: '__update_metadata__',
          outputPathTemplate: '{{citekey}}.md',
          imageOutputPathTemplate: '{{citekey}}/',
          imageBaseNameTemplate: 'image',
        };
        const progressNotice = new Notice('', 0);
        try {
          const paths = await exportToMarkdown(
            { settings: this.settings, database, exportFormat: plainExportFormat, syncMode: 'metadata' },
            undefined,
            ({ macro }) => {
              progressNotice.noticeEl.empty();
              progressNotice.noticeEl.createSpan({ text: macro });
            }
          );
          progressNotice.noticeEl.empty();
          progressNotice.noticeEl.createSpan({
            text: paths.length > 0
              ? t('notice.metadataUpdated', String(paths.length))
              : t('notice.noFilesToUpdate'),
          });
          setTimeout(() => progressNotice.hide(), 4000);
        } catch (e) {
          progressNotice.noticeEl.empty();
          progressNotice.noticeEl.createSpan({
            text: `❌ ${e instanceof Error ? e.message : 'Unknown error'}`,
          });
          setTimeout(() => progressNotice.hide(), 5000);
        }
      },
    });

    // 命令 2：仅同步笔记与批注（不触碰 YAML）
    this.addCommand({
      id: 'zdc-sync-annotations',
      name: t('command.syncAnnotations'),
      callback: async () => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        const plainExportFormat: ExportFormat = {
          name: '__sync_annotations__',
          outputPathTemplate: '{{citekey}}.md',
          imageOutputPathTemplate: '{{citekey}}/',
          imageBaseNameTemplate: 'image',
        };
        const progressNotice = new Notice('', 0);
        try {
          const paths = await exportToMarkdown(
            { settings: this.settings, database, exportFormat: plainExportFormat, syncMode: 'annotations' },
            undefined,
            ({ macro }) => {
              progressNotice.noticeEl.empty();
              progressNotice.noticeEl.createSpan({ text: macro });
            }
          );
          progressNotice.noticeEl.empty();
          progressNotice.noticeEl.createSpan({
            text: paths.length > 0
              ? t('notice.annotationsSynced', String(paths.length))
              : t('notice.noFilesToUpdate'),
          });
          setTimeout(() => progressNotice.hide(), 4000);
        } catch (e) {
          progressNotice.noticeEl.empty();
          progressNotice.noticeEl.createSpan({
            text: `❌ ${e instanceof Error ? e.message : 'Unknown error'}`,
          });
          setTimeout(() => progressNotice.hide(), 5000);
        }
      },
    });

    // 命令 3：复制引注占位符到剪贴板（不创建/修改任何笔记）
    this.addCommand({
      id: 'zdc-copy-citation',
      name: t('command.copyCitation'),
      callback: async () => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        try {
          const citeFormat: CitationFormat = {
            name: '__copy_citation__',
            format: 'pandoc',
            brackets: true,
          };
          const result = await getCAYW(citeFormat, database);
          if (typeof result === 'string' && result.trim()) {
            await navigator.clipboard.writeText(result);
            new Notice(t('notice.citationCopied', result), 4000);
          } else {
            new Notice(t('notice.noCitationReturned'), 5000);
          }
        } catch (e) {
          new Notice(
            `❌ ${e instanceof Error ? e.message : 'Unknown error'}`,
            5000
          );
        }
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
    this.settings.citeFormats.forEach((f) => {
      this.removeFormatCommand(f);
    });

    this.settings.exportFormats.forEach((f) => {
      this.removeExportCommand(f);
    });

    removeBeautifyStyles();
    this.app.workspace.detachLeavesOfType(viewType);
  }

  addFormatCommand(format: CitationFormat) {
    this.addCommand({
      id: `${citationCommandIDPrefix}${format.name}`,
      name: format.name,
      editorCallback: (editor) => {
        const database = {
          database: this.settings.database,
          port: this.settings.port,
        };
        if (format.format === 'template' && format.template.trim()) {
          renderCiteTemplate({
            database,
            format,
          }).then((res) => {
            if (typeof res === 'string') {
              editor.replaceSelection(res);
            }
          });
        } else {
          getCAYW(format, database).then((res) => {
            if (typeof res === 'string') {
              editor.replaceSelection(res);
            }
          });
        }
      },
    });
  }

  removeFormatCommand(format: CitationFormat) {
    (this.app as any).commands.removeCommand(
      `${commandPrefix}${citationCommandIDPrefix}${format.name}`
    );
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
   * v5.2 静默自动同步：根据用户勾选的「执行同步内容」在后台执行更新。
   * 仅处理 zdc-update-metadata 和 zdc-sync-annotations，
   * 其他交互式命令（快速导入、插入参考文献等）自动忽略。
   * 全程无 Modal、无进度提示，成功/失败仅通过右上角 Notice 通知。
   */
  async runSilentAutoSync(citeKey: string, library: number = 1, targetFilePath?: string): Promise<void> {
    const database = { database: this.settings.database, port: this.settings.port };
    const commands = this.settings.floatingButtonCommands || [];

    // v5.2 bugfix: 用当前文件路径作为 outputPathTemplate，确保 exportToMarkdown
    // 能通过 getAbstractFileByPath 找到文件，而不是在 vault 根目录瞎找 {{citekey}}.md
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
    if (commands.includes('zdc-update-metadata')) {
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
    if (commands.includes('zdc-sync-annotations')) {
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
