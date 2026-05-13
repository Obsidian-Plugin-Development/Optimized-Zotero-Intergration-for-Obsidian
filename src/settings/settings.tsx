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
import {
  CitationFormat,
  ExportFormat,
  IfColorRule,
  PropertyMapping,
  ZoteroConnectorSettings,
} from '../types';
import { AssetDownloader } from './AssetDownloader';
import { CiteFormatSettings } from './CiteFormatSettings';
import { ExportFormatSettings } from './ExportFormatSettings';
import { Icon } from './Icon';
import { SettingItem } from './SettingItem';

// ── Types ──

type TabId = 'general' | 'beautify' | 'template';

const TAB_ITEMS: { id: TabId; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.tab.general' },
  { id: 'beautify', labelKey: 'settings.tab.beautify' },
  { id: 'template', labelKey: 'settings.tab.template' },
];

// ── General Tab 的 React 组件（保持不变）──

interface SettingsComponentProps {
  settings: ZoteroConnectorSettings;
  addCiteFormat: (format: CitationFormat) => CitationFormat[];
  updateCiteFormat: (index: number, format: CitationFormat) => CitationFormat[];
  removeCiteFormat: (index: number) => CitationFormat[];
  addExportFormat: (format: ExportFormat) => ExportFormat[];
  updateExportFormat: (index: number, format: ExportFormat) => ExportFormat[];
  removeExportFormat: (index: number) => ExportFormat[];
  updateSetting: (key: keyof ZoteroConnectorSettings, value: any) => void;
}

function SettingsComponent({
  settings,
  addCiteFormat,
  updateCiteFormat,
  removeCiteFormat,
  addExportFormat,
  updateExportFormat,
  removeExportFormat,
  updateSetting,
}: SettingsComponentProps) {
  const [citeFormatState, setCiteFormatState] = React.useState(settings.citeFormats);
  const [exportFormatState, setExportFormatState] = React.useState(settings.exportFormats);
  const [openNoteAfterImportState, setOpenNoteAfterImport] = React.useState(!!settings.openNoteAfterImport);
  const [ocrState, setOCRState] = React.useState(settings.pdfExportImageOCR);
  const [concat, setConcat] = React.useState(!!settings.shouldConcat);
  const [locale, setLocaleState] = React.useState(getLocale());

  const updateCite = React.useCallback(
    debounce((index: number, format: CitationFormat) => {
      setCiteFormatState(updateCiteFormat(index, format));
    }, 200, true),
    [updateCiteFormat]
  );

  const addCite = React.useCallback(() => {
    setCiteFormatState(
      addCiteFormat({ name: `Format #${citeFormatState.length + 1}`, format: 'formatted-citation' })
    );
  }, [addCiteFormat, citeFormatState]);

  const removeCite = React.useCallback((index: number) => {
    setCiteFormatState(removeCiteFormat(index));
  }, [removeCiteFormat]);

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
  }, [addExportFormat, citeFormatState]);

  const removeExport = React.useCallback((index: number) => {
    setExportFormatState(removeExportFormat(index));
  }, [removeExportFormat]);

  const tessPathRef = React.useRef<HTMLInputElement>(null);
  const tessDataPathRef = React.useRef<HTMLInputElement>(null);

  const [useCustomPort, setUseCustomPort] = React.useState(settings.database === 'Custom');

  return (
    <div>
      <SettingItem name={t('settings.general')} isHeading />

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

      <AssetDownloader settings={settings} updateSetting={updateSetting} />

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

      <SettingItem name={t('settings.noteImportFolder')} description={t('settings.noteImportFolder.desc')}>
        <input
          onChange={(e) => updateSetting('noteImportFolder', (e.target as HTMLInputElement).value)}
          type="text"
          spellCheck={false}
          placeholder={t('settings.noteImportFolder.placeholder')}
          defaultValue={settings.noteImportFolder}
        />
      </SettingItem>

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

      <SettingItem name={t('settings.citeFormats')} isHeading />
      <SettingItem>
        <button onClick={addCite} className="mod-cta">{t('settings.addCiteFormat')}</button>
      </SettingItem>
      {citeFormatState.map((f, i) => (
        <CiteFormatSettings key={i} format={f} index={i} updateFormat={updateCite} removeFormat={removeCite} />
      ))}

      <SettingItem name={t('settings.importFormats')} isHeading />
      <SettingItem>
        <button onClick={addExport} className="mod-cta">{t('settings.addImportFormat')}</button>
      </SettingItem>
      {exportFormatState.map((f, i) => (
        <ExportFormatSettings key={exportFormatState.length - i} format={f} index={i} updateFormat={updateExport} removeFormat={removeExport} />
      ))}

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
  );
}

