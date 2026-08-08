import { color } from './logger.mjs';
import { matcher } from './match.mjs';
import { ignoredByGit, scanLocal } from './scan.mjs';
import { SFTP_NO_SUCH_FILE } from './sftp.mjs';
import { loadManifest, saveManifest, updateManifest } from './state.mjs';
import { dirsOf, mapLimit, parentOf, secs, UserError } from './util.mjs';

// ──────────────────────────────────────────────────────────────────────────────
// Remote scan
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Reads the server state. One readdir per directory is far cheaper than one stat per file — for a
 * project of a few thousand files that is hundreds of calls instead of thousands.
 *
 * @returns {Promise<{entries: Map<string, {dir: boolean, link: boolean, size: number, mtime: number}>, dirs: Set<string>}>}
 */
export async function scanRemote(session, config, logger, dirs) {
	const entries = new Map();
	const existing = new Set();
	let done = 0;

	await mapLimit(dirs, config.concurrency.scan, async (dir) => {
		let list;
		try {
			list = await session.readdir(dir);
		} catch (err) {
			if (err.code === SFTP_NO_SUCH_FILE) return; // not created on the server yet
			throw err;
		} finally {
			done += 1;
			if (done % 16 === 0 || done === dirs.length) logger.status(`  server ${done}/${dirs.length} dirs`);
		}
		existing.add(dir);
		for (const item of list) {
			entries.set(dir ? `${dir}/${item.filename}` : item.filename, {
				dir: item.longname.startsWith('d'),
				link: item.longname.startsWith('l'),
				size: item.attrs.size,
				mtime: item.attrs.mtime * 1000,
			});
		}
	});

	return { entries, dirs: existing };
}

// ──────────────────────────────────────────────────────────────────────────────
// Diff
// ──────────────────────────────────────────────────────────────────────────────

const inSync = (local, remote, tolerance) =>
	!remote.dir && !remote.link && remote.size === local.size && Math.abs(remote.mtime - local.mtime) <= tolerance;

/**
 * Some servers hold files owned by a different uid. Writing to them can still work, but the kernel
 * refuses `utimes` on a file you do not own, so their remote mtime stays at upload time and an
 * mtime comparison would upload them over and over. For those files, and only those, the local
 * state is compared against what the manifest recorded instead.
 */
const matchesManifest = (local, remote, known, tolerance) =>
	known !== undefined &&
	known[0] === local.size &&
	remote.size === local.size &&
	Math.abs(known[1] - local.mtime) <= tolerance;

/**
 * @returns {{uploads: string[], blocked: string[], deletes: string[], stale: string[]}}
 *   blocked = a symlink or directory sits on the server, overwriting would be destructive
 *   stale   = the manifest says "delete", but the file changed on the server in the meantime
 */
export function diff(local, remote, manifest, config) {
	const tolerance = config.mtimeToleranceMs;
	const uploads = [];
	const blocked = [];

	// With timestamps preserved the remote mtime is authoritative. Without them — either because
	// preserveTimestamps is off, or because this particular file could not be stamped — the only
	// thing left to compare against is what the manifest recorded at upload time.
	const stamped = (rel) => config.preserveTimestamps && !manifest.unstamped.has(rel);

	/**
	 * A server stores mtime in whole seconds, so the remote comparison needs a tolerance of at
	 * least a second — which makes it blind to an edit that keeps the size and lands inside the
	 * same second (`one` → `two`, and every "save twice quickly" case). The manifest, on the other
	 * hand, holds the millisecond mtime of what was actually uploaded, so when it knows the file
	 * its record is the sharper test: differ from it and the file is stale, full stop.
	 */
	const changedSinceUpload = (rel, info) => {
		const known = manifest.files[rel];
		return known !== undefined && (known[0] !== info.size || Math.abs(known[1] - info.mtime) > 1);
	};

	for (const [rel, info] of local) {
		const entry = remote.entries.get(rel);
		if (!entry) uploads.push(rel);
		else if (entry.dir || entry.link) blocked.push(rel);
		else if (changedSinceUpload(rel, info)) uploads.push(rel);
		else if (stamped(rel) ? inSync(info, entry, tolerance) : matchesManifest(info, entry, manifest.files[rel], tolerance)) continue;
		else uploads.push(rel);
	}

	const deletes = [];
	const stale = [];
	if (config.delete) {
		for (const [rel, [size, mtime]] of Object.entries(manifest.files)) {
			if (local.has(rel)) continue;
			const entry = remote.entries.get(rel);
			if (!entry) continue; // already gone from the server, just forget about it
			const unchanged = stamped(rel)
				? inSync({ size, mtime }, entry, tolerance)
				: !entry.dir && !entry.link && entry.size === size;
			if (unchanged) deletes.push(rel);
			else stale.push(rel); // somebody changed it on the server — hands off
		}
	}

	uploads.sort();
	deletes.sort();
	return { uploads, blocked, deletes, stale };
}

