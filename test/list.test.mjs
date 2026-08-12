import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { listRemote, reconcile } from '../src/engine.mjs';
import { formatBytes, formatStamp } from '../src/util.mjs';
import { logger, makeFixture } from './helpers.mjs';

/** A project already on the server, which is the state anyone listing one is in. */
const uploaded = async (files) => {
	const fx = await makeFixture({ files, config: { strategy: 'blacklist' } });
	await reconcile(fx.session, fx.config, logger);
	return fx;
};

describe('list', () => {
	it('lists the remote root, directories first', async () => {
		const fx = await uploaded({ 'index.php': '<?php', 'app/main.js': 'x', 'README.md': 'y' });
		after(() => fx.cleanup());

		const result = await listRemote(fx.session, fx.config, logger);

		assert.equal(result.path, '/site');
		assert.deepEqual(
			result.entries.map((entry) => entry.name),
			['app', 'index.php', 'README.md'],
			'directories first, then files, each alphabetically and regardless of case',
		);
		assert.equal(result.entries[0].dir, true);
		assert.equal(result.dirs, 1);
		assert.equal(result.files, 2);
		assert.equal(result.bytes, 6, 'only files are counted');
	});

	it('takes a relative path from the remote root', async () => {
		const fx = await uploaded({ 'public/css/site.css': 'body{}', 'public/app.js': 'x' });
		after(() => fx.cleanup());

		const result = await listRemote(fx.session, fx.config, logger, { path: 'public' });

		assert.equal(result.path, '/site/public');
		assert.deepEqual(
			result.entries.map((entry) => entry.name),
			['css', 'app.js'],
		);

		// A trailing slash and a leading ./ are how people type a path, not a different path.
		for (const path of ['public/', './public']) {
			assert.equal((await listRemote(fx.session, fx.config, logger, { path })).path, '/site/public');
		}
	});

	it('takes an absolute path outside the remote root', async () => {
		const fx = await uploaded({ 'a.txt': 'a' });
		after(() => fx.cleanup());

		const result = await listRemote(fx.session, fx.config, logger, { path: '/' });
		assert.equal(result.path, '/');
		assert.ok(
			result.entries.some((entry) => entry.name === 'site' && entry.dir),
			'the remote root is visible from above it',
		);
	});

	it('says where it looked when the directory is not there', async () => {
		const fx = await uploaded({ 'a.txt': 'a' });
		after(() => fx.cleanup());

		await assert.rejects(() => listRemote(fx.session, fx.config, logger, { path: 'nope' }), (err) => {
			assert.match(err.message, /no such directory on the server: \/site\/nope/);
			assert.match(err.hint, /taken from the remote root/, 'and explains how paths are read');
			return true;
		});

		// An absolute path was not a misunderstanding about the root, so it gets no such hint.
		await assert.rejects(() => listRemote(fx.session, fx.config, logger, { path: '/nowhere' }), (err) => {
			assert.equal(err.hint, undefined);
			return true;
		});
	});

	it('reports an empty directory as empty rather than as nothing', async () => {
		const fx = await uploaded({ 'a.txt': 'a' });
		after(() => fx.cleanup());
		const printed = [];
		const recorder = { ...logger, log: (msg) => printed.push(msg), dim: (msg) => printed.push(msg) };

		await fx.session.mkdir('empty');
		const result = await listRemote(fx.session, fx.config, recorder, { path: 'empty' });

		assert.equal(result.entries.length, 0);
		assert.ok(printed.some((line) => line.includes('(empty)')));
		assert.ok(printed.some((line) => /0 directories · 0 files/.test(line)));
	});

	it('works the same over FTP', async () => {
		const fx = await makeFixture({
			protocol: 'ftp',
			files: { 'index.php': '<?php', 'app/main.js': 'x' },
			config: { strategy: 'blacklist' },
		});
		after(() => fx.cleanup());
		await reconcile(fx.session, fx.config, logger);

		const result = await listRemote(fx.session, fx.config, logger);
		assert.deepEqual(
			result.entries.map((entry) => entry.name),
			['app', 'index.php'],
		);
		assert.equal(result.entries[0].dir, true, 'a directory is recognised through an FTP listing too');
	});
});

describe('formatting', () => {
	it('scales sizes and keeps bytes exact', () => {
		assert.equal(formatBytes(0), '0 B');
		assert.equal(formatBytes(999), '999 B');
		assert.equal(formatBytes(1024), '1.0 KB');
		assert.equal(formatBytes(1536), '1.5 KB');
		assert.equal(formatBytes(10 * 1024), '10 KB');
		assert.equal(formatBytes(1024 ** 3), '1.0 GB');
	});

	it('shows a dash where the server gave no time at all', () => {
		assert.equal(formatStamp(0), '—');
		assert.match(formatStamp(Date.UTC(2026, 0, 2, 3, 4)), /^2026-01-0[12] \d\d:\d\d$/);
	});
});
