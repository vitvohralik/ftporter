import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { prune, reconcile, reconcilePaths } from '../src/engine.mjs';
import { runHook } from '../src/hooks.mjs';
import { makeFixture, logger } from './helpers.mjs';

const run = (fx, opts = {}) => reconcile(fx.session, fx.config, logger, opts);

describe('sync', () => {
	it('uploads the whole tree, then reports up to date', async () => {
		const fx = await makeFixture({
			files: { 'index.php': '<?php echo 1;', 'css/site.css': 'body{}', 'deep/a/b/c.txt': 'x' },
			config: { strategy: 'blacklist' },
		});
		after(() => fx.cleanup());

		const first = await run(fx);
		assert.equal(first.uploaded, 3);
		assert.deepEqual(fx.remoteList(), ['css/site.css', 'deep/a/b/c.txt', 'index.php']);
		assert.equal(fx.remoteRead('index.php'), '<?php echo 1;');

		const second = await run(fx);
		assert.equal(second.upToDate, true);
		assert.equal(second.uploaded, 0);
	});

	it('uploads a changed file and preserves its mtime', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.write('a.txt', 'two');
		const result = await run(fx);

		assert.equal(result.uploaded, 1);
		assert.equal(fx.remoteRead('a.txt'), 'two');

		const localMtime = fs.statSync(path.join(fx.local, 'a.txt')).mtimeMs;
		const remoteMtime = fs.statSync(path.join(fx.remote, 'a.txt')).mtimeMs;
		assert.ok(Math.abs(localMtime - remoteMtime) < 2000, 'remote mtime is stamped from the local one');

		assert.equal((await run(fx)).upToDate, true);
	});

	it('deletes what disappeared locally and cleans up empty directories', async () => {
		const fx = await makeFixture({
			files: { 'keep.txt': 'k', 'gone/one.txt': '1', 'gone/two.txt': '2' },
			config: { strategy: 'blacklist' },
		});
		after(() => fx.cleanup());

		await run(fx);
		fx.remove('gone');
		const result = await run(fx);

		assert.equal(result.deleted, 2);
		assert.deepEqual(fx.remoteList(), ['keep.txt']);
		assert.equal(fs.existsSync(path.join(fx.remote, 'gone')), false, 'the empty directory is gone too');
	});

	it('never deletes a file it did not upload itself', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.remoteWrite('server-only.php', 'runtime file');
		fx.write('b.txt', 'b');
		await run(fx);

		assert.ok(fx.remoteExists('server-only.php'), 'a file the tool never uploaded stays put');
	});

	it('refuses to delete a file that changed on the server', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a', 'b.txt': 'b' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.remoteWrite('b.txt', 'edited on the server');
		fx.remove('b.txt');
		const result = await run(fx);

		assert.equal(result.deleted, 0);
		assert.ok(fx.remoteExists('b.txt'));
	});

	it('stops at the delete cap unless forced', async () => {
		const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, String(i)]));
		const fx = await makeFixture({ files, config: { strategy: 'blacklist', deleteCap: 3 } });
		after(() => fx.cleanup());

		await run(fx);
		for (const rel of Object.keys(files)) fx.remove(rel);

		await assert.rejects(run(fx), /would be deleted \(cap 3\)/);
		assert.equal(fx.remoteList().length, 6, 'nothing was touched');

		const forced = await run(fx, { force: true });
		assert.equal(forced.deleted, 6);
	});

	it('changes nothing on a dry run', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		const result = await run(fx, { dryRun: true });
		assert.deepEqual(result.uploads, ['a.txt']);
		assert.deepEqual(fx.remoteList(), []);
	});

	it('honours delete: false', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist', delete: false } });
		after(() => fx.cleanup());

		await run(fx);
		fx.remove('a.txt');
		const result = await run(fx);

		assert.equal(result.deleted, 0);
		assert.ok(fx.remoteExists('a.txt'));
	});

	it('falls back to the manifest for files whose timestamp cannot be set', async () => {
		// The server refuses to stamp this path, the way a file owned by another uid behaves.
		// Without the manifest fallback it would be re-uploaded on every single run.
		const fx = await makeFixture({
			files: { 'shared/locked.txt': 'v1', 'normal.txt': 'n' },
			config: { strategy: 'blacklist' },
			noTimestampPaths: ['shared/locked.txt'],
		});
		after(() => fx.cleanup());

		assert.equal((await run(fx)).uploaded, 2);
		assert.equal((await run(fx)).upToDate, true, 'the unstamped file is not uploaded again');

		fx.write('shared/locked.txt', 'v2 is longer');
		assert.equal((await run(fx)).uploaded, 1, 'but a real local change still goes up');
		assert.equal(fx.remoteRead('shared/locked.txt'), 'v2 is longer');
	});

	it('survives a dropped connection by reconnecting', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.session.conn.end(); // the server went away mid-session
		fx.write('b.txt', 'b');

		const result = await run(fx);
		assert.equal(result.uploaded, 1);
		assert.equal(fx.remoteRead('b.txt'), 'b');
	});

	it('uploads only the touched paths in a watch batch', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a', 'b.txt': 'b' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.write('a.txt', 'changed');
		fx.write('c.txt', 'new');

		const result = await reconcilePaths(fx.session, fx.config, logger, ['a.txt', 'c.txt']);
		assert.equal(result.uploaded, 2);
		assert.equal(fx.remoteRead('c.txt'), 'new');

		// The batch must not have dropped b.txt from the manifest — deleting it still has to work.
		fx.remove('b.txt');
		assert.equal((await run(fx)).deleted, 1);
	});

	it('deletes through a watch batch as well', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a', 'b.txt': 'b' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.remove('b.txt');
		const result = await reconcilePaths(fx.session, fx.config, logger, ['b.txt']);

		assert.equal(result.deleted, 1);
		assert.deepEqual(fx.remoteList(), ['a.txt']);
	});

	it('runs hooks around the sync and hands them the outcome', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a' },
			config: {
				strategy: 'blacklist',
				exclude: ['hook-*.txt'],
				hooks: {
					beforeSync: 'echo before > hook-before.txt',
					afterSync: 'echo "$FTPORTER_UPLOADED" > hook-after.txt',
				},
			},
		});
		after(() => fx.cleanup());

		await runHook('beforeSync', fx.config, logger);
		const result = await run(fx);
		await runHook('afterSync', fx.config, logger, result);

		assert.equal(fs.readFileSync(path.join(fx.local, 'hook-before.txt'), 'utf8').trim(), 'before');
		assert.equal(fs.readFileSync(path.join(fx.local, 'hook-after.txt'), 'utf8').trim(), '1');
	});

	it('aborts when beforeSync fails', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a' },
			config: { strategy: 'blacklist', hooks: { beforeSync: 'exit 3' } },
		});
		after(() => fx.cleanup());

		await assert.rejects(runHook('beforeSync', fx.config, logger), /hook beforeSync failed \(exit 3\)/);
	});

	it('applies chmod when configured', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist', chmod: '640' } });
		after(() => fx.cleanup());

		await run(fx);
		assert.equal(fs.statSync(path.join(fx.remote, 'a.txt')).mode & 0o777, 0o640);
	});
});

describe('prune', () => {
	it('lists orphans and removes them only with force', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.remoteWrite('old/forgotten.txt', 'left behind');

		const listed = await prune(fx.session, fx.config, logger, {});
		assert.deepEqual(listed.orphans, ['old/forgotten.txt']);
		assert.ok(fx.remoteExists('old/forgotten.txt'), 'listing alone never deletes');

		const removed = await prune(fx.session, fx.config, logger, { force: true });
		assert.equal(removed.deleted, 1);
		assert.equal(fx.remoteExists('old/forgotten.txt'), false);
	});
});
