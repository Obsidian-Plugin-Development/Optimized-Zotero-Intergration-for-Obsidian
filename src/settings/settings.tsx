import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import React from 'react';
import ReactDOM from 'react-dom';
import which from 'which';

import ZoteroConnector from '../main';
import {
  getLocale,
  getLocaleOptions,
  setLocale,
  t,
} from '../locale/i18n';
import {
  createIfRule,
  injectTitleMarqueeStyles,
} from '../bbt/styleManager';
import { SMART_FIELD_OPTIONS } from '../bbt/smartExtractors';
import { getZoteroMappings, getCustomProperties } from '../bbt/helpers';
import {
  ExportFormat,
  IfColorRule,
  PropertyItem,
  TriggerCondition,
  ZoteroConnectorSettings,
} from '../types';
import { AssetDownloader } from './AssetDownloader';
import { ExportFormatSettings } from './ExportFormatSettings';
import { Icon } from './Icon';
import { SettingItem } from './SettingItem';

// ── Types ──

/** v4.0: 3 个面向工作流的清晰标签页 */
type TabId = 'metadata' | 'notes' | 'citation' | 'sync';

const TAB_ITEMS: { id: TabId; labelKey: string }[] = [
  { id: 'sync', labelKey: 'settings.tab.sync' },
  { id: 'metadata', labelKey: 'settings.tab.metadata' },
  { id: 'notes', labelKey: 'settings.tab.notes' },
  { id: 'citation', labelKey: 'settings.tab.citation' },
];

// ── System Header React 组件（始终可见）──

interface SystemHeaderProps {
  settings: ZoteroConnectorSettings;
  updateSetting: (key: keyof ZoteroConnectorSettings, value: any) => void;
}

