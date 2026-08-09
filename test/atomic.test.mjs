import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { reconcile } from '../src/engine.mjs';
import { parseArgs } from '../src/cli.mjs';
import { TEMP_PREFIX } from '../src/sftp.mjs';
import { makeFixture, logger } from './helpers.mjs';

const run = (fx, opts = {}) => reconcile(fx.session, fx.config, logger, opts);

/** Records every remote path handed to fastPut, so we can tell a temp target from a direct one. */
function recordPuts(session) {
	const paths = [];
	const original = session.sftp.fastPut.bind(session.sftp);
	session.sftp.fastPut = (local, remote, ...rest) => {
		paths.push(remote);
		return original(local, remote, ...rest);
	};
	return paths;
}

describe('atomic upload', () => {
	it('writes to a temporary sibling and renames it over the target', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		const puts = recordPuts(fx.session);
		await run(fx);

		assert.equal(puts.length, 1);
		assert.equal(path.posix.dirname(puts[0]), '/site', 'the temp sits next to the target, not elsewhere');
		assert.ok(
			path.posix.basename(puts[0]).startsWith(`${TEMP_PREFIX}a.txt.`),
			`temp is named after the target, got ${puts[0]}`,
		);

		assert.deepEqual(fx.remoteList(), ['a.txt'], 'no temp file left behind');
		assert.equal(fx.remoteRead('a.txt'), 'one');
	});

	it('leaves the previous file untouched when the upload fails', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'new' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		fx.remoteWrite('a.txt', 'old');
		// Fail after the bytes are on the server but before the rename, the worst possible moment.
		fx.session.sftp.utimes = (_p, _a, _m, cb) => cb(new Error('boom'));
		fx.session.sftp.rename = (_f, _t, cb) => cb(new Error('boom'));

		const result = await run(fx);

		assert.equal(result.uploaded, 0, 'the upload is reported as failed');
		assert.equal(fx.remoteRead('a.txt'), 'old', 'the old file is still intact and complete');
		assert.deepEqual(fx.remoteList(), ['a.txt'], 'the temp file was cleaned up');
	});

	it('uses posix-rename when the server offers it', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		// The in-process server advertises no extensions, so stand one in: an atomic overwrite that
		// never unlinks the target.
		fx.session.sftp._extensions = { 'posix-rename@openssh.com': '1' };
		let used = 0;
		fx.session.sftp.ext_openssh_rename = (from, to, cb) => {
			used += 1;
			try {
				fs.renameSync(path.join(fx.remote, path.relative('/site', from)), path.join(fx.remote, path.relative('/site', to)));
				cb();
			} catch (err) {
				cb(err);
			}
		};

		await run(fx);

		assert.equal(used, 1, 'the extension was used');
		assert.equal(fx.session.posixRename, true, 'and remembered for the rest of the session');
		assert.equal(fx.remoteRead('a.txt'), 'one');
	});

	it('falls back to unlink + rename on a server without the extension', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);

		assert.equal(fx.session.posixRename, false, 'the missing extension is remembered, not retried');
		assert.equal(fx.remoteRead('a.txt'), 'one');

		fx.write('a.txt', 'two');
		assert.equal((await run(fx)).uploaded, 1, 'overwriting an existing file works through the fallback');
		assert.equal(fx.remoteRead('a.txt'), 'two');
	});

	it('still stamps the mtime and the mode, set before the rename', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist', chmod: '640' } });
		after(() => fx.cleanup());

		await run(fx);

		const local = fs.statSync(path.join(fx.local, 'a.txt'));
		const remote = fs.statSync(path.join(fx.remote, 'a.txt'));
		assert.ok(Math.abs(local.mtimeMs - remote.mtimeMs) < 2000, 'mtime survives the rename');
		assert.equal(remote.mode & 0o777, 0o640, 'mode survives the rename');

		assert.equal((await run(fx)).upToDate, true, 'and the next run sees nothing to do');
	});

	it('writes straight to the target when turned off', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'one' },
			config: { strategy: 'blacklist', atomicUpload: false },
		});
		after(() => fx.cleanup());

		const puts = recordPuts(fx.session);
		await run(fx);

		assert.equal(puts.length, 1);
		assert.ok(!puts[0].includes(TEMP_PREFIX), `bytes went straight to the target, got ${puts[0]}`);
		assert.equal(puts[0], '/site/a.txt');
		assert.equal(fx.remoteRead('a.txt'), 'one');
	});
});

describe('state file under concurrency', () => {
	it('keeps every writer\'s section when instances run side by side', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		const stateFile = fx.config.stateFile;
		const script = path.join(fx.base, 'writer.mjs');
		fs.writeFileSync(
			script,
			`import { saveManifest, emptyManifest } from '${path.resolve('src/state.mjs')}';
			const [profile, target] = process.argv.slice(2);
			// A manifest the size of a real project — small payloads finish inside a single scheduler
			// slice and the race never shows up.
			for (let i = 0; i < 30; i++) {
				const local = new Map();
				for (let f = 0; f < 2000; f++) local.set(profile + '/' + f + '.txt', { size: f, mtime: 1000 + f });
				saveManifest({ stateFile: ${JSON.stringify(stateFile)}, target, profileName: profile, delete: true }, local, emptyManifest());
			}`,
		);

		// While they write, keep reading: a reader must never catch the file half-written.
		let reads = 0;
		let corrupt = 0;
		let reading = true;
		const reader = (async () => {
			while (reading) {
				try {
					const raw = fs.readFileSync(stateFile, 'utf8');
					reads += 1;
					JSON.parse(raw);
				} catch (err) {
					if (err instanceof SyntaxError) corrupt += 1;
				}
				await new Promise((r) => setImmediate(r));
			}
		})();

		// Four processes hammering one file at the same time: two profiles against one target, two
		// against another. Spawned, not exec'd in sequence — the race is the point of the test.
		await Promise.all(
			[
				['assets', 'u@h:/a'],
				['default', 'u@h:/a'],
				['assets', 'u@h:/b'],
				['default', 'u@h:/b'],
			].map(
				([profile, target]) =>
					new Promise((resolve, reject) => {
						const child = spawn(process.execPath, [script, profile, target], { stdio: 'inherit' });
						child.on('error', reject);
						child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
					}),
			),
		);

		reading = false;
		await reader;
		assert.ok(reads > 5, `the reader actually observed the file mid-flight (${reads} reads)`);
		assert.equal(corrupt, 0, 'no reader ever saw a half-written state file');

		const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
		for (const target of ['u@h:/a', 'u@h:/b']) {
			for (const profile of ['assets', 'default']) {
				const section = state.targets[target]?.[profile];
				assert.ok(section, `${target} / ${profile} survived`);
				assert.equal(Object.keys(section.files).length, 2000, 'and holds a complete last write');
			}
		}
		assert.deepEqual(
			fs.readdirSync(path.dirname(stateFile)).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')),
			[],
			'no temp or lock files left behind',
		);
	});
});

describe('--no-atomic', () => {
	it('turns the temporary file off for one run', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		assert.equal(fx.config.atomicUpload, true, 'on by default');
		const cli = await fx.reload({ atomicUpload: false });
		assert.equal(cli.atomicUpload, false, 'and off for a run that asks');
	});
});

describe('repeated value flags', () => {
	it('refuses two profiles instead of quietly using the last', () => {
		assert.throws(() => parseArgs(['prune', '-p', 'node', '-p', 'vendor']), /given twice/);
		assert.equal(parseArgs(['prune', '-p', 'node']).profile, 'node');
	});
});

