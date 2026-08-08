import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_IGNORED } from './config.mjs';
import { matcher } from './match.mjs';
import { toPosix, UserError } from './util.mjs';

/**
 * Decides what is supposed to be on the server.
 *
 * Three strategies, all of them ending in the same shape — Map<relative path, {size, mtime}>:
 *
 *   git        `git ls-files --cached --others --exclude-standard`, so .gitignore is the rule.
 *              New files are picked up without a commit (`--others`) and deleted ones drop out,
 *              because every path is verified with lstat.
 *   whitelist  only the paths in `include` (a directory is walked recursively).
 *   blacklist  everything under the root except `exclude` and the always-ignored directories.
 *
 * `include` and `exclude` are applied on top of every strategy, and **exclude always wins** — the
 * more restrictive rule takes precedence, so nothing explicitly forbidden is uploaded by accident.
 */
export function scanLocal(config, logger) {
	logger.status(`  scanning ${config.label}…`);

	const isExcluded = matcher(config.exclude);
	const inRoots = config.roots?.length ? matcher(config.roots) : null;

	let candidates;
	switch (config.strategy) {
		case 'git':
			candidates = gitFiles(config, logger);
			break;
		case 'whitelist':
			candidates = [];
			break;
		case 'blacklist':
			candidates = [...walk(config, '', isExcluded)];
			break;
		default:
			throw new UserError(`unknown strategy '${config.strategy}'`);
	}

	// include is additive in every strategy — it is the whole list for a whitelist, and an override
	// for paths the strategy cannot see (gitignored build output, for instance) in the others.
	for (const rel of config.include) {
		if (rel.startsWith('!')) continue;
		candidates = candidates.concat([...expand(config, rel, isExcluded, logger)]);
	}
	if (config.roots?.length && config.strategy !== 'whitelist') {
		for (const rel of config.roots) candidates = candidates.concat([...expand(config, rel, isExcluded, logger)]);
	}

	// The config file itself is never uploaded — it may hold a password, and it is meaningless on
	// the server either way.
	const configRel = config.configFile ? toPosix(path.relative(config.root, config.configFile)) : null;

	const files = new Map();
	for (const rel of candidates) {
		if (rel === configRel || isExcluded(rel)) continue;
		if (inRoots && !inRoots(rel)) continue;
		const st = statFile(path.join(config.root, rel), config.followSymlinks);
		if (st) files.set(rel, { size: st.size, mtime: st.mtimeMs });
	}
	return files;
}

export function isGitRepo(root) {
	try {
		execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function gitFiles(config, logger) {
	if (!isGitRepo(config.root)) {
		logger.warn(
			`${config.root} is not a git repository — falling back to strategy "blacklist" (everything except "exclude")`,
		);
		return [...walk(config, '', matcher(config.exclude))];
	}
	const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
		cwd: config.root,
		maxBuffer: 1 << 28,
	});
	return out.toString('utf8').split('\0').filter(Boolean);
}

/** lstat that quietly returns null for anything that is not a regular file (dir, socket, gone). */
export function statFile(abs, followSymlinks = false) {
	try {
		const st = followSymlinks ? fs.statSync(abs) : fs.lstatSync(abs);
		return st.isFile() ? st : null;
	} catch {
		return null;
	}
}

/** A path from `include` may be a file or a directory; a directory is walked recursively. */
function* expand(config, rel, isExcluded, logger) {
	const abs = path.join(config.root, rel);
	let st;
	try {
		st = fs.statSync(abs);
	} catch {
		logger.warn(`include path '${rel}' does not exist`);
		return;
	}
	if (st.isDirectory()) yield* walk(config, rel, isExcluded);
	else yield rel;
}

const alwaysIgnored = matcher(DEFAULT_IGNORED);

/** Depth-first walk of `rel`, pruning excluded directories so big trees are never descended into. */
function* walk(config, rel, isExcluded) {
	let entries;
	try {
		entries = fs.readdirSync(path.join(config.root, rel || '.'), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const child = rel ? `${rel}/${entry.name}` : toPosix(entry.name);
		if (alwaysIgnored(child) || isExcluded(child)) continue;
		if (entry.isDirectory()) yield* walk(config, child, isExcluded);
		else if (entry.isFile()) yield child;
		else if (entry.isSymbolicLink() && config.followSymlinks) yield child;
	}
}

/** Which of those paths git would ignore — used by `prune` so the server's own files stay put. */
export function ignoredByGit(root, paths) {
	if (paths.length === 0 || !isGitRepo(root)) return new Set();
	let out;
	try {
		out = execFileSync('git', ['check-ignore', '--stdin', '-z', '--no-index'], {
			cwd: root,
			input: `${paths.join('\0')}\0`,
			maxBuffer: 1 << 28,
			stdio: ['pipe', 'pipe', 'ignore'],
		});
	} catch (err) {
		// check-ignore exits 1 when nothing matches — an empty result, not an error.
		if (err.status !== 1) throw err;
		out = err.stdout ?? '';
	}
	return new Set(out.toString('utf8').split('\0').filter(Boolean));
}