function SystemHeader({ settings, updateSetting }: SystemHeaderProps) {
  const [locale, setLocaleState] = React.useState(getLocale());
  const [useCustomPort, setUseCustomPort] = React.useState(settings.database === 'Custom');
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [ocrState, setOCRState] = React.useState(settings.pdfExportImageOCR);
  const tessPathRef = React.useRef<HTMLInputElement>(null);
  const tessDataPathRef = React.useRef<HTMLInputElement>(null);

  return (
    <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--background-modifier-border)' }}>
      <SettingItem name={t('settings.system')} isHeading />

      <SettingItem name={t('settings.locale')} description={t('settings.locale.desc')}>
        <select
          className="dropdown"
          value={locale}
          onChange={(e) => {
            const newLocale = (e.target as HTMLSelectElement).value as 'en' | 'zh-cn';
            setLocaleState(newLocale);
            setLocale(newLocale);
            updateSetting('locale', newLocale);
          }}
        >
          {getLocaleOptions().map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </SettingItem>

      <SettingItem name={t('settings.database')} description={t('settings.database.desc')}>
        <select
          className="dropdown"
          defaultValue={settings.database}
          onChange={(e) => {
            const value = (e.target as HTMLSelectElement).value;
            updateSetting('database', value);
            setUseCustomPort(value === 'Custom');
          }}
        >
          <option value="Zotero">Zotero</option>
          <option value="Juris-M">Juris-M</option>
          <option value="Custom">Custom</option>
        </select>
      </SettingItem>

      {useCustomPort ? (
        <SettingItem name={t('settings.port')} description={t('settings.port.desc')}>
          <input
            onChange={(e) => updateSetting('port', (e.target as HTMLInputElement).value)}
            type="number"
            placeholder={t('settings.port.placeholder')}
            defaultValue={settings.port}
          />
        </SettingItem>
      ) : null}

      <SettingItem
        name={t('settings.baseStorageFolder')}
        description={t('settings.baseStorageFolder.desc')}
      >
        <input
          onChange={(e) => updateSetting('baseStorageFolder', (e.target as HTMLInputElement).value)}
          type="text"
          spellCheck={false}
          placeholder={t('settings.baseStorageFolder.placeholder')}
          defaultValue={settings.baseStorageFolder || ''}
        />
      </SettingItem>

      {/* 高级设置：Storage 详情 + 图片设置 */}
      <div
        style={{ cursor: 'pointer', marginTop: '8px', color: 'var(--text-muted)', fontSize: '0.9em' }}
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? '▾' : '▸'} {t('settings.advanced')}
      </div>

      {showAdvanced && (
        <div style={{ marginTop: '8px', paddingLeft: '8px', borderLeft: '2px solid var(--background-modifier-border)' }}>
          <AssetDownloader settings={settings} updateSetting={updateSetting} />

          <SettingItem name={t('settings.imageSettings')} description={t('settings.imageSettings.desc')} isHeading />
          <SettingItem name={t('settings.imageFormat')}>
            <select
              className="dropdown"
              defaultValue={settings.pdfExportImageFormat}
              onChange={(e) => updateSetting('pdfExportImageFormat', (e.target as HTMLSelectElement).value)}
            >
              <option value="jpg">jpg</option>
              <option value="png">png</option>
            </select>
          </SettingItem>
          <SettingItem name={t('settings.imageQuality')}>
            <input
              min="0" max="100"
              onChange={(e) => updateSetting('pdfExportImageQuality', Number((e.target as HTMLInputElement).value))}
              type="number"
              defaultValue={settings.pdfExportImageQuality.toString()}
            />
          </SettingItem>
          <SettingItem name={t('settings.imageDPI')}>
            <input
              min="0"
              onChange={(e) => updateSetting('pdfExportImageDPI', Number((e.target as HTMLInputElement).value))}
              type="number"
              defaultValue={settings.pdfExportImageDPI.toString()}
            />
          </SettingItem>
          <SettingItem
            name={t('settings.imageOCR')}
            description={
              <div>
                {t('settings.imageOCR.desc.line1')}{' '}
                <a href="https://tesseract-ocr.github.io/tessdoc/" target="_blank" rel="noreferrer">tesseract</a>{' '}
                {t('settings.imageOCR.desc.line2')}{' '}
                <a href="https://brew.sh/" target="_blank" rel="noreferrer">{t('settings.imageOCR.desc.line3')}</a>
                {t('settings.imageOCR.desc.line4')}{' '}
                <a href="https://github.com/UB-Mannheim/tesseract/wiki" target="_blank" rel="noreferrer">{t('settings.imageOCR.desc.line5')}</a>
                .
              </div>
            }
          >
            <div
              onClick={() => setOCRState((s) => { updateSetting('pdfExportImageOCR', !s); return !s; })}
              className={`checkbox-container${ocrState ? ' is-enabled' : ''}`}
            />
          </SettingItem>
          <SettingItem
            name={t('settings.imageOCR.tesseractPath')}
            description={<div>{t('settings.imageOCR.tesseractPath.desc1')} <pre>which tesseract</pre></div>}
          >
            <input
              ref={tessPathRef}
              onChange={(e) => updateSetting('pdfExportImageTesseractPath', (e.target as HTMLInputElement).value)}
              type="text"
              defaultValue={settings.pdfExportImageTesseractPath}
            />
            <div
              className="clickable-icon setting-editor-extra-setting-button"
              aria-label={t('settings.pdfUtility.findTesseract')}
              onClick={async () => {
                try {
                  const pathToTesseract = await which('tesseract');
                  if (pathToTesseract) {
                    tessPathRef.current.value = pathToTesseract;
                    updateSetting('pdfExportImageTesseractPath', pathToTesseract);
                  } else {
                    new Notice(t('settings.pdfUtility.findTesseract.fail'));
                  }
                } catch (e) {
                  new Notice(t('settings.pdfUtility.findTesseract.fail'));
                  console.error(e);
                }
              }}
            >
              <Icon name="magnifying-glass" />
            </div>
          </SettingItem>
          <SettingItem
            name={t('settings.imageOCR.lang')}
            description={
              <div>
                {t('settings.imageOCR.lang.desc1')} <pre>eng+deu</pre>. {t('settings.imageOCR.lang.desc2')}{' '}
                <a href="https://github.com/tesseract-ocr/tessdata" target="_blank" rel="noreferrer">{t('settings.imageOCR.lang.desc3')}</a>
                . ({' '}
                <a href="https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html" target="_blank" rel="noreferrer">{t('settings.imageOCR.lang.desc4')}</a>
                )
              </div>
            }
          >
            <input
              onChange={(e) => updateSetting('pdfExportImageOCRLang', (e.target as HTMLInputElement).value)}
              type="text"
              defaultValue={settings.pdfExportImageOCRLang}
            />
          </SettingItem>
          <SettingItem name={t('settings.imageOCR.tessDataDir')} description={t('settings.imageOCR.tessDataDir.desc')}>
            <input
              ref={tessDataPathRef}
              onChange={(e) => updateSetting('pdfExportImageTessDataDir', (e.target as HTMLInputElement).value)}
              type="text"
              defaultValue={settings.pdfExportImageTessDataDir}
            />
            <div
              className="clickable-icon setting-editor-extra-setting-button"
              aria-label={t('settings.pdfUtility.selectTessDataDir')}
              onClick={() => {
                const path = require('electron').remote.dialog.showOpenDialogSync({ properties: ['openDirectory'] });
                if (path && path.length) {
                  tessDataPathRef.current.value = path[0];
                  updateSetting('pdfExportImageTessDataDir', path[0]);
                }
              }}
            >
              <Icon name="lucide-folder-open" />
            </div>
          </SettingItem>
        </div>
      )}
    </div>
  );
}

// ── Tab 2：笔记模板（Notes Template）React 组件 ──

