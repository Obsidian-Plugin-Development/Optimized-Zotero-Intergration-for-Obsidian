import { Notice, htmlToMarkdown, moment } from 'obsidian';

import { t } from '../locale/i18n';
import { zoteroRequest, isConnectionError } from './zoteroClient';
import { padNumber } from '../helpers';
import { CiteKeyExport, DatabaseWithPort } from '../types';
// v6.3.0: LoadingModal removed — callers handle progress via HUD or their own UI
import { CiteKey, getCiteKeyFromAny, isZoteroRunning } from './cayw';
import { defaultHeaders, getPort } from './helpers';
import { ZQueue } from './queue';

export async function getNotesFromCiteKeys(
  citeKeys: CiteKey[],
  database: DatabaseWithPort
) {
  let res: string;

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.notes',
        params: [citeKeys.map((k) => k.key)],
      }),
      headers: defaultHeaders,
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingNotes')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);

  try {
    return JSON.parse(res).result;
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingNotes')} ${e.message}`, 10000); }
    return null;
  }
}

export async function getCollectionFromCiteKey(
  citeKey: CiteKey,
  database: DatabaseWithPort
) {
  let res: string;

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.collections',
        params: [[citeKey.key], true],
      }),
      headers: defaultHeaders,
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingNotes')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);

  try {
    const result = JSON.parse(res).result;
    const cols = result[citeKey.key];

    return cols.map((c: any) => {
      let pointer = c;
      const fullPath = [c.name];

      while (pointer.parentCollection) {
        fullPath.push(pointer.parentCollection.name);
        pointer = pointer.parentCollection;
      }

      return {
        key: c.key,
        name: c.name,
        fullPath: fullPath.reverse().join('/'),
      };
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingNotes')} ${e.message}`, 10000); }
    return null;
  }
}

export async function getAttachmentsFromCiteKey(
  citeKey: CiteKey,
  database: DatabaseWithPort
) {
  let res: string;

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.attachments',
        params: [citeKey.key, citeKey.library],
      }),
      headers: defaultHeaders,
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingNotes')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);

  try {
    return JSON.parse(res).result;
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingNotes')} ${e.message}`, 10000); }
    return null;
  }
}

let cachedLibs: any[] = null;
const cachedCiteKeys: Map<string, number> = new Map();

export async function getLibForCiteKey(
  citeKey: string,
  database: DatabaseWithPort
) {
  if (cachedCiteKeys.has(citeKey)) return cachedCiteKeys.get(citeKey);
  const qid = Symbol();
  try {
    const searchResults = await execSearch(citeKey, database);
    if (!searchResults || searchResults.length === 0) {
      return null;
    }

    const match = searchResults.find((res: any) => res.citekey === citeKey);
    if (!match) return null;

    if (cachedLibs) {
      const lib = cachedLibs.find((p: any) => p.name === match.library);
      if (lib) {
        cachedCiteKeys.set(citeKey, lib.id);
        return lib.id;
      }

      return null;
    }

    await ZQueue.wait(qid);
    const res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'user.groups',
      }),
      headers: defaultHeaders,
    });
    ZQueue.end(qid);

    const parsed = JSON.parse(res);
    if (parsed.result?.length > 0) {
      cachedLibs = parsed.result;
      const lib = cachedLibs.find((p: any) => p.name === match.library);

      if (lib) {
        cachedCiteKeys.set(citeKey, lib.id);
        return lib.id;
      }

      return null;
    }
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingLibraryId')} ${e.message}`, 10000); }
    ZQueue.end(qid);
  }

  return null;
}

export function getBibFromCiteKey(
  citeKey: CiteKey,
  database: DatabaseWithPort,
  cslStyle?: string,
  format?: string,
  silent?: boolean
) {
  return getBibFromCiteKeys([citeKey], database, cslStyle, format, silent);
}

