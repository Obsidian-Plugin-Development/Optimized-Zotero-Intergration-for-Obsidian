import { App, Notice, request } from 'obsidian';
import net from 'net';

// ── 模块级状态 ──

let _app: App | null = null;
let _database: string = 'Zotero';
let _zoteroLikelyRunning = false;

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
			const err = new ZoteroNotRunningError();
			if (!_zoteroSilent) {
				new Notice(err.message, 5000);
			}
			throw err;
		}
	}

	try {
		const result = await request(reqOpts);
		_zoteroLikelyRunning = true;
		return result;
	} catch (e) {
		if (_zoteroSilent) throw e;
		if (!isConnectionError(e)) throw e;

		_zoteroLikelyRunning = false;
		new Notice('Zotero 未运行，请手动启动 Zotero 后重试', 5000);
		throw e;
	}
}