interface NotesTabProps {
  settings: ZoteroConnectorSettings;
  addExportFormat: (format: ExportFormat) => ExportFormat[];
  updateExportFormat: (index: number, format: ExportFormat) => ExportFormat[];
  removeExportFormat: (index: number) => ExportFormat[];
  updateSetting: (key: keyof ZoteroConnectorSettings, value: any) => void;
  saveBodyTemplate: (value: string) => void;
}

function NotesTab({
  settings,
  addExportFormat,
  updateExportFormat,
  removeExportFormat,
  updateSetting,
  saveBodyTemplate,
}: NotesTabProps) {
  const [exportFormatState, setExportFormatState] = React.useState(settings.exportFormats);
  const [openNoteAfterImportState, setOpenNoteAfterImport] = React.useState(!!settings.openNoteAfterImport);
  const [concat, setConcat] = React.useState(!!settings.shouldConcat);

  const updateExport = React.useCallback(
    debounce((index: number, format: ExportFormat) => {
      setExportFormatState(updateExportFormat(index, format));
    }, 200, true),
    [updateExportFormat]
  );

  const addExport = React.useCallback(() => {
    setExportFormatState(
      addExportFormat({
        name: `Import #${exportFormatState.length + 1}`,
        outputPathTemplate: '{{citekey}}.md',
        imageOutputPathTemplate: '{{citekey}}/',
        imageBaseNameTemplate: 'image',
      })
    );
  }, [addExportFormat, exportFormatState]);

  const removeExport = React.useCallback((index: number) => {
    setExportFormatState(removeExportFormat(index));
  }, [removeExportFormat]);

  return (
    <div>
      {/* 正文模板 */}
      <SettingItem name={t('settings.notes.bodyTemplate')} description={t('settings.notes.bodyTemplate.desc')} isHeading />
      <textarea
        className="zt-body-template-textarea"
        placeholder={'## Abstract\n\n{{abstract}}\n\n## Notes\n\n{{markdownNotes}}'}
        defaultValue={settings.bodyTemplate || ''}
        onInput={(e) => saveBodyTemplate((e.target as HTMLTextAreaElement).value)}
        style={{
          width: '100%', minHeight: '200px', fontFamily: 'var(--font-monospace)',
          fontSize: '0.85em', marginBottom: '16px',
        }}
      />

      {/* 导入行为 */}
      <SettingItem name={t('settings.notes.importBehavior')} isHeading />

      <SettingItem name={t('settings.openAfterImport')} description={t('settings.openAfterImport.desc')}>
        <div
          onClick={() => setOpenNoteAfterImport((s) => { updateSetting('openNoteAfterImport', !s); return !s; })}
          className={`checkbox-container${openNoteAfterImportState ? ' is-enabled' : ''}`}
        />
      </SettingItem>

      <SettingItem name={t('settings.whichNotesToOpen')} description={t('settings.whichNotesToOpen.desc')}>
        <select
          className="dropdown"
          defaultValue={settings.whichNotesToOpenAfterImport}
          disabled={!settings.openNoteAfterImport}
          onChange={(e) => updateSetting('whichNotesToOpenAfterImport', (e.target as HTMLSelectElement).value)}
        >
          <option value="first-imported-note">{t('settings.whichNotes.first')}</option>
          <option value="last-imported-note">{t('settings.whichNotes.last')}</option>
          <option value="all-imported-notes">{t('settings.whichNotes.all')}</option>
        </select>
      </SettingItem>

      <SettingItem name={t('settings.concat')} description={t('settings.concat.desc')}>
        <div
          onClick={() => setConcat((s) => { updateSetting('shouldConcat', !s); return !s; })}
          className={`checkbox-container${concat ? ' is-enabled' : ''}`}
        />
      </SettingItem>

      {/* 导入格式 */}
      <SettingItem name={t('settings.importFormats')} isHeading />
      <SettingItem>
        <button onClick={addExport} className="mod-cta">{t('settings.addImportFormat')}</button>
      </SettingItem>
      {exportFormatState.map((f, i) => (
        <ExportFormatSettings key={exportFormatState.length - i} format={f} index={i} updateFormat={updateExport} removeFormat={removeExport} />
      ))}
    </div>
  );
}

// ── Tab 3：引注格式（v6.0 极简版：仅 CSL 样式）React 组件 ──

interface CitationTabProps {
  settings: ZoteroConnectorSettings;
  updateSetting: (key: keyof ZoteroConnectorSettings, value: any) => void;
}

