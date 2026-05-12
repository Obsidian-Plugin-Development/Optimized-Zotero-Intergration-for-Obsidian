import download from 'download';
import { Notice, debounce } from 'obsidian';
import os from 'os';
import React from 'react';
import {
  checkEXEVersion,
  doesEXEExist,
  doesLegacyEXEExist,
  doesLegacyEXEExist2,
  getExeRoot,
  removeEXE,
  removeLegacyEXE,
  removeLegacyEXE2,
  scopeExe,
} from 'src/helpers';
import { ZoteroConnectorSettings } from 'src/types';

import { t } from '../locale/i18n';
import { Icon } from './Icon';
import { SettingItem } from './SettingItem';

export const currentVersion = '1.0.15';
export const internalVersion = 1;

const options: Record<string, Record<string, string>> = {
  darwin: {
    x64: `https://github.com/mgmeyers/pdfannots2json/releases/download/${currentVersion}/pdfannots2json.Mac.Intel.tar.gz`,
    arm64: `https://github.com/mgmeyers/pdfannots2json/releases/download/${currentVersion}/pdfannots2json.Mac.M1.tar.gz`,
  },
  linux: {
    x64: `https://github.com/mgmeyers/pdfannots2json/releases/download/${currentVersion}/pdfannots2json.Linux.x64.tar.gz`,
  },
  win32: {
    x64: `https://github.com/mgmeyers/pdfannots2json/releases/download/${currentVersion}/pdfannots2json.Windows.x64.zip`,
  },
};

function getDownloadUrl() {
  const platform = options[os.platform()];

  if (!platform) return null;

  const url = platform[os.arch()];

  if (!url) return null;

  return url;
}

export async function downloadAndExtract() {
  const url = getDownloadUrl();

  console.log('Obsidian Zotero Integration: Downloading ' + url);

  if (!url) return false;

  try {
    if (doesLegacyEXEExist2()) {
      removeLegacyEXE2();
    }

    if (doesLegacyEXEExist()) {
      removeLegacyEXE();
    }

    if (doesEXEExist()) {
      removeEXE();
    }

    await download(url, getExeRoot(), {
      extract: true,
    });

    scopeExe();
  } catch (e) {
    console.error(e);
    new Notice(t('notice.pdfDownloadError'), 10000);
  }

  return true;
}

export function AssetDownloader(props: {
  settings: ZoteroConnectorSettings;
  updateSetting: (key: keyof ZoteroConnectorSettings, value: any) => void;
}) {
  const [isUpToDate, setIsUpToDate] = React.useState<boolean | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [exists, setExists] = React.useState(false);
  const [overridePath, setOverridePath] = React.useState(
    props.settings.exeOverridePath
  );

  const setOverride = React.useMemo(
    () =>
      debounce(
        (path: string) => {
          setOverridePath(path);
          props.updateSetting('exeOverridePath', path);
        },
        150,
        true
      ),
    []
  );

  React.useEffect(() => {
    const exists = doesEXEExist(overridePath);
    setExists(exists);

    if (exists) {
      checkEXEVersion(overridePath)
        .then((version) => {
          setIsUpToDate(`v${currentVersion}` === version);
        })
        .catch(() => {});
    }
  }, [overridePath]);

  const handleDownload = React.useCallback(() => {
    setIsLoading(true);

    downloadAndExtract().then((success) => {
      setIsLoading(false);

      if (success) {
        setIsUpToDate(true);
        setExists(true);
      }
    });
  }, []);

  const desc = [
    t('settings.pdfUtility.desc1'),
    t('settings.pdfUtility.desc2'),
  ];

  const overrideDesc = (
    <>
      {t('settings.pdfUtility.override.desc1')}{' '}
      <a
        href="https://github.com/mgmeyers/pdfannots2json/releases"
        target="_blank"
        rel="noreferrer"
      >
        {t('settings.pdfUtility.override.desc2')}
      </a>{' '}
      {t('settings.pdfUtility.override.desc3')}
    </>
  );

  const Override = (
    <SettingItem name={t('settings.pdfUtility.override')} description={overrideDesc}>
      <input
        onChange={(e) => setOverride((e.target as HTMLInputElement).value)}
        type="text"
        spellCheck={false}
        value={overridePath}
      />
      <div
        className="clickable-icon setting-editor-extra-setting-button"
        aria-label={t('settings.pdfUtility.selectExe')}
        onClick={() => {
          const path = require('electron').remote.dialog.showOpenDialogSync({
            properties: ['openFile'],
          });

          if (path && path.length) {
            setOverride(path[0]);
          }
        }}
      >
        <Icon name="lucide-folder-open" />
      </div>
    </SettingItem>
  );

  if (exists && isUpToDate) {
    return (
      <>
        <SettingItem name={t('settings.pdfUtility')} description={desc.join(' ')}>
          <div className="zt-asset-success">
            <div className="zt-asset-success__icon">
              <Icon name="check-small" />
            </div>
            <div className="zt-asset-success__message">
              {t('settings.pdfUtility.upToDate')}
            </div>
          </div>
        </SettingItem>
        {Override}
      </>
    );
  }

  const descFrag = (
    <>
      {desc.join(' ')}{' '}
      {exists && (
        <strong className="mod-warning">
          {t('settings.pdfUtility.needsUpdate')}
        </strong>
      )}
      {!exists && !overridePath && (
        <strong>{t('settings.pdfUtility.clickToDownload')}</strong>
      )}
    </>
  );

  return (
    <>
      <SettingItem name={t('settings.pdfUtility')} description={descFrag}>
        {!overridePath && (
          <button disabled={isLoading} onClick={handleDownload}>
            {isLoading ? t('settings.pdfUtility.downloading') : t('settings.pdfUtility.download')}
          </button>
        )}
      </SettingItem>
      {Override}
    </>
  );
}
