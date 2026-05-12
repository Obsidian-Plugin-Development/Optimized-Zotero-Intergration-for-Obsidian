import { execa } from 'execa';
import fs from 'fs';
import { FileSystemAdapter, Notice } from 'obsidian';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';

import { t } from './locale/i18n';

export function getCurrentWindow() {
  return require('electron').remote.BrowserWindow.getFocusedWindow();
}

/**
 * 将 Obsidian 窗口强制拉回屏幕最顶层。
 * 双保险策略：Electron API 立即执行 + OS 级命令兜底，
 * 确保 Zotero 弹窗关闭后 Obsidian 能可靠地回到前台。
 */
export function bringObsidianToFront(win?: any) {
  // 第一层：Electron BrowserWindow API（同步，立即生效）
  if (win) {
    try {
      win.setAlwaysOnTop(true, 'floating');
      win.show();
      win.focus();
    } catch {
      win.show();
    }
  }

  // 第二层：OS 级应用激活命令（异步兜底，突破 OS 防焦点窃取）
  try {
    if (process.platform === 'darwin') {
      exec(`osascript -e 'tell application "Obsidian" to activate'`, (err) => {
        if (err) console.debug('bringObsidianToFront macOS:', err.message);
      });
    } else if (process.platform === 'win32') {
      exec(
        `powershell -NoProfile -Command "$s=(New-Object -ComObject wscript.shell);(Get-Process obsidian -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle}).ForEach({$s.AppActivate($_.Id)})"`,
        (err) => {
          if (err) console.debug('bringObsidianToFront Windows:', err.message);
        }
      );
    }
  } catch {}

  // 延迟取消 alwaysOnTop，给 OS 级命令足够的执行时间
  if (win) {
    setTimeout(() => {
      try { win.setAlwaysOnTop(false); } catch {}
    }, 500);
  }
}

/**
 * 强制将 Zotero 主窗口激活并置于屏幕最顶层。
 * 在触发 Zotero 文献选择弹窗前调用，以避免系统「防焦点窃取」机制导致弹窗被隐藏；
 * 同时确保弹窗打开后键盘焦点正确，Enter 键可正常确认选择。
 *
 * 返回 Promise，调用方应 await 以确保 Zotero 聚焦完成后再发送 HTTP 请求。
 * 内置 3 秒超时保护，防止系统脚本异常导致流程永久阻塞。
 */
export function focusZotero(database: string = 'Zotero'): Promise<void> {
  const appName = database === 'Juris-M' ? 'Juris-M' : 'Zotero';
  const TIMEOUT_MS = 3000;

  const doFocus = new Promise<void>((resolve) => {
    try {
      if (process.platform === 'darwin') {
        exec(
          `osascript -e 'tell application "${appName}" to activate'`,
          (err) => {
            if (err) console.debug('focusZotero macOS:', err.message);
            resolve();
          }
        );
      } else if (process.platform === 'win32') {
        exec(
          `powershell -NoProfile -Command "$s=(New-Object -ComObject wscript.shell);$s.AppActivate('${appName}')"`,
          (err) => {
            if (err) console.debug('focusZotero Windows:', err.message);
            resolve();
          }
        );
      } else {
        resolve();
      }
    } catch {
      resolve();
    }
  });

  return Promise.race([doFocus, new Promise<void>((r) => setTimeout(r, TIMEOUT_MS))]);
}

export function padNumber(n: number): string {
  return n < 10 ? `0${n}` : n.toString();
}

export function getVaultRoot() {
  return (app.vault.adapter as FileSystemAdapter).getBasePath();
}

export function getExeRoot() {
  return path.join(
    getVaultRoot(),
    './.obsidian/plugins/obsidian-zotero-desktop-connector/'
  );
}

export function getExeName() {
  return os.platform() === 'win32'
    ? 'pdfannots2json.exe'
    : `pdfannots2json-${os.platform()}-${os.arch()}`;
}

export function scopeExe() {
  if (os.platform() === 'win32') {
    return;
  }

  fs.renameSync(
    path.join(getExeRoot(), getLegacyExeName()),
    path.join(getExeRoot(), getExeName())
  );
}

export function getLegacyExeName() {
  return os.platform() === 'win32' ? 'pdfannots2json.exe' : 'pdfannots2json';
}

export function getLegacyExeName2() {
  return os.platform() === 'win32' ? 'pdf-annots2json.exe' : 'pdf-annots2json';
}

export function doesEXEExist(override?: string) {
  if (override) return fs.existsSync(override);
  return fs.existsSync(path.join(getExeRoot(), getExeName()));
}

export function doesLegacyEXEExist(override?: string) {
  if (override) return fs.existsSync(override);
  return fs.existsSync(path.join(getExeRoot(), getLegacyExeName()));
}

export function doesLegacyEXEExist2() {
  return fs.existsSync(path.join(getExeRoot(), getLegacyExeName2()));
}

export function removeEXE() {
  fs.rmSync(path.join(getExeRoot(), getExeName()));
}

export function removeLegacyEXE() {
  fs.rmSync(path.join(getExeRoot(), getLegacyExeName()));
}

export function removeLegacyEXE2() {
  fs.rmSync(path.join(getExeRoot(), getLegacyExeName2()));
}

export async function checkEXEVersion(override?: string) {
  try {
    const result = await execa(
      override || path.join(getExeRoot(), getExeName()),
      ['-v']
    );

    if (result.stderr && !result.stderr.includes('warning')) {
      new Notice(`${t('notice.pdfVersionError')} ${result.stderr}`, 10000);
      throw new Error(result.stderr);
    }

    return result.stdout.trim();
  } catch (e) {
    console.error(e);
    new Notice(`${t('notice.pdfVersionError')} ${e.message}`, 10000);
    throw e;
  }
}

export function getExecutableMode(mode = 0) {
  return (
    mode | fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH
  );
}

function handleError(err: any) {
  console.error('Error: pdfannots2json not executable', err);

  if (err.code === 'ENOENT') {
    return false;
  } else {
    return undefined;
  }
}

export function ensureExecutableSync(override?: string) {
  const file = override || path.join(getExeRoot(), getExeName());

  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    //
  }

  try {
    const stats = fs.statSync(file);
    fs.chmodSync(file, getExecutableMode(stats.mode));
    return true;
  } catch (err) {
    return handleError(err);
  }
}
