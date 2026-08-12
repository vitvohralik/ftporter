import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

/** `~/x` → `/Users/you/x`. Left alone otherwise, so absolute and relative paths still work. */
export const expandHome = (p) =>
	p && (p === '~' || p.startsWith('~/')) ? path.join(homedir(), p.slice(1)) : p;

/** Runs `fn` over the items with a bounded number of concurrent calls. */
export async function mapLimit(items, limit, fn) {
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			await fn(items[index], index);
		}
	});
	await Promise.all(workers);
}

export const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** "30s", "5m", "1h", "500ms" or a plain number of milliseconds. Returns null when unparsable. */
export function parseDuration(value) {
	if (value == null) return null;
	if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
	const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
	if (!match) return null;
	const amount = Number(match[1]);
	const unit = (match[2] ?? 'ms').toLowerCase();
	const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
	const ms = amount * factor;
	return ms > 0 ? ms : null;
}

export function formatDuration(ms) {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

export const sha1 = (text) => createHash('sha1').update(text).digest('hex');

/** Sizes as a person reads them. Bytes stay exact; everything above gets one decimal under 10. */
export function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return '?';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Local time, to the minute — enough to recognise a file, short enough to line up in a listing. */
export function formatStamp(ms) {
	if (!ms) return '—';
	const at = new Date(ms);
	const pad = (n) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** POSIX-style relative path — the remote side always uses `/`, even when running on Windows. */
export const toPosix = (rel) => rel.split(path.sep).join('/');

export const parentOf = (rel) => {
	const at = rel.lastIndexOf('/');
	return at === -1 ? '' : rel.slice(0, at);
};

/** Every directory those paths live in, including all ancestors and the root (`''`). */
export function dirsOf(paths) {
	const dirs = new Set(['']);
	for (const rel of paths) {
		let dir = parentOf(rel);
		while (dir && !dirs.has(dir)) {
			dirs.add(dir);
			dir = parentOf(dir);
		}
	}
	return [...dirs];
}

/** Deep merge for plain objects; arrays and scalars are replaced, `undefined` never overwrites. */
export function merge(base, override) {
	if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
	const out = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
	}
	return out;
}

export const isPlainObject = (value) =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Error type whose message is printed as a clean CLI error instead of a stack trace. */
export class UserError extends Error {
	constructor(message, hint) {
		super(message);
		this.name = 'UserError';
		this.hint = hint;
	}
}