// ──────────────────────────────────────────────────────────────────────────────
// Applying the changes
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Uploads the files and stamps them with the local mtime on the server. Without that step the next
 * comparison would consider absolutely everything changed.
 *
 * @returns {Promise<{failed: Map<string, string>, unstamped: string[]}>}
 */
export async function upload(session, config, logger, rels, local, knownDirs) {
	const failed = new Map();
	const unstamped = [];
	const mkdirs = new Map();
	const counter = rels.length > 100;
	let done = 0;

	// The remote root is created segment by segment with absolute paths — a mkdir relative to the
	// root could not create the root itself. Only needed when the target does not exist yet.
	const ensureRoot = async () => {
		let abs = '';
		for (const part of session.remoteRoot.split('/').filter(Boolean)) {
			abs += `/${part}`;
			await session.mkdirAbs(abs).catch(() => {});
		}
	};

	const ensureDir = (rel) => {
		if (knownDirs.has(rel)) return Promise.resolve();
		let pending = mkdirs.get(rel);
		if (!pending) {
			// mkdir may fail simply because the directory appeared in the meantime, which is fine;
			// a real problem surfaces on the upload anyway.
			pending = rel ? ensureDir(parentOf(rel)).then(() => session.mkdir(rel).catch(() => {})) : ensureRoot();
			mkdirs.set(rel, pending);
		}
		return pending;
	};

	await mapLimit(rels, config.concurrency.io, async (rel) => {
		logger.status(`  upload ${done}/${rels.length}`);
		try {
			await ensureDir(parentOf(rel));
			await session.put(rel, config.root);
			if (config.chmod !== null) await session.chmod(rel, config.chmod);
		} catch (err) {
			failed.set(rel, err.message);
			return;
		}
		// The file is already up there correctly; a failed stamp is not an upload failure.
		if (config.preserveTimestamps) {
			await session.utimes(rel, local.get(rel).mtime).catch(() => unstamped.push(rel));
		}

		done += 1;
		if (!counter) logger.log(`  ↑ ${rel}`);
		else if (done % 100 === 0 || done === rels.length) logger.dim(`  ↑ [${done}/${rels.length}] ${rel}`);
	});

	if (unstamped.length) {
		logger.warn(
			`${unstamped.length}x could not set mtime (file owned by another user) — those are compared against the manifest from now on`,
		);
	}
	return { failed, unstamped };
}

/** Deletes the files and cleans up any directories left empty behind them. */
export async function remove(session, config, logger, rels) {
	const failed = new Map();
	const counter = rels.length > 100;
	let done = 0;

	await mapLimit(rels, config.concurrency.io, async (rel) => {
		logger.status(`  delete ${done}/${rels.length}`);
		try {
			await session.unlink(rel);
			done += 1;
			if (!counter) logger.log(`  ${color.red}✗${color.reset} ${rel}`);
			else if (done % 100 === 0 || done === rels.length) logger.dim(`  ✗ [${done}/${rels.length}] ${rel}`);
		} catch (err) {
			failed.set(rel, err.message);
		}
	});

	// Deepest directories first, so several levels can be cleaned up in one pass.
	const dirs = [...new Set(rels.map(parentOf))]
		.filter(Boolean)
		.sort((a, b) => b.split('/').length - a.split('/').length);

	for (const dir of dirs) {
		let current = dir;
		while (current) {
			const list = await session.readdir(current).catch(() => null);
			if (!list || list.length > 0) break;
			await session.rmdir(current).catch(() => {});
			logger.dim(`  ✗ ${current}/`);
			current = parentOf(current);
		}
	}

	return failed;
}