export async function getBibFromCiteKeys(
  citeKeys: CiteKey[],
  database: DatabaseWithPort,
  cslStyle?: string,
  format?: string,
  silent?: boolean
) {
  if (!citeKeys || !citeKeys.length) return null;

  let res: string;
  const qid = Symbol();
  try {
    const params: Record<string, any> = {
      quickCopy: true,
      contentType: 'html',
    };

    if (cslStyle) {
      delete params.quickCopy;
      params.id = cslStyle;
    }

    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.bibliography',
        params: [citeKeys.map((k) => k.key), params, citeKeys[0].library],
      }),
      headers: defaultHeaders,
      _zoteroSilent: silent || false,
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingBib')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);

  try {
    const parsed = JSON.parse(res);
    if (parsed.error?.message) {
      throw new Error(parsed.error.message);
    }
    return format === 'html' ? parsed.result : htmlToMarkdown(parsed.result);
  } catch (e) {
    console.error(e);
    console.error(`Response from BBT: ${res}`);

    let message = `${t('notice.convertError')} ${e.message}`;

    if ((e.message as string).includes('element/document/fragment')) {
      message = t('notice.emptyBib');
    }

    if (!isConnectionError(e)) { new Notice(message, 10000); }
    return null;
  }
}

export async function getItemJSONFromCiteKeys(
  citeKeys: CiteKey[],
  database: DatabaseWithPort,
  libraryID: number,
  silent?: boolean
) {
  let res: string;

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.export',
        params: [
          citeKeys.map((k) => k.key),
          '36a3b0b5-bad0-4a04-b79b-441c7cef77db',
          libraryID,
        ],
      }),
      headers: defaultHeaders,
      _zoteroSilent: silent || false,
    });
  } catch (e) {
    console.error(e);
      if (!silent && !isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingItem')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);

  try {
    const parsed = JSON.parse(res);
    if (parsed.error?.message) {
      throw new Error(parsed.error.message);
    }

    return Array.isArray(parsed.result)
      ? JSON.parse(parsed.result[2]).items
      : JSON.parse(parsed.result).items;
  } catch (e) {
    console.error(e);
    if (!silent && !isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingItem')} ${e.message}`, 10000); }
    return null;
  }
}

export async function getItemJSONFromRelations(
  libraryID: number,
  relations: string[],
  database: DatabaseWithPort
) {
  let res: string;

  const uriMap: Record<string, string> = {};
  const idOrder: string[] = [];

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.citationkey',
        params: [
          relations.map((r) => {
            const id = r.split('/').pop();
            idOrder.push(id);
            uriMap[id] = r;
            return `${libraryID}:${id}`;
          }),
        ],
      }),
      headers: defaultHeaders,
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingItem')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);

  const idMap: Record<string, any> = {};
  const citekeys: CiteKey[] = [];

  try {
    const json = JSON.parse(res);

    Object.keys(json.result).forEach((k) => {
      const id = k.split(':').pop();
      if (json.result[k]) {
        citekeys.push({ key: json.result[k], library: libraryID });
        idMap[id] = { citekey: json.result[k], uri: uriMap[id] };
      } else {
        idMap[id] = { uri: uriMap[id] };
      }
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingItem')} ${e.message}`, 10000); }
    return null;
  }

  const items: any[] = citekeys.length
    ? await getItemJSONFromCiteKeys(citekeys, database, libraryID)
    : [];

  return idOrder.map((id) => {
    if (idMap[id].citekey) {
      const item = items.find(
        (item) => getCiteKeyFromAny(item)?.key === idMap[id].citekey
      );

      if (item) {
        return item;
      }
    }

    return idMap[id];
  });
}

export async function getIssueDateFromCiteKey(
  citeKey: CiteKey,
  database: DatabaseWithPort
) {
  let res: string;

  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.export',
        params: [
          [citeKey.key],
          'f4b52ab0-f878-4556-85a0-c7aeedd09dfc',
          citeKey.library,
        ],
      }),
      headers: defaultHeaders,
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingItem')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);

  try {
    const parsed = JSON.parse(res);
    if (parsed.error?.message) {
      throw new Error(parsed.error.message);
    }

    const items = Array.isArray(parsed.result)
      ? JSON.parse(parsed.result[2])
      : JSON.parse(parsed.result);
    const dates = items
      .map((i: any) => {
        const { issued } = i;
        if (!issued || !issued['date-parts']) return null;

        const dateParts = issued['date-parts'][0];

        if (!dateParts.length) return null;

        const date = moment(
          `${dateParts[0]}-${dateParts[1] ? padNumber(dateParts[1]) : '01'}-${
            dateParts[2] ? padNumber(dateParts[2]) : '01'
          }`,
          'YYYY-MM-DD'
        );

        return date;
      })
      .filter((d: any) => d);

    return dates[0] ? dates[0] : null;
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorRetrievingItem')} ${e.message}`, 10000); }
    return null;
  }
}

