import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { prune, reconcile, reconcilePaths } from '../src/engine.mjs';
import { TEMP_PREFIX } from '../src/session.mjs';
import { logger, makeFixture } from './helpers.mjs';

describe('ftp', () => {
	it('uploads a tree and leaves it alone on the next pass', async () => {
		const files = { 'index.php': '<?php', 'css/site.css': 'body{}' };
		// More files than the connection pool holds, so the pool has to hand connections around.
		for (let i = 0; i < 20; i++) files[`assets/f${i}.txt`] = `file ${i}`;

		const fx = await makeFixture({ protocol: 'ftp', files });
		after(() => fx.cleanup());

		const first = await reconcile(fx.session, fx.config, logger);
		assert.equal(first.uploaded, 22);
		assert.deepEqual(fx.remoteList(), Object.keys(files).sort());
		assert.equal(fx.remoteRead('css/site.css'), 'body{}');

		const second = await reconcile(fx.session, fx.config, logger);
		assert.equal(second.upToDate, true, 'nothing to do the second time');
	});

	it('uploads changes and deletions, and cleans the directory up behind them', async () => {
		const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'one', 'old/b.txt': 'two' } });
		after(() => fx.cleanup());
		await reconcile(fx.session, fx.config, logger);

		fx.write('a.txt', 'changed');
		fx.remove('old');
		const result = await reconcile(fx.session, fx.config, logger);

		assert.equal(result.uploaded, 1);
		assert.equal(result.deleted, 1);
		assert.equal(fx.remoteRead('a.txt'), 'changed');
		assert.equal(fx.remoteExists('old'), false, 'the emptied directory is gone too');
	});

	it('uploads through a temporary file and renames it over the target', async () => {
		const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'first' } });
		after(() => fx.cleanup());
		await reconcile(fx.session, fx.config, logger);

		fx.write('a.txt', 'second');
		await reconcile(fx.session, fx.config, logger);

		assert.equal(fx.remoteRead('a.txt'), 'second');
		assert.deepEqual(fx.remoteList(), ['a.txt'], 'no temporary file left behind');
	});

	it('finds leftover temporary files with prune --temp', async () => {
		const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'one' } });
		after(() => fx.cleanup());
		await reconcile(fx.session, fx.config, logger);
		fx.remoteWrite(`${TEMP_PREFIX}a.txt.abc123`, 'interrupted');

		const result = await prune(fx.session, fx.config, logger, { temp: true, force: true });
		assert.equal(result.deleted, 1);
		assert.deepEqual(fx.remoteList(), ['a.txt']);
	});

	it('uploads only the touched paths in a watch batch', async () => {
		const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'a', 'b.txt': 'b' } });
		after(() => fx.cleanup());
		await reconcile(fx.session, fx.config, logger);

		fx.write('a.txt', 'changed');
		fx.write('b.txt', 'changed too');
		const result = await reconcilePaths(fx.session, fx.config, logger, ['a.txt']);

		assert.equal(result.uploaded, 1);
		assert.equal(fx.remoteRead('a.txt'), 'changed');
		assert.equal(fx.remoteRead('b.txt'), 'b', 'the untouched path stays as it was');
	});

	it('reconnects after the server drops the connection', async () => {
		const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'a' } });
		after(() => fx.cleanup());
		await reconcile(fx.session, fx.config, logger);

		fx.server.dropConnections();
		fx.write('a.txt', 'after the drop');
		const result = await reconcile(fx.session, fx.config, logger);

		assert.equal(result.uploaded, 1);
		assert.equal(fx.remoteRead('a.txt'), 'after the drop');
	});

	it('applies chmod through SITE CHMOD', async () => {
		const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'a' }, config: { chmod: '640' } });
		after(() => fx.cleanup());
		await reconcile(fx.session, fx.config, logger);

		const { mode } = (await import('node:fs')).statSync(`${fx.remote}/a.txt`);
		assert.equal(mode & 0o777, 0o640);
	});

	it('carries on when the server has no SITE CHMOD', async () => {
		const fx = await makeFixture({
			protocol: 'ftp',
			files: { 'a.txt': 'a' },
			config: { chmod: '640' },
			server: { chmod: false },
		});
		after(() => fx.cleanup());

		const result = await reconcile(fx.session, fx.config, logger);
		assert.equal(result.uploaded, 1, 'the file still gets there');
		assert.equal(fx.session.canChmod, false, 'and the session stops asking');
	});

	describe('servers that cannot keep timestamps', () => {
		for (const missing of ['mfmt', 'mlsd']) {
			it(`falls back to the manifest without ${missing.toUpperCase()}`, async () => {
				const fx = await makeFixture({
					protocol: 'ftp',
					files: { 'a.txt': 'one' },
					server: { [missing]: false },
				});
				after(() => fx.cleanup());

				assert.equal(fx.session.canStamp, false);
				assert.equal((await reconcile(fx.session, fx.config, logger)).uploaded, 1);
				assert.equal((await reconcile(fx.session, fx.config, logger)).upToDate, true, 'no endless re-uploading');

				fx.write('a.txt', 'a longer body');
				assert.equal((await reconcile(fx.session, fx.config, logger)).uploaded, 1, 'a real change still goes up');
			});
		}
	});

	describe('TLS', () => {
		it('upgrades a plain ftp connection when the server offers TLS', async () => {
			const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'a' }, server: { tls: true } });
			after(() => fx.cleanup());

			assert.equal(fx.session.secure, true);
			assert.equal((await reconcile(fx.session, fx.config, logger)).uploaded, 1);
		});

		it('stays plain when the server offers nothing', async () => {
			const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'a' } });
			after(() => fx.cleanup());

			assert.equal(fx.session.secure, false);
			assert.equal((await reconcile(fx.session, fx.config, logger)).uploaded, 1);
		});

		it('syncs over required explicit TLS', async () => {
			const fx = await makeFixture({ protocol: 'ftps', files: { 'a.txt': 'a', 'sub/b.txt': 'b' } });
			after(() => fx.cleanup());

			assert.equal(fx.session.secure, true);
			assert.equal((await reconcile(fx.session, fx.config, logger)).uploaded, 2);
			assert.equal(fx.remoteRead('sub/b.txt'), 'b');
		});

		it('syncs over implicit TLS', async () => {
			const fx = await makeFixture({ protocol: 'ftps-implicit', files: { 'a.txt': 'a' } });
			after(() => fx.cleanup());

			assert.equal(fx.session.secure, true);
			assert.equal((await reconcile(fx.session, fx.config, logger)).uploaded, 1);
		});

		it('refuses to fall back to plain FTP when ftps was asked for', async () => {
			await assert.rejects(
				() => makeFixture({ protocol: 'ftps', files: { 'a.txt': 'a' }, server: { tls: false } }),
				(err) => {
					assert.match(err.message, /cannot connect/);
					assert.match(err.hint, /did not accept AUTH TLS/);
					return true;
				},
			);
		});
	});

	it('reports a wrong password as a connection error', async () => {
		await assert.rejects(
			() => makeFixture({ protocol: 'ftp', files: { 'a.txt': 'a' }, server: { password: 'other' } }),
			(err) => {
				assert.match(err.message, /cannot connect/);
				assert.match(err.hint, /username and password/);
				return true;
			},
		);
	});

	it('keys the manifest by protocol, so the same host over FTP and SFTP stay apart', async () => {
		const fx = await makeFixture({ protocol: 'ftp', files: { 'a.txt': 'a' } });
		after(() => fx.cleanup());
		assert.match(fx.config.target, /^ftp:\/\/tester@127\.0\.0\.1:\/site$/);

		const sftp = await loadConfig({ config: fx.configFile, protocol: 'sftp' }, { cwd: fx.local, env: {} });
		assert.equal(sftp.target, 'tester@127.0.0.1:/site');
	});
});
