import React from 'react';
import { SingleValue } from 'react-select';
import AsyncSelect from 'react-select/async';

import { t } from '../locale/i18n';
import { ExportFormat } from '../types';
import { Icon } from './Icon';
import { cslListRaw } from './cslList';
import {
  NoFileOptionMessage,
  NoOptionMessage,
  buildFileSearch,
  buildLoadFileOptions,
  customSelectStyles,
  loadCSLOptions,
} from './select.helpers';

interface FormatSettingsProps {
  format: ExportFormat;
  index: number;
  removeFormat: (index: number) => void;
  updateFormat: (index: number, format: ExportFormat) => void;
}

export function ExportFormatSettings({
  format,
  index,
  updateFormat,
  removeFormat,
}: FormatSettingsProps) {
  const loadFileOptions = React.useMemo(() => {
    const fileSearch = buildFileSearch();
    return buildLoadFileOptions(fileSearch);
  }, []);

  const defaultTemplate = React.useMemo(() => {
    if (!format.templatePath) return undefined;

    const file = app.vault
      .getMarkdownFiles()
      .find((item) => item.path === format.templatePath);
    return file ? { value: file.path, label: file.path } : undefined;
  }, [format.templatePath]);

  const defaultStyle = React.useMemo(() => {
    if (!format.cslStyle) return undefined;

    const match = cslListRaw.find((item) => item.value === format.cslStyle);

    if (match) return match;

    return { label: format.cslStyle, value: format.cslStyle };
  }, [format.cslStyle]);

  const onChangeStr = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const key = (e.target as HTMLInputElement).dataset
        .key as keyof ExportFormat;
      updateFormat(index, {
        ...format,
        [key]: (e.target as HTMLInputElement).value,
      });
    },
    [updateFormat, index, format]
  );

  const onChangeCSLStyle = React.useCallback(
    (e: SingleValue<{ value: string; label: string }>) => {
      updateFormat(index, {
        ...format,
        cslStyle: e?.value,
      });
    },
    [updateFormat, index, format]
  );

  const onChangeTemplatePath = React.useCallback(
    (e: SingleValue<{ value: string; label: string }>) => {
      updateFormat(index, {
        ...format,
        templatePath: e?.value,
      });
    },
    [updateFormat, index, format]
  );

  const onRemove = React.useCallback(() => {
    removeFormat(index);
  }, [removeFormat, index]);

  return (
    <div className="zt-format">
      <div className="zt-format__form">
        <div className="zt-format__label">{t('export.name')}</div>
        <div className="zt-format__input-wrapper">
          <input
            onChange={onChangeStr}
            type="text"
            data-key="name"
            value={format.name}
          />
          <div className="zt-format__delete">
            <button className="zt-format__delete-btn" onClick={onRemove}>
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </div>

      <div className="zt-format__form">
        <div className="zt-format__label">{t('export.outputPath')}</div>
        <div className="zt-format__input-wrapper">
          <input
            onChange={onChangeStr}
            type="text"
            data-key="outputPathTemplate"
            value={format.outputPathTemplate}
          />
        </div>
        <div className="zt-format__input-note">
          {t('export.outputPath.note')}{' '}
          <pre>My Folder/{'{{citekey}}'}.md</pre>. {t('export.outputPath.note2')}
        </div>
      </div>

      <div className="zt-format__form">
        <div className="zt-format__label">{t('export.imageOutputPath')}</div>
        <div className="zt-format__input-wrapper">
          <input
            onChange={onChangeStr}
            type="text"
            data-key="imageOutputPathTemplate"
            value={format.imageOutputPathTemplate}
          />
        </div>
        <div className="zt-format__input-note">
          {t('export.imageOutputPath.note')}{' '}
          <pre>Assets/{'{{citekey}}'}/</pre>. {t('export.outputPath.note2')}
        </div>
      </div>

      <div className="zt-format__form">
        <div className="zt-format__label">{t('export.imageBaseName')}</div>
        <div className="zt-format__input-wrapper">
          <input
            onChange={onChangeStr}
            type="text"
            data-key="imageBaseNameTemplate"
            value={format.imageBaseNameTemplate}
          />
        </div>
        <div className="zt-format__input-note">
          {t('export.imageBaseName.note1')} <pre>image</pre> {t('export.imageBaseName.note2')}{' '}
          <pre>image-1-x123-y456.jpg</pre> {t('export.imageBaseName.note3')} <pre>1</pre>{' '}
          {t('export.imageBaseName.note4')} <pre>x123</pre> {t('export.imageBaseName.note5')}{' '}
          <pre>y456</pre> {t('export.imageBaseName.note6')}
        </div>
      </div>

      <div className="zt-format__form">
        <div className="zt-format__label">{t('export.templateFile')}</div>
        <div className="zt-format__input-wrapper">
          <AsyncSelect
            noOptionsMessage={NoFileOptionMessage}
            placeholder={t('export.search')}
            cacheOptions
            defaultValue={defaultTemplate}
            className="zt-multiselect"
            loadOptions={loadFileOptions}
            isClearable
            onChange={onChangeTemplatePath}
            styles={customSelectStyles}
          />
        </div>
        <div className="zt-format__input-note">
          {t('export.templateFile.note1')}{' '}
          <a
            href="https://mozilla.github.io/nunjucks/templating.html#variables"
            target="_blank"
            rel="noreferrer"
          >
            Nunjucks
          </a>
          .{' '}
          <a
            href="https://github.com/mgmeyers/obsidian-zotero-integration/blob/main/docs/Templating.md"
            target="_blank"
            rel="noreferrer"
          >
            {t('export.templateFile.note2')}
          </a>
          .
        </div>
      </div>

      {format.headerTemplatePath && (
        <div className="zt-format__form is-deprecated">
          <div className="zt-format__label">
            {t('export.deprecated.header')}
          </div>
          <div className="zt-format__input-wrapper">
            <input type="text" disabled value={format.headerTemplatePath} />
            <button
              className="mod-warning"
              onClick={() => {
                updateFormat(index, {
                  ...format,
                  headerTemplatePath: undefined,
                });
              }}
            >
              {t('export.removeTemplate')}
            </button>
          </div>
          <div className="zt-format__input-note">
            {t('export.deprecated.note')}{' '}
            <a
              href="https://github.com/mgmeyers/obsidian-zotero-integration/blob/main/docs/Templating.md"
              target="_blank"
              rel="noreferrer"
            >
              {t('export.templateFile.note2')}
            </a>
            .
          </div>
        </div>
      )}

      {format.annotationTemplatePath && (
        <div className="zt-format__form is-deprecated">
          <div className="zt-format__label">
            {t('export.deprecated.annotation')}
          </div>
          <div className="zt-format__input-wrapper">
            <input type="text" disabled value={format.annotationTemplatePath} />
            <button
              className="mod-warning"
              onClick={() => {
                updateFormat(index, {
                  ...format,
                  annotationTemplatePath: undefined,
                });
              }}
            >
              {t('export.removeTemplate')}
            </button>
          </div>
          <div className="zt-format__input-note">
            {t('export.deprecated.note')}{' '}
            <a
              href="https://github.com/mgmeyers/obsidian-zotero-integration/blob/main/docs/Templating.md"
              target="_blank"
              rel="noreferrer"
            >
              {t('export.templateFile.note2')}
            </a>
            .
          </div>
        </div>
      )}

      {format.footerTemplatePath && (
        <div className="zt-format__form is-deprecated">
          <div className="zt-format__label">
            {t('export.deprecated.footer')}
          </div>
          <div className="zt-format__input-wrapper">
            <input type="text" disabled value={format.footerTemplatePath} />
            <button
              className="mod-warning"
              onClick={() => {
                updateFormat(index, {
                  ...format,
                  footerTemplatePath: undefined,
                });
              }}
            >
              {t('export.removeTemplate')}
            </button>
          </div>
          <div className="zt-format__input-note">
            {t('export.deprecated.note')}{' '}
            <a
              href="https://github.com/mgmeyers/obsidian-zotero-integration/blob/main/docs/Templating.md"
              target="_blank"
              rel="noreferrer"
            >
              {t('export.templateFile.note2')}
            </a>
            .
          </div>
        </div>
      )}

      <div className="zt-format__form">
        <div className="zt-format__label">{t('export.style')}</div>
        <div className="zt-format__input-wrapper">
          <AsyncSelect
            noOptionsMessage={NoOptionMessage}
            placeholder={t('export.search')}
            cacheOptions
            defaultValue={defaultStyle}
            className="zt-multiselect"
            loadOptions={loadCSLOptions}
            isClearable
            onChange={onChangeCSLStyle}
            styles={customSelectStyles}
          />
        </div>
        <div className="zt-format__input-note">
          {t('export.style.note')}{' '}
          <a
            target="_blank"
            href="https://www.zotero.org/support/styles"
            rel="noreferrer"
          >
            {t('export.style.note2')}
          </a>
        </div>
      </div>
    </div>
  );
}
