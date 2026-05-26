import { Notice } from 'obsidian';

import { t } from '../locale/i18n';
import { bringObsidianToFront, focusZotero, getCurrentWindow } from '../helpers';
import { CitationFormat, DatabaseWithPort } from '../types';
import { defaultHeaders, getPort } from './helpers';
import { getBibFromCiteKeys } from './jsonRPC';
import { ZQueue } from './queue';
import { zoteroRequest, isConnectionError } from './zoteroClient';

export function getCiteKeyFromAny(item: any): CiteKey | null {
  if (!item.citekey && !item.citationKey) return null;

  return {
    key: item.citekey || item.citationKey,
    library: item.libraryID,
  };
}

let cachedIsRunning = false;
let lastCheck = 0;

export async function isZoteroRunning(
  database: DatabaseWithPort,
  silent?: boolean
) {
  if (cachedIsRunning && Date.now() - lastCheck < 1000 * 30) {
    return cachedIsRunning;
  }

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    const res = await zoteroRequest({
      method: 'GET',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/cayw?probe=true`,
      headers: defaultHeaders,
      _zoteroSilent: silent || false,
    });

    cachedIsRunning = res === 'ready';
    lastCheck = Date.now();
    ZQueue.end(qid);
    return cachedIsRunning;
  } catch (e) {
    // 连接错误：更新负缓存（30s TTL），避免重复 TCP 探针
    if (isConnectionError(e)) {
      cachedIsRunning = false;
      lastCheck = Date.now();
    } else if (!silent) {
      new Notice(
        t('notice.zoteroNotRunning'),
        10000
      );
    }
    ZQueue.end(qid);
    return false;
  }
}

function getQueryParams(format: CitationFormat) {
  switch (format.format) {
    case 'formatted-bibliography':
      return 'format=formatted-bibliography&picker=bbt';
    case 'formatted-citation':
      return `format=formatted-citation${
        format.cslStyle ? `&style=${format.cslStyle}` : ''
      }&picker=bbt`;
    case 'pandoc':
      return `format=pandoc${format.brackets ? '&brackets=true' : ''}&picker=bbt`;
    case 'latex':
      return `format=latex&command=${format.command || 'cite'}&picker=bbt`;
    case 'biblatex':
      return `format=biblatex&command=${format.command || 'autocite'}&picker=bbt`;
  }
}

export async function getCAYW(
  format: CitationFormat,
  database: DatabaseWithPort
) {
  const win = getCurrentWindow();
  if (!(await isZoteroRunning(database))) {
    return null;
  }

  // 预最小化 Zotero 主窗口（SW_MINIMIZE=6），引注弹窗有独立 HWND 不受影响
  await focusZotero(database.database);

  const qid = Symbol();
  try {
    if (format.format === 'formatted-bibliography') {
      const citeKeys = await getCiteKeys(database);
      return await getBibFromCiteKeys(citeKeys, database, format.cslStyle);
    }

    await ZQueue.wait(qid);
    const res = await zoteroRequest({
      method: 'GET',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/cayw?${getQueryParams(format)}`,
      headers: defaultHeaders,
    });

    bringObsidianToFront(win);
    ZQueue.end(qid);
    return res;
  } catch (e) {
    bringObsidianToFront(win);
    console.error(e);
    if (!isConnectionError(e)) {
      new Notice(`${t('notice.citationError')} ${e.message}`, 10000);
    }
    ZQueue.end(qid);
    return null;
  }
}

export interface CiteKey {
  key: string;
  library: number;
}

export async function getCiteKeys(
  database: DatabaseWithPort
): Promise<CiteKey[]> {
  try {
    const json = await getCAYWJSON(database);

    if (!json) return [];

    const citeKeys = json
      .map((e: any) => {
        return getCiteKeyFromAny(e);
      })
      .filter((e: any) => !!e);

    if (!citeKeys.length) {
      return [];
    }

    return citeKeys;
  } catch (e) {
    return [];
  }
}

// ── v7.4 Zotero 幽灵心跳：25s 间隔保活探针，确保 isZoteroRunning 永远热路径 ──
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startZoteroHeartbeat(database: DatabaseWithPort): void {
  if (heartbeatTimer) return;
  // 立即发送首次探针
  isZoteroRunning(database, true);
  // 每 25s 保活（< 30s TTL，确保缓存永不过期）
  heartbeatTimer = setInterval(() => {
    isZoteroRunning(database, true);
  }, 25_000);
}

export function stopZoteroHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export async function getCAYWJSON(database: DatabaseWithPort) {
  const win = getCurrentWindow();
  if (!(await isZoteroRunning(database))) {
    return null;
  }

  // 预最小化 Zotero 主窗口（SW_MINIMIZE=6），引注弹窗有独立 HWND 不受影响
  await focusZotero(database.database);

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    const res = await zoteroRequest({
      method: 'GET',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/cayw?format=translate&translator=36a3b0b5-bad0-4a04-b79b-441c7cef77db&exportNotes=false&picker=bbt`,
      headers: defaultHeaders,
    });

    // 延迟将 Obsidian 拉回前台，确保 Zotero 弹窗有足够时间显示
    // 特别是首次启动时，Zotero 需要更多时间初始化弹窗
    setTimeout(() => {
      bringObsidianToFront(win);
    }, 500);

    ZQueue.end(qid);
    if (res) {
      return JSON.parse(res).items || [];
    } else {
      return null;
    }
  } catch (e) {
    // 错误情况下也延迟拉回，避免遮挡可能的错误提示
    setTimeout(() => {
      bringObsidianToFront(win);
    }, 500);
    console.error(e);
    if (!isConnectionError(e)) {
      new Notice(`${t('notice.citeKeyError')} ${e.message}`, 10000);
    }
    ZQueue.end(qid);
    return null;
  }
}