// ──────────────────────────────────────────────────────────────────────────────
// One full pass
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{uploaded: number, deleted: number, failed: number, files: number, ms: number,
 *   uploads: string[], deletes: string[], upToDate: boolean}>}
 */
export async function reconcile(session, config, logger, opts = {}) {
	const started = Date.now();
	const local = scanLocal(config, logger);
	const manifest = loadManifest(config, logger);

	// Directories from the manifest are scanned too — a file deleted locally along with its whole
	// directory would otherwise never be found on the server, and so never deleted.
	const remote = await scanRemote(session, config, logger, dirsOf([...local.keys(), ...Object.keys(manifest.files)]));
	logger.trace(
		`scan ${config.label}: ${local.size} local · ${remote.dirs.size} remote dirs · ${secs(Date.now() - started)}`,
	);

	const { uploads, blocked, deletes, stale } = diff(local, remote, manifest, config);
	for (const rel of blocked) logger.warn(`${rel}: symlink or directory on the server, skipping`);
	for (const rel of stale) logger.warn(`${rel}: changed on the server, not deleting`);

	if (config.deleteCap !== null && deletes.length > config.deleteCap && !opts.force) {
		for (const rel of deletes.slice(0, 10)) logger.log(`  ✗ ${rel}`);
		if (deletes.length > 10) logger.dim(`  … and ${deletes.length - 10} more`);
		throw new UserError(
			`${deletes.length} files would be deleted (cap ${config.deleteCap})`,
			'Review the list above. If it is right, rerun with --force; raise or disable the cap with "deleteCap".',
		);
	}

	const base = { files: local.size, uploads, deletes, ms: 0 };

	if (uploads.length === 0 && deletes.length === 0) {
		// The manifest is written here too. If it were only written on change, a target that is
		// correct from the start would never establish one and deletion could never work.
		if (!opts.dryRun) saveManifest(config, local, manifest);
		const ms = Date.now() - started;
		logger.ok(`${config.label}: up to date (${local.size} files, ${secs(ms)})`);
		return { ...base, uploaded: 0, deleted: 0, failed: 0, ms, upToDate: true };
	}

	if (opts.dryRun) {
		for (const rel of uploads) logger.log(`  ↑ ${rel}`);
		for (const rel of deletes) logger.log(`  ${color.red}✗${color.reset} ${rel}`);
		const ms = Date.now() - started;
		logger.dim(`  dry run: ${uploads.length} to upload, ${deletes.length} to delete (${secs(ms)})`);
		return { ...base, uploaded: 0, deleted: 0, failed: 0, ms, upToDate: false };
	}

	const uploaded = await upload(session, config, logger, uploads, local, remote.dirs);
	const removeFailed = deletes.length ? await remove(session, config, logger, deletes) : new Map();
	const failed = new Map([...uploaded.failed, ...removeFailed]);

	saveManifest(config, local, manifest, failed, uploaded.unstamped);
	for (const [rel, err] of failed) logger.warn(`${rel}: ${err}`);

	const ms = Date.now() - started;
	const result = {
		...base,
		ms,
		uploaded: uploads.length - uploaded.failed.size,
		deleted: deletes.length - removeFailed.size,
		failed: failed.size,
		upToDate: false,
	};
	const summary = `${config.label}: ${result.uploaded} uploaded · ${result.deleted} deleted · ${secs(ms)}`;
	if (failed.size) throw new UserError(`${failed.size} errors · ${summary}`);
	logger.ok(summary);
	return result;
}

/**
 * The targeted pass used by `watch`. It narrows both the local set and the manifest down to the
 * touched paths and runs exactly the same `diff` as a full pass — only the scope differs, not the
 * rules. The rest of the tree was verified by the pass that ran at startup.
 */