function CitationTab({
  settings,
  updateSetting,
}: CitationTabProps) {
  return (
    <div>
      {/* v6.0 引注渲染开关 */}
      <SettingItem
        name={t('settings.citation.renderingEnabled')}
        description={t('settings.citation.renderingEnabled.desc')}
      >
        <div
          onClick={() => updateSetting('citationRenderingEnabled', !settings.citationRenderingEnabled)}
          className={`checkbox-container${settings.citationRenderingEnabled !== false ? ' is-enabled' : ''}`}
        />
      </SettingItem>


      {/* v6.1 行内引注 CSL 样式 */}
      <SettingItem
        name={t('settings.citation.inlineCslStyle')}
        description={t('settings.citation.inlineCslStyle.desc')}
      >
        <input
          onChange={(e) => updateSetting('inlineCslStyle', (e.target as HTMLInputElement).value)}
          type="text"
          spellCheck={false}
          placeholder={t('settings.citation.inlineCslStyle.placeholder')}
          defaultValue={settings.inlineCslStyle || settings.cslStyle || ''}
        />
      </SettingItem>

      {/* v6.1 参考文献 CSL 样式 */}
      <SettingItem
        name={t('settings.citation.bibliographyCslStyle')}
        description={t('settings.citation.bibliographyCslStyle.desc')}
      >
        <input
          onChange={(e) => updateSetting('bibliographyCslStyle', (e.target as HTMLInputElement).value)}
          type="text"
          spellCheck={false}
          placeholder={t('settings.citation.bibliographyCslStyle.placeholder')}
          defaultValue={settings.bibliographyCslStyle || settings.cslStyle || ''}
        />
      </SettingItem>
    </div>
  );
}

// ── PluginSettingTab 类 ──

export class ZoteroConnectorSettingsTab extends PluginSettingTab {
  plugin: ZoteroConnector;
  dbTimer: number;
  activeTab: TabId = 'sync';
  private systemHeader: HTMLElement | null = null;
  private tabButtons: HTMLElement | null = null;
  private metadataContainer: HTMLElement | null = null;
  private notesContainer: HTMLElement | null = null;
  private citationContainer: HTMLElement | null = null;
  private syncContainer: HTMLElement | null = null;

  constructor(app: App, plugin: ZoteroConnector) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // ── 系统设置区（始终可见）──
    this.systemHeader = containerEl.createDiv();
    ReactDOM.render(
      <SystemHeader
        settings={this.plugin.settings}
        updateSetting={this.updateSetting}
      />,
      this.systemHeader
    );

    // ── Tab 导航栏 ──
    this.tabButtons = containerEl.createDiv('zt-tab-bar');
    Object.assign(this.tabButtons.style, {
      display: 'flex', gap: '4px', marginBottom: '16px',
      borderBottom: '2px solid var(--background-modifier-border)', paddingBottom: '0',
    });

