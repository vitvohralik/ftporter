import fs from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 4;

/**
 * The manifest records every file this tool knows it put on the server, in the shape it put there.
 *
 * It deliberately does **not** decide what gets uploaded — that is always read from the live server
 * state. Its only job is to bound deletion: a server holds symlinks, runtime files and things that
 * never existed locally, and none of those may ever be removed just because they are not local.
 *
 * Keyed by target and profile, so a `--profile assets` run never treats source files as deleted,
 * and a run against a scratch directory cannot corrupt the real target's manifest.
 */
export const emptyManifest = () => ({ files: {}, unstamped: new Set() });

export function readState(file, logger) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (raw.version === STATE_VERSION) return raw;
		logger?.warn('state file is from an older version — rebuilding, no deletions until the next run');
	} catch {
		// First run: we own nothing, so nothing gets deleted.
	}
	return { version: STATE_VERSION, targets: {} };
}

export function loadManifest(config, logger) {
	const stored = readState(config.stateFile, logger).targets[config.target]?.[config.profileName];
	if (!stored) return emptyManifest();
	return { files: stored.files ?? {}, unstamped: new Set(stored.unstamped ?? []) };
}

/**
 * Files that failed to upload are left out — they are not on the server in a shape we know, so they
 * must not become deletable either.
 *
 * With `delete` turned off nothing is ever removed, so only the files whose mtime could not be set
 * are worth remembering; keeping the full list would grow the state file for no benefit on trees
 * like node_modules.
 */
export function saveManifest(config, local, previous, failed = new Map(), unstamped = []) {
	const unstampedSet = new Set([...previous.unstamped, ...unstamped]);
	const keepAll = config.delete !== false;

	const files = {};
	for (const [rel, info] of local) {
		if (failed.has(rel)) continue;
		if (keepAll || unstampedSet.has(rel)) files[rel] = [info.size, Math.round(info.mtime)];
	}

	fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
	withLock(config.stateFile, () => {
		// Re-read inside the lock: another profile's run may have written its own section since.
		const state = readState(config.stateFile);
		state.targets[config.target] ??= {};
		state.targets[config.target][config.profileName] = {
			unstamped: [...unstampedSet].filter((rel) => Object.hasOwn(files, rel)),
			files,
		};
		writeAtomic(config.stateFile, JSON.stringify(state));
	});
}

/**
 * One state file holds every profile and target of a project, so two instances running side by side
 * write to the same path. Both halves of that are handled here: the lock keeps read-modify-write
 * from losing the other's section, and the rename keeps a reader from ever seeing a partial file.
 *
 * Neither is worth failing a sync over — the manifest only bounds deletion, and losing it means
 * nothing gets deleted until it is rebuilt, never that something gets deleted wrongly.
 */
function writeAtomic(file, contents) {
	const temp = `${file}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		fs.writeFileSync(temp, contents);
		fs.renameSync(temp, file);
	} catch (err) {
		fs.rmSync(temp, { force: true });
		throw err;
	}
}

const LOCK_STALE_MS = 30_000;

function withLock(file, fn) {
	const lock = `${file}.lock`;
	let held = false;
	for (let attempt = 0; attempt < 50 && !held; attempt++) {
		try {
			fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
			held = true;
		} catch {
			// A lock left behind by a killed process would block every later run, so it expires.
			const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
			if (age > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
			else sleep(10);
		}
	}
	try {
		fn();
	} finally {
		if (held) fs.rmSync(lock, { force: true });
	}
}

/** Blocking on purpose: the critical section is a few milliseconds and callers are not async here. */
function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Merges a partial (watch batch) result into the stored manifest instead of replacing it. */
export function updateManifest(config, touched, local, previous, failed = new Map(), unstamped = []) {
	const merged = new Map(Object.entries(previous.files).map(([rel, [size, mtime]]) => [rel, { size, mtime }]));
	for (const rel of touched) merged.delete(rel);
	for (const [rel, info] of local) if (touched.has(rel)) merged.set(rel, info);
	saveManifest(config, merged, previous, failed, unstamped);
}
