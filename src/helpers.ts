import { execa } from 'execa';
import fs from 'fs';
import { FileSystemAdapter, Notice } from 'obsidian';
import os from 'os';
import path from 'path';
import { exec, spawn, type ChildProcess } from 'child_process';

import { t } from './locale/i18n';


// ── v7.4 常驻 PowerShell IPC 桥接 — 消除每次 CAYW 的 exec() 进程创建开销 ──
let psProcess: ChildProcess | null = null;
let psRequestId = 0;
const psPending = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
let psStdoutBuf = '';
const PS_MARKER_PREFIX = 'PS_DONE_';

/** 插件初始化时调用：启动常驻 PowerShell 后台进程 */
export function initPowerShellBridge(): void {
  if (psProcess && !psProcess.killed) return;
  try {
    psProcess = spawn('powershell', ['-NoProfile', '-NoLogo', '-NoExit'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    psProcess.stdout?.on('data', (data: Buffer) => {
      psStdoutBuf += data.toString('utf-8');
      const lines = psStdoutBuf.split('\n');
      psStdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/PS_DONE_(\d+)/);
        if (match) {
          const id = parseInt(match[1], 10);
          const pending = psPending.get(id);
          if (pending) {
            pending.resolve();
            psPending.delete(id);
          }
        }
      }
    });
    psProcess.stderr?.on('data', (data: Buffer) => {
      console.debug('[PS Bridge]', data.toString('utf-8'));
    });
    psProcess.on('exit', (code) => {
      console.warn('[PS Bridge] Process exited with code', code);
      for (const [, req] of psPending) {
        req.reject(new Error('PowerShell process exited unexpectedly'));
      }
      psPending.clear();
      psProcess = null;
    });
  } catch (e) {
    console.error('[PS Bridge] Failed to spawn PowerShell:', e);
    psProcess = null;
  }
}

/** 插件卸载时调用：可靠杀死常驻 PowerShell 进程，不留僵尸 */
export function disposePowerShellBridge(): void {
  if (!psProcess || psProcess.killed) { psProcess = null; return; }
  const p = psProcess;
  psProcess = null;
  // 先优雅退出
  try { p.stdin?.write('exit\n'); } catch {}
  // 500ms 后强制 kill
  setTimeout(() => {
    try { p.kill('SIGTERM'); } catch {}
    // 再等 200ms，若仍存活则 SIGKILL
    setTimeout(() => {
      try { if (!p.killed) p.kill('SIGKILL'); } catch {}
    }, 200);
  }, 500);
  // 拒绝所有等待中的请求
  for (const [, req] of psPending) {
    req.reject(new Error('PowerShell bridge disposed'));
  }
  psPending.clear();
}

export function getCurrentWindow() {
  try {
    return require('electron').remote.getCurrentWindow();
  } catch {
    return null;
  }
}

/**
 * 将 Obsidian 窗口拉回屏幕最顶层。
 * 移除 setAlwaysOnTop（会导致 z-order 混乱，遮挡 Zotero 弹窗）。
 * Windows 上直接使用 Electron BrowserWindow API 即可，无需 PowerShell。
 * macOS 保留 osascript 兜底。
 */
export function bringObsidianToFront(win?: any) {
  if (win) {
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch {
      // 静默失败
    }
  }

  // macOS: osascript 兜底
  try {
    if (process.platform === 'darwin') {
      exec(`osascript -e 'tell application "Obsidian" to activate'`, (err) => {
        if (err) console.debug('bringObsidianToFront macOS:', err.message);
      });
    }
  } catch {}
}

/**
 * 授权 Zotero 设置前台窗口，让 CAYW 弹窗能突破 Windows 焦点窃取防护。
 * Windows: AllowSetForegroundWindow(zoteroPid) — 仅授权，不做窗口位置/状态干预
 * macOS: osascript activate
 *
 * 返回 Promise，内置 2 秒超时保护。
 */
export function focusZotero(database: string = 'Zotero'): Promise<void> {
  const appName = database === 'Juris-M' ? 'Juris-M' : 'Zotero';
  const TIMEOUT_MS = 2000;

  return new Promise<void>((resolve) => {
    // macOS: 仍使用 exec 调用 osascript（macOS 无进程创建瓶颈）
    if (process.platform === 'darwin') {
      exec(
        `osascript -e 'tell application "${appName}" to activate'`,
        (err) => {
          if (err) console.debug('focusZotero macOS:', err.message);
          resolve();
        }
      );
      return;
    }

    // 非 Windows: 直接 resolve
    if (process.platform !== 'win32') {
      resolve();
      return;
    }

    // ★ v7.4 Windows: 通过常驻 PowerShell 桥接发送命令，消除 exec() 进程创建开销
    if (!psProcess || psProcess.killed) {
      initPowerShellBridge();
    }

    if (!psProcess || psProcess.killed) {
      // 桥接不可用时回退到 exec（静默降级）
      exec(
        `powershell -NoProfile -Command "$c=Add-Type -MemberDefinition '[DllImport(\\"user32.dll\\")]public static extern bool AllowSetForegroundWindow(uint pid);' -Name 'W' -Namespace 'N' -PassThru;$s=Add-Type -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name 'S' -Namespace 'N' -PassThru;$p=Get-Process -Name '${appName}' -ErrorAction SilentlyContinue|Where-Object{$_.Id}|Select-Object -First 1;if($p){$c::AllowSetForegroundWindow($p.Id);$h=$p.MainWindowHandle;if($h){$s::ShowWindow($h,6)}}"`,
        (err) => {
          if (err) console.debug('focusZotero Windows (fallback):', err.message);
          resolve();
        }
      );
      return;
    }

    const id = ++psRequestId;

    // 2 秒安全超时：不阻塞 CAYW 主流程
    const timer = setTimeout(() => {
      psPending.delete(id);
      resolve();
    }, TIMEOUT_MS);

    psPending.set(id, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (_err: Error) => { clearTimeout(timer); resolve(); },
    });

    try {
      psProcess.stdin!.write(
        `$c=Add-Type -MemberDefinition '[DllImport("user32.dll")]public static extern bool AllowSetForegroundWindow(uint pid);' -Name 'W' -Namespace 'N' -PassThru;$s=Add-Type -MemberDefinition '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name 'S' -Namespace 'N' -PassThru;$p=Get-Process -Name '${appName}' -ErrorAction SilentlyContinue|Where-Object{$_.Id}|Select-Object -First 1;if($p){$c::AllowSetForegroundWindow($p.Id);$h=$p.MainWindowHandle;if($h){$s::ShowWindow($h,6)}};Write-Host '${PS_MARKER_PREFIX}${id}'\n`
      );
    } catch {
      psPending.delete(id);
      clearTimeout(timer);
      resolve();
    }
  });
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
