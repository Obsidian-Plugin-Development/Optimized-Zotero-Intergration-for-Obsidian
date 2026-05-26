import { App, Notice, request } from 'obsidian';
import net from 'net';

// ── 模块级状态 ──

let _app: App | null = null;
let _database: string = 'Zotero';
let _zoteroLikelyRunning = false;

// v6.6.5: Zotero 不可达状态 + 回调系统（供悬浮球图标闪烁）
let _zoteroUnreachable = false;
const _zoteroStateCallbacks: Array<(unreachable: boolean) => void> = [];

export function isZoteroUnreachable(): boolean {
	return _zoteroUnreachable;
}

export function onZoteroStateChange(cb: (unreachable: boolean) => void): () => void {
	_zoteroStateCallbacks.push(cb);
	return () => {
		const idx = _zoteroStateCallbacks.indexOf(cb);
		if (idx >= 0) _zoteroStateCallbacks.splice(idx, 1);
	};
}

export function setZoteroUnreachable(val: boolean) {
	if (_zoteroUnreachable === val) return;
	console.log('[ZoteroState] setZoteroUnreachable:', val, 'callbacks:', _zoteroStateCallbacks.length);
	_zoteroUnreachable = val;
	for (const cb of _zoteroStateCallbacks) {
		try { cb(val); } catch { /* 静默 */ }
	}
}

// ── v6.6.5: 快速恢复探测 — 供悬浮球点击时主动检测 Zotero 是否已恢复 ──

export async function probeZoteroRecovery(port: number): Promise<void> {
	if (!_zoteroUnreachable) return;
	console.log('[ZoteroState] probeZoteroRecovery: probing port', port);
	const alive = await quickPortProbe('127.0.0.1', port, 80);
	console.log('[ZoteroState] probeZoteroRecovery result:', alive);
	if (alive) {
		_zoteroLikelyRunning = true;
		setZoteroUnreachable(false);
	}
}

// ── 初始化 ──

export function initZoteroClient(app: App, database: string) {
	_app = app;
	_database = database;
}

export function updateZoteroClientDatabase(database: string) {
	_database = database;
}

// ── Zotero 未运行错误 ──

export class ZoteroNotRunningError extends Error {
	constructor() {
		super('Zotero 未运行，请手动启动 Zotero 后重试');
		this.name = 'ZoteroNotRunningError';
	}
}

// ── 连接错误检测（导出供 cayw / jsonRPC 抑制冗余 Notice）──

export function isConnectionError(e: any): boolean {
	if (e instanceof ZoteroNotRunningError) return true;
	const msg = (e?.message || String(e)).toLowerCase();
	return (
		msg.includes('econnrefused') ||
		msg.includes('err_connection_refused') ||
		msg.includes('failed to fetch') ||
		msg.includes('networkerror') ||
		msg.includes('enotfound') ||
		msg.includes('econnreset') ||
		msg.includes('etimedout') ||
		msg.includes('timeout')
	);
}

// ── TCP 端口快速预检 ──

function extractHostPort(url: string): { host: string; port: number } {
	const match = url.match(/http:\/\/([^:\/]+):(\d+)/);
	return {
		host: match ? match[1] : '127.0.0.1',
		port: match ? parseInt(match[2], 10) : 23119,
	};
}

function quickPortProbe(host: string, port: number, timeoutMs: number = 50): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = new net.Socket();
		sock.setTimeout(timeoutMs);
		sock.on('connect', () => {
			sock.destroy();
			resolve(true);
		});
		sock.on('error', () => {
			sock.destroy();
			resolve(false);
		});
		sock.on('timeout', () => {
			sock.destroy();
			resolve(false);
		});
		sock.connect(port, host);
	});
}

// ── 请求接口 ──

interface ZoteroRequestOptions {
	method: string;
	url: string;
	body?: string;
	headers?: Record<string, string>;
	_zoteroSilent?: boolean;
}

// ── 核心 ──

export async function zoteroRequest(options: ZoteroRequestOptions): Promise<string> {
	const { _zoteroSilent, ...reqOpts } = options;

	// TCP 端口快速预检：已知运行时跳过（0ms），否则 50ms 内确认
	if (!_zoteroLikelyRunning) {
		const { host, port } = extractHostPort(options.url);
		const portAlive = await quickPortProbe(host, port, 50);
		if (!portAlive) {
			_zoteroLikelyRunning = false;
			// v6.6.5: 不再弹 Notice，改为更新不可达状态（悬浮球图标缓慢闪烁）
			setZoteroUnreachable(true);
			throw new ZoteroNotRunningError();
		}
	}

	try {
		const result = await request(reqOpts);
		console.log('[ZoteroState] zoteroRequest SUCCESS — clearing unreachable');
		_zoteroLikelyRunning = true;
		// v6.6.5: Zotero 恢复可达 → 清除闪烁
		setZoteroUnreachable(false);
		return result;
	} catch (e) {
		console.log('[ZoteroState] zoteroRequest FAILED — isConnErr:', isConnectionError(e), _zoteroSilent);
		_zoteroLikelyRunning = false;
		// v6.6.5: 连接错误 → Zotero 不可达；非连接错误（404等）→ Zotero 可达但 BBT 忙
		if (isConnectionError(e)) {
			setZoteroUnreachable(true);
		} else {
			setZoteroUnreachable(false);
		}
		throw e;
	}
}