export async function execSearch(term: string, database: DatabaseWithPort) {
  let res: string;
  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.search',
        params: [term],
      }),
      headers: defaultHeaders,
    });
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorSearching')} ${e.message}`, 10000); }
    ZQueue.end(qid);
    return null;
  }

  ZQueue.end(qid);
  try {
    return JSON.parse(res).result;
  } catch (e) {
    console.error(e);
    if (!isConnectionError(e)) { new Notice(`${t('notice.errorSearching')} ${e.message}`, 10000); }
    return null;
  }
}

const translatorId = 'f4b52ab0-f878-4556-85a0-c7aeedd09dfc';
export async function getCiteKeyExport(
  database: DatabaseWithPort,
  groupId: string,
  groupName: string
) {
  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    const res = await zoteroRequest({
      method: 'GET',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/export/library?/${groupId}/${groupName}.${translatorId}`,
      headers: defaultHeaders,
    });
    ZQueue.end(qid);

    const entries = JSON.parse(res);

    return Array.isArray(entries)
      ? entries
          .map((e) => {
            const out: Record<string, any> = {
              libraryID: Number(groupId),
            };

            if (e['citation-key']) {
              out.citekey = e['citation-key'];
            } else {
              return null;
            }

            if (e['title']) {
              out.title = e['title'];
            } else {
              return null;
            }

            return out as { libraryID: number; citekey: string; title: string };
          })
          .filter((k) => !!k)
      : null;
  } catch (e) {
    ZQueue.end(qid);
    return null;
  }
}

export async function getUserGroups(database: DatabaseWithPort) {
  let res: string;
  const qid = Symbol();
  try {
    await ZQueue.wait(qid);
    res = await zoteroRequest({
      method: 'POST',
      url: `http://127.0.0.1:${getPort(
        database.database,
        database.port
      )}/better-bibtex/json-rpc`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'user.groups',
        params: [],
      }),
      headers: defaultHeaders,
    });
  } catch (e) {
    console.error(e);
    ZQueue.end(qid);
    return null;
  }
  ZQueue.end(qid);

  try {
    return JSON.parse(res).result;
  } catch (e) {
    console.error(e);
    return null;
  }
}

let cachedKeys: CiteKeyExport[] = [];
let lastCheck = 0;

export async function getAllCiteKeys(
  database: DatabaseWithPort,
  force?: boolean
) {
  if (!force && cachedKeys.length && Date.now() - lastCheck < 1000 * 60) {
    return { citekeys: cachedKeys, fromCache: true };
  }

  if (!(await isZoteroRunning(database, true))) {
    return { citekeys: cachedKeys, fromCache: true };
  }

  const allKeys: CiteKeyExport[] = [];
  const userGroups = await getUserGroups(database);

  if (!userGroups) {
    return { citekeys: cachedKeys, fromCache: true };
  }

  for (const group of userGroups) {
    const keys = await getCiteKeyExport(database, group.id, group.name);

    if (keys) {
      allKeys.push(...keys);
    }
  }

  cachedKeys = allKeys;
  lastCheck = Date.now();

  return { citekeys: allKeys, fromCache: false };
}
