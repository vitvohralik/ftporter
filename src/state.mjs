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

	const state = readState(config.stateFile);
	state.targets[config.target] ??= {};
	state.targets[config.target][config.profileName] = {
		unstamped: [...unstampedSet].filter((rel) => Object.hasOwn(files, rel)),
		files,
	};

	fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
	fs.writeFileSync(config.stateFile, JSON.stringify(state));
}

/** Merges a partial (watch batch) result into the stored manifest instead of replacing it. */
export function updateManifest(config, touched, local, previous, failed = new Map(), unstamped = []) {
	const merged = new Map(Object.entries(previous.files).map(([rel, [size, mtime]]) => [rel, { size, mtime }]));
	for (const rel of touched) merged.delete(rel);
	for (const [rel, info] of local) if (touched.has(rel)) merged.set(rel, info);
	saveManifest(config, merged, previous, failed, unstamped);
}