// ── PluginSettingTab 类 ──

export class ZoteroConnectorSettingsTab extends PluginSettingTab {
  plugin: ZoteroConnector;
  dbTimer: number;
  activeTab: TabId = 'general';
  private tabButtons: HTMLElement | null = null;
  private generalContainer: HTMLElement | null = null;
  private beautifyContainer: HTMLElement | null = null;
  private templateContainer: HTMLElement | null = null;

  constructor(app: App, plugin: ZoteroConnector) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

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
    this.generalContainer = containerEl.createDiv();
    this.beautifyContainer = containerEl.createDiv();
    this.templateContainer = containerEl.createDiv();

    // ── 渲染各 Tab ──
    this._renderGeneralTab(this.generalContainer);
    this._renderBeautifyTab(this.beautifyContainer);
    this._renderTemplateTab(this.templateContainer);

    // ── 显示/隐藏 ──
    this._showActiveTab();
  }

  private _showActiveTab() {
    if (this.generalContainer)
      this.generalContainer.style.display = this.activeTab === 'general' ? 'block' : 'none';
    if (this.beautifyContainer)
      this.beautifyContainer.style.display = this.activeTab === 'beautify' ? 'block' : 'none';
    if (this.templateContainer)
      this.templateContainer.style.display = this.activeTab === 'template' ? 'block' : 'none';
  }

  // ── General Tab ──

  private _renderGeneralTab(container: HTMLElement) {
    ReactDOM.render(
      <SettingsComponent
        settings={this.plugin.settings}
        addCiteFormat={this.addCiteFormat}
        updateCiteFormat={this.updateCiteFormat}
        removeCiteFormat={this.removeCiteFormat}
        addExportFormat={this.addExportFormat}
        updateExportFormat={this.updateExportFormat}
        removeExportFormat={this.removeExportFormat}
        updateSetting={this.updateSetting}
      />,
      container
    );
  }

  // ── 通用方法 ──

  addCiteFormat = (format: CitationFormat) => {
    this.plugin.addFormatCommand(format);
    this.plugin.settings.citeFormats.unshift(format);
    this.debouncedSave();
    return this.plugin.settings.citeFormats.slice();
  };

  updateCiteFormat = (index: number, format: CitationFormat) => {
    this.plugin.removeFormatCommand(this.plugin.settings.citeFormats[index]);
    this.plugin.addFormatCommand(format);
    this.plugin.settings.citeFormats[index] = format;
    this.debouncedSave();
    return this.plugin.settings.citeFormats.slice();
  };

  removeCiteFormat = (index: number) => {
    this.plugin.removeFormatCommand(this.plugin.settings.citeFormats[index]);
    this.plugin.settings.citeFormats.splice(index, 1);
    this.debouncedSave();
    return this.plugin.settings.citeFormats.slice();
  };

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

  // ── Beautify Tab ──

  private _renderBeautifyTab(container: HTMLElement) {
    container.empty();
    this._renderIfColorRules(container);
    this._renderTitleMarquee(container);
  }

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

  // ── Template Tab ──

  private _renderTemplateTab(container: HTMLElement) {
    container.empty();
    this._renderPropertyMappings(container);
    this._renderBodyTemplate(container);
  }

  private _renderPropertyMappings(container: HTMLElement) {
    const existing = container.querySelector('#zotero-property-mappings-container');
    if (existing) existing.remove();

    const wrapper = container.createDiv('zotero-property-mappings-container zt-setting-card-group');
    wrapper.id = 'zotero-property-mappings-container';

    new Setting(wrapper)
      .setName(t('settings.template.mappings'))
      .setDesc(t('settings.template.mappings.desc'))
      .setHeading();

    new Setting(wrapper).addButton((btn) =>
      btn
        .setButtonText(t('settings.template.addMapping'))
        .setCta()
        .onClick(() => {
          const mappings = [...(this.plugin.settings.propertyMappings || [])];
          const used = new Set(mappings.map((m) => m.zoteroField));
          const next = SMART_FIELD_OPTIONS.find((opt) => !used.has(opt.value));
          mappings.push({
            zoteroField: next?.value || 'title_smart',
            obsidianKey: '',
          });
          this.plugin.settings.propertyMappings = mappings;
          this.debouncedSave();
          this._renderPropertyMappings(container);
        })
    );

    const mappings = this.plugin.settings.propertyMappings || [];
    if (!mappings.length) return;

    mappings.forEach((mapping, i) => {
      const usedFields = new Set(
        mappings.filter((_, j) => j !== i).map((m) => m.zoteroField)
      );
      const availableOptions = SMART_FIELD_OPTIONS.filter(
        (opt) => !usedFields.has(opt.value) || opt.value === mapping.zoteroField
      );

      const updateMapping = (patch: Partial<PropertyMapping>) => {
        const updated = [...(this.plugin.settings.propertyMappings || [])];
        updated[i] = { ...updated[i], ...patch };
        this.plugin.settings.propertyMappings = updated;
        this.debouncedSave();
      };

      new Setting(wrapper)
        .addDropdown((dropdown) => {
          availableOptions.forEach((opt) => dropdown.addOption(opt.value, opt.label));
          dropdown.setValue(mapping.zoteroField).onChange((value) => {
            updateMapping({ zoteroField: value });
            this._renderPropertyMappings(container);
          });
          dropdown.selectEl.style.maxWidth = '200px';
        })
        .addText((text) => {
          text
            .setValue(mapping.obsidianKey)
            .setPlaceholder(t('settings.template.obsidianKey'))
            .onChange((value) => updateMapping({ obsidianKey: value }));
          text.inputEl.style.flexGrow = '1';
        })
        .addExtraButton((btn) =>
          btn
            .setIcon('trash')
            .setTooltip(t('settings.template.deleteMapping'))
            .onClick(() => {
              const scrollContainer = this.containerEl;
              const scrollTop = scrollContainer.scrollTop;

              const updated = [...(this.plugin.settings.propertyMappings || [])];
              updated.splice(i, 1);
              this.plugin.settings.propertyMappings = updated;
              this.debouncedSave();
              this._renderPropertyMappings(container);

              scrollContainer.scrollTop = scrollTop;
            })
        );
    });
  }

  private _renderBodyTemplate(container: HTMLElement) {
    const existing = container.querySelector('#zotero-body-template-container');
    if (existing) existing.remove();

    const wrapper = container.createDiv('zotero-body-template-container');
    wrapper.id = 'zotero-body-template-container';

    new Setting(wrapper)
      .setName(t('settings.template.bodyTemplate'))
      .setDesc(t('settings.template.bodyTemplate.desc'))
      .setHeading();

    const textarea = wrapper.createEl('textarea', {
      attr: { placeholder: '## Abstract\n\n{{abstract}}\n\n## Notes\n\n{{markdownNotes}}' },
      cls: 'zt-body-template-textarea',
    });
    Object.assign(textarea.style, {
      width: '100%', minHeight: '200px',
      fontFamily: 'var(--font-monospace)', fontSize: '0.85em',
    });
    textarea.value = this.plugin.settings.bodyTemplate || '';

    const saveBodyTemplate = debounce((value: string) => {
      this.plugin.settings.bodyTemplate = value;
      this.debouncedSave();
    }, 300, true);

    textarea.addEventListener('input', () => saveBodyTemplate(textarea.value));
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
