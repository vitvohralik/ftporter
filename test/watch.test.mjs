import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { runWatch } from '../src/watch.mjs';
import { makeFixture, logger } from './helpers.mjs';

/** Waits for a condition, polling — filesystem events and timers are inherently asynchronous. */
async function eventually(check, { timeout = 8000, step = 50 } = {}) {
	const deadline = Date.now() + timeout;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error('condition never became true');
		await new Promise((r) => setTimeout(r, step));
	}
}

const stop = () => process.emit('SIGINT');

describe('watch', () => {
	it('uploads a new file, an edit and a deletion as they happen', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a' },
			config: { strategy: 'blacklist', watch: { debounce: 50, ignored: [] } },
		});
		after(() => fx.cleanup());

		const running = runWatch(fx.session, fx.config, logger, { useWatcher: true });
		await eventually(() => fx.remoteExists('a.txt'));

		fx.write('b/new.txt', 'created');
		await eventually(() => fx.remoteExists('b/new.txt'));
		assert.equal(fx.remoteRead('b/new.txt'), 'created');

		fx.write('a.txt', 'edited, and longer');
		await eventually(() => fx.remoteRead('a.txt') === 'edited, and longer');

		fx.remove('b/new.txt');
		await eventually(() => !fx.remoteExists('b/new.txt'));

		stop();
		await running;
	});

	it('catches a file written during the very first pass', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a' },
			config: { strategy: 'blacklist', watch: { debounce: 50, ignored: [] } },
		});
		after(() => fx.cleanup());

		// `afterSync` fires inside the initial pass, once the tree has already been scanned — exactly
		// the window where the watcher used not to be listening yet.
		let written = false;
		fx.config.hooks = {
			afterSync: () => {
				if (written) return;
				written = true;
				fx.write('slipped-in.txt', 'late');
			},
		};

		const running = runWatch(fx.session, fx.config, logger, { useWatcher: true });
		await eventually(() => fx.remoteExists('slipped-in.txt'));
		assert.equal(fx.remoteRead('slipped-in.txt'), 'late');

		stop();
		await running;
	});

	it('ignores what the watch ignore list covers', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a' },
			config: { strategy: 'blacklist', exclude: ['cache'], watch: { debounce: 50, ignored: [] } },
		});
		after(() => fx.cleanup());

		const running = runWatch(fx.session, fx.config, logger, { useWatcher: true });
		await eventually(() => fx.remoteExists('a.txt'));

		fx.write('cache/tmp.txt', 'noise');
		fx.write('later.txt', 'real');
		await eventually(() => fx.remoteExists('later.txt'));

		assert.equal(fx.remoteExists('cache/tmp.txt'), false);

		stop();
		await running;
	});
});

describe('patrol', () => {
	it('picks changes up on the timer with no watcher at all', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a' },
			config: { strategy: 'blacklist', watch: { interval: '1s', debounce: 20 } },
		});
		after(() => fx.cleanup());

		const running = runWatch(fx.session, fx.config, logger, { useWatcher: false });
		await eventually(() => fx.remoteExists('a.txt'));

		fx.write('appeared-quietly.txt', 'x');
		await eventually(() => fx.remoteExists('appeared-quietly.txt'), { timeout: 6000 });

		stop();
		await running;
	});
});