export async function reconcilePaths(session, config, logger, batch) {
	const touched = new Set(batch);
	const local = scanLocal(config, logger);
	const manifest = loadManifest(config, logger);

	const subset = new Map([...local].filter(([rel]) => touched.has(rel)));
	const subFiles = Object.fromEntries(Object.entries(manifest.files).filter(([rel]) => touched.has(rel)));
	if (subset.size === 0 && Object.keys(subFiles).length === 0) return { uploaded: 0, deleted: 0, failed: 0 };

	const remote = await scanRemote(session, config, logger, dirsOf([...subset.keys(), ...Object.keys(subFiles)]));
	const { uploads, blocked, deletes, stale } = diff(
		subset,
		remote,
		{ files: subFiles, unstamped: manifest.unstamped },
		config,
	);
	for (const rel of blocked) logger.warn(`${rel}: symlink or directory on the server, skipping`);
	for (const rel of stale) logger.warn(`${rel}: changed on the server, not deleting`);
	if (uploads.length === 0 && deletes.length === 0) return { uploaded: 0, deleted: 0, failed: 0 };

	const uploaded = await upload(session, config, logger, uploads, local, remote.dirs);
	const removeFailed = deletes.length ? await remove(session, config, logger, deletes) : new Map();
	const failed = new Map([...uploaded.failed, ...removeFailed]);

	updateManifest(config, touched, local, manifest, failed, uploaded.unstamped);
	for (const [rel, err] of failed) logger.warn(`${rel}: ${err}`);

	return {
		uploaded: uploads.length - uploaded.failed.size,
		deleted: deletes.length - removeFailed.size,
		failed: failed.size,
		uploads,
		deletes,
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Orphans
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Files that were removed locally before this tool was in place stayed on the server, and the
 * manifest knows nothing about them, so regular deletion never finds them. This tracks them down.
 *
 * They are never removed automatically: a server also holds files that never existed locally and
 * are supposed to stay (uploads, caches, deploy scripts). So they are listed, and only deleted on
 * an explicit --force.
 */
export async function prune(session, config, logger, opts = {}) {
	const local = scanLocal(config, logger);
	const manifest = loadManifest(config, logger);
	const found = await walkRemote(session, config, logger);

	const orphans = found.filter((rel) => !local.has(rel) && !Object.hasOwn(manifest.files, rel)).sort();

	if (orphans.length === 0) {
		logger.ok('no orphans on the server');
		return { orphans: [], deleted: 0 };
	}
	for (const rel of orphans) logger.log(`  ? ${rel}`);

	if (!opts.force || opts.dryRun) {
		logger.dim(`  ${orphans.length} files on the server that neither the local project nor the manifest knows about`);
		logger.dim('  Review the list, then remove them with: ftporter prune --force');
		return { orphans, deleted: 0 };
	}

	const failed = await remove(session, config, logger, orphans);
	for (const [rel, err] of failed) logger.warn(`${rel}: ${err}`);
	const deleted = orphans.length - failed.size;
	logger.ok(`${deleted} orphans deleted`);
	return { orphans, deleted };
}

/**
 * Walks the server breadth-first and returns every regular file that could be a candidate. Unlike
 * `scanRemote` it does not start from the local list — otherwise a directory deleted locally along
 * with its contents would never be found, which is the very case this exists for.
 *
 * Excluded directories are not descended into, and with the git strategy anything .gitignore would
 * hide is skipped too — that is what protects the server's own build output and .env.
 */
async function walkRemote(session, config, logger) {
	const isExcluded = matcher([...config.exclude, ...(config.pruneSkip ?? ['.git', 'node_modules', 'vendor'])]);
	const files = [];
	let level = [''];
	let scanned = 0;

	while (level.length > 0) {
		const found = new Map();
		await mapLimit(level, config.concurrency.scan, async (dir) => {
			const list = await session.readdir(dir).catch(() => null);
			scanned += 1;
			logger.status(`  server walk ${scanned} dirs`);
			if (!list) return;
			for (const item of list) {
				// Symlinks are never followed nor offered for deletion — they routinely point at data
				// stores outside the synchronised root.
				if (item.longname.startsWith('l')) continue;
				const rel = dir ? `${dir}/${item.filename}` : item.filename;
				if (!isExcluded(rel)) found.set(rel, item.longname.startsWith('d'));
			}
		});

		// One `git check-ignore` call per level instead of one per file.
		const ignored = config.strategy === 'git' ? ignoredByGit(config.root, [...found.keys()]) : new Set();
		const next = [];
		for (const [rel, isDir] of found) {
			if (ignored.has(rel)) continue;
			if (isDir) next.push(rel);
			else files.push(rel);
		}
		level = next;
	}

	return files;
}
