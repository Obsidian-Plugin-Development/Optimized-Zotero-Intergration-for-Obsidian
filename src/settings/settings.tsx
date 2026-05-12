import { App, Notice, PluginSettingTab, debounce } from 'obsidian';
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
  CitationFormat,
  ExportFormat,
  ZoteroConnectorSettings,
} from '../types';
import { AssetDownloader } from './AssetDownloader';
import { CiteFormatSettings } from './CiteFormatSettings';
import { ExportFormatSettings } from './ExportFormatSettings';
import { Icon } from './Icon';
import { SettingItem } from './SettingItem';

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
  const [citeFormatState, setCiteFormatState] = React.useState(
    settings.citeFormats
  );
  const [exportFormatState, setExportFormatState] = React.useState(
    settings.exportFormats
  );

  const [openNoteAfterImportState, setOpenNoteAfterImport] = React.useState(
    !!settings.openNoteAfterImport
  );

  const [ocrState, setOCRState] = React.useState(settings.pdfExportImageOCR);

  const [concat, setConcat] = React.useState(!!settings.shouldConcat);

  const [locale, setLocaleState] = React.useState(getLocale());

  const updateCite = React.useCallback(
    debounce(
      (index: number, format: CitationFormat) => {
        setCiteFormatState(updateCiteFormat(index, format));
      },
      200,
      true
    ),
    [updateCiteFormat]
  );

  const addCite = React.useCallback(() => {
    setCiteFormatState(
      addCiteFormat({
        name: `Format #${citeFormatState.length + 1}`,
        format: 'formatted-citation',
      })
    );
  }, [addCiteFormat, citeFormatState]);

  const removeCite = React.useCallback(
    (index: number) => {
      setCiteFormatState(removeCiteFormat(index));
    },
    [removeCiteFormat]
  );

  const updateExport = React.useCallback(
    debounce(
      (index: number, format: ExportFormat) => {
        setExportFormatState(updateExportFormat(index, format));
      },
      200,
      true
    ),
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

  const removeExport = React.useCallback(
    (index: number) => {
      setExportFormatState(removeExportFormat(index));
    },
    [removeExportFormat]
  );

  const tessPathRef = React.useRef<HTMLInputElement>(null);
  const tessDataPathRef = React.useRef<HTMLInputElement>(null);

  const [useCustomPort, setUseCustomPort] = React.useState(
    settings.database === 'Custom'
  );

  return (
    <div>
      <SettingItem name={t('settings.general')} isHeading />

      {/* 语言切换 */}
      <SettingItem
        name={t('settings.locale')}
        description={t('settings.locale.desc')}
      >
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
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </SettingItem>

      <AssetDownloader settings={settings} updateSetting={updateSetting} />
      <SettingItem
        name={t('settings.database')}
        description={t('settings.database.desc')}
      >
        <select
          className="dropdown"
          defaultValue={settings.database}
          onChange={(e) => {
            const value = (e.target as HTMLSelectElement).value;
            updateSetting('database', value);
            if (value === 'Custom') {
              setUseCustomPort(true);
            } else {
              setUseCustomPort(false);
            }
          }}
        >
          <option value="Zotero">Zotero</option>
          <option value="Juris-M">Juris-M</option>
          <option value="Custom">Custom</option>
        </select>
      </SettingItem>
      {useCustomPort ? (
        <SettingItem
          name={t('settings.port')}
          description={t('settings.port.desc')}
        >
          <input
            onChange={(e) =>
              updateSetting('port', (e.target as HTMLInputElement).value)
            }
            type="number"
            placeholder={t('settings.port.placeholder')}
            defaultValue={settings.port}
          />
        </SettingItem>
      ) : null}
      <SettingItem
        name={t('settings.noteImportFolder')}
        description={t('settings.noteImportFolder.desc')}
      >
        <input
          onChange={(e) =>
            updateSetting(
              'noteImportFolder',
              (e.target as HTMLInputElement).value
            )
          }
          type="text"
          spellCheck={false}
          placeholder={t('settings.noteImportFolder.placeholder')}
          defaultValue={settings.noteImportFolder}
        />
      </SettingItem>
      <SettingItem
        name={t('settings.openAfterImport')}
        description={t('settings.openAfterImport.desc')}
      >
        <div
          onClick={() => {
            setOpenNoteAfterImport((state) => {
              updateSetting('openNoteAfterImport', !state);
              return !state;
            });
          }}
          className={`checkbox-container${
            openNoteAfterImportState ? ' is-enabled' : ''
          }`}
        />
      </SettingItem>
      <SettingItem
        name={t('settings.whichNotesToOpen')}
        description={t('settings.whichNotesToOpen.desc')}
      >
        <select
          className="dropdown"
          defaultValue={settings.whichNotesToOpenAfterImport}
          disabled={!settings.openNoteAfterImport}
          onChange={(e) =>
            updateSetting(
              'whichNotesToOpenAfterImport',
              (e.target as HTMLSelectElement).value
            )
          }
        >
          <option value="first-imported-note">{t('settings.whichNotes.first')}</option>
          <option value="last-imported-note">{t('settings.whichNotes.last')}</option>
          <option value="all-imported-notes">{t('settings.whichNotes.all')}</option>
        </select>
      </SettingItem>
      <SettingItem
        name={t('settings.concat')}
        description={t('settings.concat.desc')}
      >
        <div
          onClick={() => {
            setConcat((state) => {
              updateSetting('shouldConcat', !state);
              return !state;
            });
          }}
          className={`checkbox-container${concat ? ' is-enabled' : ''}`}
        />
      </SettingItem>
      <SettingItem name={t('settings.citeFormats')} isHeading />
      <SettingItem>
        <button onClick={addCite} className="mod-cta">
          {t('settings.addCiteFormat')}
        </button>
      </SettingItem>
      {citeFormatState.map((f, i) => {
        return (
          <CiteFormatSettings
            key={i}
            format={f}
            index={i}
            updateFormat={updateCite}
            removeFormat={removeCite}
          />
        );
      })}

      <SettingItem name={t('settings.importFormats')} isHeading />
      <SettingItem>
        <button onClick={addExport} className="mod-cta">
          {t('settings.addImportFormat')}
        </button>
      </SettingItem>
      {exportFormatState.map((f, i) => {
        return (
          <ExportFormatSettings
            key={exportFormatState.length - i}
            format={f}
            index={i}
            updateFormat={updateExport}
            removeFormat={removeExport}
          />
        );
      })}

      <SettingItem
        name={t('settings.imageSettings')}
        description={t('settings.imageSettings.desc')}
        isHeading
      />
      <SettingItem name={t('settings.imageFormat')}>
        <select
          className="dropdown"
          defaultValue={settings.pdfExportImageFormat}
          onChange={(e) =>
            updateSetting(
              'pdfExportImageFormat',
              (e.target as HTMLSelectElement).value
            )
          }
        >
          <option value="jpg">jpg</option>
          <option value="png">png</option>
        </select>
      </SettingItem>
      <SettingItem name={t('settings.imageQuality')}>
        <input
          min="0"
          max="100"
          onChange={(e) =>
            updateSetting(
              'pdfExportImageQuality',
              Number((e.target as HTMLInputElement).value)
            )
          }
          type="number"
          defaultValue={settings.pdfExportImageQuality.toString()}
        />
      </SettingItem>
      <SettingItem name={t('settings.imageDPI')}>
        <input
          min="0"
          onChange={(e) =>
            updateSetting(
              'pdfExportImageDPI',
              Number((e.target as HTMLInputElement).value)
            )
          }
          type="number"
          defaultValue={settings.pdfExportImageDPI.toString()}
        />
      </SettingItem>
      <SettingItem
        name={t('settings.imageOCR')}
        description={
          <div>
            {t('settings.imageOCR.desc.line1')}{' '}
            <a
              href="https://tesseract-ocr.github.io/tessdoc/"
              target="_blank"
              rel="noreferrer"
            >
              tesseract
            </a>{' '}
            {t('settings.imageOCR.desc.line2')}{' '}
            <a href="https://brew.sh/" target="_blank" rel="noreferrer">
              {t('settings.imageOCR.desc.line3')}
            </a>
            {t('settings.imageOCR.desc.line4')}{' '}
            <a
              href="https://github.com/UB-Mannheim/tesseract/wiki"
              target="_blank"
              rel="noreferrer"
            >
              {t('settings.imageOCR.desc.line5')}
            </a>
            .
          </div>
        }
      >
        <div
          onClick={() =>
            setOCRState((s) => {
              updateSetting('pdfExportImageOCR', !s);
              return !s;
            })
          }
          className={`checkbox-container${ocrState ? ' is-enabled' : ''}`}
        />
      </SettingItem>
      <SettingItem
        name={t('settings.imageOCR.tesseractPath')}
        description={
          <div>
            {t('settings.imageOCR.tesseractPath.desc1')}{' '}
            <pre>which tesseract</pre>
          </div>
        }
      >
        <input
          ref={tessPathRef}
          onChange={(e) =>
            updateSetting(
              'pdfExportImageTesseractPath',
              (e.target as HTMLInputElement).value
            )
          }
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
            <a
              href="https://github.com/tesseract-ocr/tessdata"
              target="_blank"
              rel="noreferrer"
            >
              {t('settings.imageOCR.lang.desc3')}
            </a>
            . ({' '}
            <a
              href="https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html"
              target="_blank"
              rel="noreferrer"
            >
              {t('settings.imageOCR.lang.desc4')}
            </a>
            )
          </div>
        }
      >
        <input
          onChange={(e) =>
            updateSetting(
              'pdfExportImageOCRLang',
              (e.target as HTMLInputElement).value
            )
          }
          type="text"
          defaultValue={settings.pdfExportImageOCRLang}
        />
      </SettingItem>
      <SettingItem
        name={t('settings.imageOCR.tessDataDir')}
        description={t('settings.imageOCR.tessDataDir.desc')}
      >
        <input
          ref={tessDataPathRef}
          onChange={(e) =>
            updateSetting(
              'pdfExportImageTessDataDir',
              (e.target as HTMLInputElement).value
            )
          }
          type="text"
          defaultValue={settings.pdfExportImageTessDataDir}
        />
        <div
          className="clickable-icon setting-editor-extra-setting-button"
          aria-label={t('settings.pdfUtility.selectTessDataDir')}
          onClick={() => {
            const path = require('electron').remote.dialog.showOpenDialogSync({
              properties: ['openDirectory'],
            });

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

export class ZoteroConnectorSettingsTab extends PluginSettingTab {
  plugin: ZoteroConnector;
  dbTimer: number;

  constructor(app: App, plugin: ZoteroConnector) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
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
      this.containerEl
    );
  }

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