    TAB_ITEMS.forEach((tab) => {
      const btn = this.tabButtons!.createEl('button', {
        text: t(tab.labelKey),
        cls: `zt-tab-btn${this.activeTab === tab.id ? ' zt-tab-active' : ''}`,
      });
      Object.assign(btn.style, {
        padding: '8px 16px', border: 'none', cursor: 'pointer',
        fontSize: '0.95em', borderRadius: '6px 6px 0 0', marginBottom: '-2px',
        background: this.activeTab === tab.id ? 'var(--interactive-accent)' : 'transparent',
        color: this.activeTab === tab.id ? 'var(--text-on-accent)' : 'var(--text-muted)',
        fontWeight: this.activeTab === tab.id ? 600 : 400,
        borderBottom: this.activeTab === tab.id ? '2px solid var(--interactive-accent)' : '2px solid transparent',
      });
      btn.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.display();
      });
    });

    // ── 内容容器 ──
    this.metadataContainer = containerEl.createDiv();
    this.notesContainer = containerEl.createDiv();
    this.citationContainer = containerEl.createDiv();
    this.syncContainer = containerEl.createDiv();

    // ── 渲染各 Tab ──
    this._renderMetadataTab(this.metadataContainer);
    this._renderNotesTab(this.notesContainer);
    this._renderCitationTab(this.citationContainer);
    this._renderSyncTab(this.syncContainer);

    // ── 显示/隐藏 ──
    this._showActiveTab();
  }

  private _showActiveTab() {
    if (this.metadataContainer)
      this.metadataContainer.style.display = this.activeTab === 'metadata' ? 'block' : 'none';
    if (this.notesContainer)
      this.notesContainer.style.display = this.activeTab === 'notes' ? 'block' : 'none';
    if (this.citationContainer)
      this.citationContainer.style.display = this.activeTab === 'citation' ? 'block' : 'none';
    if (this.syncContainer)
      this.syncContainer.style.display = this.activeTab === 'sync' ? 'block' : 'none';
  }


  // ── Tab 4：同步设置 ──

  private _renderSyncTab(container: HTMLElement) {
    container.empty();

    const wrapper = container.createDiv('zotero-trigger-key-container zt-floating-card');
    wrapper.id = 'zotero-trigger-key-container';

    // ── Section A: 悬浮球触发条件 ──
    this._renderTriggerConditionList(
      wrapper,
      'settings.sync.floatingTriggers',
      'settings.sync.floatingTriggers.desc',
      () => this.plugin.settings.floatingButtonTriggers || [{ key: '文献标题', value: '' }],
      (updated) => { this.plugin.settings.floatingButtonTriggers = updated; }
    );

    // ── Section B: 自动同步触发条件 ──
    this._renderTriggerConditionList(
      wrapper,
      'settings.sync.autoSyncTriggers',
      'settings.sync.autoSyncTriggers.desc',
      () => this.plugin.settings.autoSyncTriggers || [{ key: '文献标题', value: '' }],
      (updated) => { this.plugin.settings.autoSyncTriggers = updated; }
    );

    // ── 开卷自动同步开关 ──
    new Setting(wrapper)
      .setName(t('settings.sync.autoSyncOnOpen'))
      .setDesc(t('settings.sync.autoSyncOnOpen.desc'))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoSyncOnOpen || false)
          .onChange((value) => {
            this.plugin.settings.autoSyncOnOpen = value;
            this.debouncedSave();
          });
      });

    // ── 同步目标 ──
    new Setting(wrapper)
      .setName(t('settings.sync.targets'))
      .setDesc(t('settings.sync.targets.desc'))
      .setHeading();

    const syncTargets = this.plugin.settings.syncTargets || ['metadata'];

    const syncTargetOptions: { id: string; labelKey: string }[] = [
      { id: 'metadata', labelKey: 'settings.sync.targets.metadata' },
      { id: 'annotations', labelKey: 'settings.sync.targets.annotations' },
    ];

    for (const opt of syncTargetOptions) {
      new Setting(wrapper)
        .setName(t(opt.labelKey))
        .addToggle((toggle) => {
          toggle
            .setValue(syncTargets.includes(opt.id))
            .onChange((value) => {
              const current = this.plugin.settings.syncTargets || ['metadata'];
              if (value) {
                if (!current.includes(opt.id)) current.push(opt.id);
              } else {
                const idx = current.indexOf(opt.id);
                if (idx >= 0) current.splice(idx, 1);
              }
              this.plugin.settings.syncTargets = current;
              this.debouncedSave();
            });
        });
    }
  }

  /**
   * v5.4: 渲染一个触发条件列表（可增删行，每行 = key 输入 + value 输入 + 删除按钮）
   * @param getTriggers 获取最新列表的 getter（避免闭包捕获过时引用）
   * @param updateTriggers 更新列表的 setter
   */
  private _renderTriggerConditionList(
    wrapper: HTMLElement,
    headingKey: string,
    descKey: string,
    getTriggers: () => TriggerCondition[],
    updateTriggers: (updated: TriggerCondition[]) => void,
  ) {
    new Setting(wrapper)
      .setName(t(headingKey))
      .setDesc(t(descKey))
      .setHeading();

    // 添加按钮
    new Setting(wrapper).addButton((btn) =>
      btn
        .setButtonText(t('settings.sync.addTrigger'))
        .setCta()
        .onClick(() => {
          const updated = [...getTriggers(), { key: '', value: '' }];
          updateTriggers(updated);
          this.debouncedSave();
          this.display();
        })
    );

    // 每一行
    const triggers = getTriggers();
    triggers.forEach((cond, i) => {
      const updateRow = (patch: Partial<TriggerCondition>) => {
        const current = getTriggers();
        const updated = [...current];
        updated[i] = { ...updated[i], ...patch };
        updateTriggers(updated);
        this.debouncedSave();
      };

      new Setting(wrapper)
        .addText((text) => {
          text
            .setValue(cond.key)
            .setPlaceholder(t('settings.sync.triggerKey'))
            .onChange((value) => updateRow({ key: value }));
          text.inputEl.style.flex = '1';
        })
        .addText((text) => {
          text
            .setValue(cond.value)
            .setPlaceholder(t('settings.sync.triggerValue'))
            .onChange((value) => updateRow({ value: value }));
          text.inputEl.style.flex = '1';
        })
        .addExtraButton((btn) =>
          btn
            .setIcon('trash')
            .setTooltip(t('settings.sync.deleteTrigger'))
            .onClick(() => {
              const current = getTriggers();
              const updated = [...current];
              updated.splice(i, 1);
              updateTriggers(updated);
              this.debouncedSave();
              this.display();
            })
        );
    });
  }

  // ── Tab 1：元数据映射 ──

  private _renderMetadataTab(container: HTMLElement) {
    container.empty();

    // ── v5.1 悬浮球设置区（置顶，确保用户可见）──
    // (floating button settings moved to Sync tab)

    // ── v5.2 统一属性列表（Zotero 字段 + 自定义属性，混合拖拽排序）──
    this._renderPropertyItems(container);

    // IF Color Rules
    this._renderIfColorRules(container);

    // Title Marquee
    this._renderTitleMarquee(container);
  }

  // ── Tab 2：笔记模板 ──

  private _renderNotesTab(container: HTMLElement) {
    ReactDOM.render(
      <NotesTab
        settings={this.plugin.settings}
        addExportFormat={this.addExportFormat}
        updateExportFormat={this.updateExportFormat}
        removeExportFormat={this.removeExportFormat}
        updateSetting={this.updateSetting}
        saveBodyTemplate={(value) => {
          this.plugin.settings.bodyTemplate = value;
          this.debouncedSave();
        }}
      />,
      container
    );
  }

  // ── Tab 3：引注格式 ──

  private _renderCitationTab(container: HTMLElement) {
    ReactDOM.render(
      <CitationTab
        settings={this.plugin.settings}
        updateSetting={this.updateSetting}
      />,
      container
    );
  }

  // ── 通用方法 ──

  addExportFormat = (format: ExportFormat) => {
    this.plugin.addExportCommand(format);
    this.plugin.settings.exportFormats.unshift(format);
    this.debouncedSave();
    return this.plugin.settings.exportFormats.slice();
  };

  updateExportFormat = (index: number, format: ExportFormat) => {
    this.plugin.removeExportCommand(this.plugin.settings.exportFormats[index]);
    this.plugin.addExportCommand(format);
    this.plugin.settings.exportFormats[index] = format;
    this.debouncedSave();
    return this.plugin.settings.exportFormats.slice();
  };

  removeExportFormat = (index: number) => {
    this.plugin.removeExportCommand(this.plugin.settings.exportFormats[index]);
    this.plugin.settings.exportFormats.splice(index, 1);
    this.debouncedSave();
    return this.plugin.settings.exportFormats.slice();
  };

  updateSetting = <T extends keyof ZoteroConnectorSettings>(
    key: T,
    value: ZoteroConnectorSettings[T]
  ) => {
    this.plugin.settings[key] = value;
    this.debouncedSave();
  };

  // ── v5.0 自定义属性区 ──


  // ── IF Color Rules（保留原生 Setting API）──

  private _renderIfColorRules(container: HTMLElement) {
    const existing = container.querySelector('#zotero-if-rules-container');
    if (existing) existing.remove();

    const wrapper = container.createDiv('zotero-if-rules-container');
    wrapper.id = 'zotero-if-rules-container';

    new Setting(wrapper)
      .setName(t('settings.ifColorRules'))
      .setDesc(t('settings.ifColorRules.desc'))
      .setHeading();

    new Setting(wrapper).addButton((btn) =>
      btn
        .setButtonText(t('settings.ifColorRules.add'))
        .setCta()
        .onClick(() => {
          const rules = [...(this.plugin.settings.ifColorRules || [])];
          rules.push(createIfRule(rules.length));
          this.plugin.settings.ifColorRules = rules;
          this.debouncedSave();
          this._renderIfColorRules(container);
        })
    );

    const rules = this.plugin.settings.ifColorRules || [];
    if (!rules.length) return;

    rules.forEach((rule, i) => {
      const updateRule = (patch: Partial<IfColorRule>) => {
        const updated = [...(this.plugin.settings.ifColorRules || [])];
        updated[i] = { ...updated[i], ...patch };
        updated[i].className = `if-dynamic-${i}`;
        this.plugin.settings.ifColorRules = updated;
        this.debouncedSave();
      };

      const ruleSetting = new Setting(wrapper)
        .setName(
          createFragment((f) => {
            f.createSpan({ text: `Rule ${i + 1}`, cls: 'setting-item-name' });
            const preview = f.createSpan({
              text: ` IF ${rule.min}~${rule.max ?? '∞'} `,
              cls: 'zt-if-preview-pill',
            });
            preview.style.backgroundColor = rule.bgColor;
            preview.style.color = rule.textColor;
            preview.style.border = `1px solid ${rule.borderColor}`;
            preview.style.padding = '2px 8px';
            preview.style.borderRadius = '12px';
            preview.style.fontSize = '0.85em';
            preview.style.marginLeft = '8px';
          })
        )
        .addText((text) =>
          text
            .setValue(rule.min.toString())
            .setPlaceholder(t('settings.ifColorRules.min'))
            .onChange((value) => updateRule({ min: parseFloat(value) || 0 }))
        )
        .addText((text) =>
          text
            .setValue(rule.max?.toString() || '')
            .setPlaceholder(t('settings.ifColorRules.max'))
            .onChange((value) => updateRule({ max: value ? parseFloat(value) : null }))
        )
        .addColorPicker((picker) =>
          picker.setValue(rule.bgColor).onChange((value) => {
            updateRule({ bgColor: value });
            this._renderIfColorRules(container);
          })
        )
        .addColorPicker((picker) =>
          picker.setValue(rule.textColor).onChange((value) => {
            updateRule({ textColor: value });
            this._renderIfColorRules(container);
          })
        )
        .addColorPicker((picker) =>
          picker.setValue(rule.borderColor).onChange((value) => {
            updateRule({ borderColor: value });
            this._renderIfColorRules(container);
          })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon('trash')
            .setTooltip(t('settings.ifColorRules.delete'))
            .onClick(() => {
              const updated = [...(this.plugin.settings.ifColorRules || [])];
              updated.splice(i, 1);
              updated.forEach((r, idx) => (r.className = `if-dynamic-${idx}`));
              this.plugin.settings.ifColorRules = updated;
              this.debouncedSave();
              this._renderIfColorRules(container);
            })
        );

      const inputs = ruleSetting.controlEl.querySelectorAll(
        'input[type="text"], input[type="number"]'
      );
      inputs.forEach((inp: HTMLInputElement) => { inp.style.width = '80px'; });
    });
  }

  // ── Title Marquee ──

  private _renderTitleMarquee(container: HTMLElement) {
    const existing = container.querySelector('#zotero-title-marquee-container');
    if (existing) existing.remove();

    const wrapper = container.createDiv('zotero-title-marquee-container');
    wrapper.id = 'zotero-title-marquee-container';

    new Setting(wrapper)
      .setName(t('settings.titleMarquee'))
      .setDesc(t('settings.titleMarquee.desc'))
      .setHeading();

    new Setting(wrapper)
      .setName(t('settings.titleMarquee.enable'))
      .setDesc(t('settings.titleMarquee.enable.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.titleMarqueeEnabled || false)
          .onChange((value) => {
            this.plugin.settings.titleMarqueeEnabled = value;
            this.debouncedSave();
            injectTitleMarqueeStyles(value, this.plugin.settings.titleMarqueeDuration || 15);
          })
      );

    new Setting(wrapper)
      .setName(t('settings.titleMarquee.duration'))
      .setDesc(t('settings.titleMarquee.duration.desc'))
      .addSlider((slider) =>
        slider
          .setLimits(3, 60, 1)
          .setValue(this.plugin.settings.titleMarqueeDuration || 15)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.titleMarqueeDuration = value;
            this.debouncedSave();
            if (this.plugin.settings.titleMarqueeEnabled) {
              injectTitleMarqueeStyles(true, value);
            }
          })
      );
  }

  // ── v5.2 统一属性列表（Zotero 字段 + 自定义属性，混合拖拽排序）──

  private _renderPropertyItems(container: HTMLElement) {
    const existing = container.querySelector('#zotero-property-items-container');
    if (existing) existing.remove();

    const wrapper = container.createDiv('zotero-property-items-container zt-setting-card-group');
    wrapper.id = 'zotero-property-items-container';

    new Setting(wrapper)
      .setName(t('settings.metadata.propertyItems'))
      .setDesc(t('settings.metadata.propertyItems.desc'))
      .setHeading();

    // 添加按钮 — 默认新增一个 Zotero 字段行
    new Setting(wrapper).addButton((btn) =>
      btn
        .setButtonText(t('settings.metadata.propertyItems.add'))
        .setCta()
        .onClick(() => {
          const items = [...(this.plugin.settings.propertyItems || [])];
          items.push({ kind: 'zotero', zoteroField: '', obsidianKey: '' });
          this.plugin.settings.propertyItems = items;
          this.debouncedSave();
          this._renderPropertyItems(container);
        })
    );

    const items = this.plugin.settings.propertyItems || [];
    if (!items.length) {
      const emptyHint = wrapper.createDiv();
      emptyHint.style.cssText =
        'color: var(--text-muted); font-size: 0.85em; padding: 8px 0;';
      emptyHint.setText(t('settings.metadata.propertyItems.empty'));
      return;
    }

    const customTypeLabels: Record<string, string> = {
      text: '文本 (text)',
      list: '列表 (list)',
      number: '数字 (number)',
      checkbox: '复选框 (checkbox)',
      date: '日期 (date)',
    };

    // 构建已使用的 Zotero 字段集合（仅用于 zotero 类型的下拉去重）
    const usedZoteroFields = new Set(
      items.filter((it) => it.kind === 'zotero').map((it) => it.zoteroField)
    );

    items.forEach((item, i) => {
      const updateItem = (patch: Partial<PropertyItem>) => {
        const updated = [...(this.plugin.settings.propertyItems || [])];
        updated[i] = { ...updated[i], ...patch } as PropertyItem;
        this.plugin.settings.propertyItems = updated;
        this.debouncedSave();
      };

      const settingItem = new Setting(wrapper);

      // ── 类型选择器（最左侧）──
      settingItem.addDropdown((dropdown) => {
        dropdown.addOption('zotero', t('settings.metadata.propertyItems.kindZotero'));
        dropdown.addOption('custom', t('settings.metadata.propertyItems.kindCustom'));
        dropdown.setValue(item.kind).onChange((value) => {
          const kind = value as PropertyItem['kind'];
          if (kind === 'zotero') {
            updateItem({ kind, customType: undefined, customValue: undefined });
          } else {
            updateItem({ kind, zoteroField: undefined, customType: 'text' });
          }
          this._renderPropertyItems(container);
        });
        dropdown.selectEl.style.width = '110px';
        dropdown.selectEl.style.flexShrink = '0';
      });

      // ── Zotero 字段类型 → Zotero 字段下拉 + Obsidian 属性名 ──
      if (item.kind === 'zotero') {
        // 计算当前行可用的字段选项（排除其他行已选的，保留当前行的值）
        const availableOptions = SMART_FIELD_OPTIONS.filter(
          (opt) => !usedZoteroFields.has(opt.value) || opt.value === item.zoteroField
        );

        settingItem.addDropdown((dropdown) => {
          availableOptions.forEach((opt) => dropdown.addOption(opt.value, opt.label));
          dropdown.setValue(item.zoteroField || 'title_smart').onChange((value) => {
            updateItem({ zoteroField: value });
            this._renderPropertyItems(container);
          });
          dropdown.selectEl.style.width = '150px';
          dropdown.selectEl.style.flexShrink = '0';
        });

        settingItem.addText((text) => {
          text
            .setValue(item.obsidianKey)
            .setPlaceholder(t('settings.template.obsidianKey'))
            .onChange((value) => updateItem({ obsidianKey: value }));
          text.inputEl.style.flex = '1';
          text.inputEl.style.minWidth = '0';
        });
      }

      // ── 自定义属性类型 → Obsidian 属性名 + 类型下拉 + 默认值 ──
      if (item.kind === 'custom') {
        settingItem.addText((text) => {
          text
            .setValue(item.obsidianKey)
            .setPlaceholder(t('settings.metadata.customProperties.key'))
            .onChange((value) => updateItem({ obsidianKey: value }));
          text.inputEl.style.width = '120px';
          text.inputEl.style.flexShrink = '0';
        });

        settingItem.addDropdown((dropdown) => {
          Object.keys(customTypeLabels).forEach((t) =>
            dropdown.addOption(t, customTypeLabels[t])
          );
          dropdown.setValue(item.customType || 'text').onChange((value) =>
            updateItem({ customType: value as PropertyItem['customType'] })
          );
          dropdown.selectEl.style.width = '140px';
        });

        settingItem.addText((text) => {
          text
            .setValue(item.customValue || '')
            .setPlaceholder(t('settings.metadata.customProperties.value'))
            .onChange((value) => updateItem({ customValue: value }));
          text.inputEl.style.width = '100px';
          text.inputEl.style.flexShrink = '0';
        });
      }

      // ── 拖拽手柄（统一在最右侧按钮前）──
      settingItem.addExtraButton((btn) => {
        btn.setIcon('grip-vertical').setTooltip('拖拽排序');
        const handle = btn.extraSettingsEl;
        handle.addClass('zt-drag-handle');
        handle.style.cursor = 'grab';
        handle.draggable = true;

        handle.addEventListener('dragstart', (e: DragEvent) => {
          e.dataTransfer!.effectAllowed = 'move';
          e.dataTransfer!.setData('text/plain', i.toString());
          settingItem.settingEl.addClass('is-dragging');
          handle.style.cursor = 'grabbing';
        });

        handle.addEventListener('dragend', () => {
          settingItem.settingEl.removeClass('is-dragging');
          handle.style.cursor = 'grab';
        });
      });

      // ── 拖放事件 ──
      settingItem.settingEl.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        settingItem.settingEl.addClass('zt-drag-over');
      });

      settingItem.settingEl.addEventListener('dragleave', () => {
        settingItem.settingEl.removeClass('zt-drag-over');
      });

      settingItem.settingEl.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        settingItem.settingEl.removeClass('zt-drag-over');

        const fromIndex = parseInt(e.dataTransfer!.getData('text/plain'));
        const toIndex = i;

        if (fromIndex !== toIndex) {
          const items = [...(this.plugin.settings.propertyItems || [])];
          const [moved] = items.splice(fromIndex, 1);
          items.splice(toIndex, 0, moved);
          this.plugin.settings.propertyItems = items;
          this.debouncedSave();
          this._renderPropertyItems(container);
        }
      });

      // ── 删除按钮（最右侧）──
      settingItem.addExtraButton((btn) =>
        btn
          .setIcon('trash')
          .setTooltip(t('settings.template.deleteMapping'))
          .onClick(() => {
            const updated = [...(this.plugin.settings.propertyItems || [])];
            updated.splice(i, 1);
            this.plugin.settings.propertyItems = updated;
            this.debouncedSave();
            this._renderPropertyItems(container);
          })
      );
    });
  }

  // ── save ──

  debouncedSave() {
    clearTimeout(this.dbTimer);
    this.dbTimer = activeWindow.setTimeout(() => {
      this.plugin.saveSettings();
    }, 150);
  }

  hide() {
    super.hide();
    ReactDOM.unmountComponentAtNode(this.containerEl);
  }
}
