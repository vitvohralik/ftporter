import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import { runInteractive } from '../src/interactive.mjs';
import { logger, makeFixture } from './helpers.mjs';

/**
 * Drives a real interactive session over a fake keyboard.
 *
 * `input` is an ordinary stream rather than a TTY, so raw mode is skipped and keypresses arrive
 * exactly as they would from a terminal — which is the whole point: the session's behaviour is
 * testable without owning a terminal.
 */
function start(fx, opts = {}, io = {}) {
	const input = new PassThrough();
	// Only the key bar counts as "the session is idle again". The same status line also carries the
	// progress of a running action ("upload 3/40"), and treating those as the end of one is what made
	// every test here intermittently press its next key into a session that was still busy — where it
	// is dropped by design.
	//
	// Told apart by the indent rather than by any word in it: every progress line is indented, the bar
	// never is, and the bar's wording is not dependable — it drops labels to fit a narrow terminal.
	// What it draws is two rows, a rule and the keys; only the keys are of interest out here.
	const isBar = (msg) => !msg.startsWith(' ');
	const keysOf = (msg) => msg.split('\n').at(-1);
	const bars = [];
	let onLog = () => {};
	const recorder = {
		...logger,
		status: (msg) => isBar(msg) && bars.push(msg),
		log: (msg) => onLog(msg),
		dim: (msg) => onLog(msg),
	};
	// The picker draws straight to its output rather than through the logger, so it is collected
	// separately — with the escape codes stripped, since only the text is under test.
	let drawn = '';
	const output = { write: (chunk) => (drawn += chunk) };
	const done = runInteractive(fx.config, recorder, { config: fx.configFile, ...opts }, { input, output, columns: 100, ...io });
	/**
	 * Polls until something is true, or gives up well short of the test timeout.
	 *
	 * The budget is generous on purpose. These tests drive real servers and real syncs, and the whole
	 * suite runs its files in parallel, so a pass that takes 40 ms on an idle machine can take
	 * seconds on a loaded one. A tight budget turns that into a failure that looks like a bug in the
	 * session and is not one; a slack one still fails for a genuine hang, only later.
	 */
	const until = async (condition) => {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (condition()) return true;
		}
		return false;
	};

	return {
		done,
		until,
		bar: () => keysOf(bars.at(-1) ?? ''),
		/** The rule the bar draws above itself, to keep it clear of the log. */
		rule: () => (bars.at(-1) ?? '').split('\n')[0] ?? '',
		/** Watches what the session writes to the log above the bar. */
		onLog: (fn) => {
			onLog = fn;
		},
		/**
		 * Everything the picker has drawn, escape codes stripped — reading does not consume it, so it
		 * is safe to poll while waiting for the list to come up.
		 */
		picker: () => drawn.replaceAll(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
		/** How many bars have been drawn — one more means the session came back to idle. */
		bars: () => bars.length,
		arrow: (name) => input.write(name === 'up' ? '\x1b[A' : '\x1b[B'),
		enter: () => input.write('\r'),
		escape: () => input.write('\x1b'),
		/** Types into a prompt one character at a time, as a keyboard delivers them. */
		type: (text) => {
			for (const char of text) input.write(char);
		},
		clearLine: () => input.write('\x15'),
		forget: () => {
			drawn = '';
		},
		press: (key) => input.write(key),
		/**
		 * Presses a key until it takes.
		 *
		 * A key pressed while an action is running is dropped by design, and with a patrol on a
		 * one-second timer there is no moment a test can be sure is idle. Pressing again while the bar
		 * still shows the old state is what a person does, and it cannot overshoot: the moment the bar
		 * reports the new one, this stops.
		 */
		pressUntil: (key, condition) =>
			until(() => {
				if (condition()) return true;
				input.write(key);
				return false;
			}),
		/**
		 * Presses a key and waits until the session is idle again.
		 *
		 * The bar is redrawn when an action ends, so a new bar line is what "idle" looks like from
		 * out here. Waiting for it matters: keys pressed during an action are ignored by design, so a
		 * test that fires the next one as soon as it sees the *effect* it wanted — mid-upload, before
		 * the action returns — would have that key swallowed and blame the session for it.
		 */
		run(key, condition) {
			const drawn = bars.length;
			input.write(key);
			return until(() => bars.length > drawn && (condition ? condition() : true));
		},
	};
}

const quit = async (ui) => {
	ui.press('q');
	await ui.done;
};

describe('interactive', () => {
	it('holds the connection open and uploads only when asked', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);

		// Idle: the session is up, the file is not.
		await ui.until(() => ui.bars() > 0);
		assert.deepEqual(fx.remoteList(), [], 'nothing goes up on its own');

		assert.ok(await ui.run('S', () => fx.remoteExists('a.txt')), 's uploads');
		assert.equal(fx.remoteRead('a.txt'), 'one');

		// And again, on the same connection.
		fx.write('a.txt', 'two');
		assert.ok(await ui.run('S', () => fx.remoteRead('a.txt') === 'two'), 'the second sync reuses the session');

		await quit(ui);
	});

	it('shows what a dry run would do without touching the server', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bars() > 0);

		assert.ok(await ui.run('n'), 'the dry run finishes');
		assert.deepEqual(fx.remoteList(), [], 'a dry run uploads nothing');

		assert.ok(await ui.run('S', () => fx.remoteExists('a.txt')), 'and the sync after it still works');
		await quit(ui);
	});

	it('groups the keys and rules them off from the log', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bars() > 0);

		// Read left to right: what just asked, syncing, the two automatic switches, looking around,
		// where it points, and out.
		assert.match(ui.bar(), /S sync {2}n dry-run │ W watch:\S+ {2}I patrol:\S+ │ l list {2}p prune │ q quit/);
		assert.match(ui.rule(), /^─+$/, 'a rule keeps the bar off the last line of the log');
		assert.match(ui.bar(), /→ base\/default$/, 'and the far end says where it all points');

		await quit(ui);
	});

	it('offers the key bar and tracks the watch toggle in it', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bars() > 0);

		assert.match(ui.bar(), /S sync/);
		assert.match(ui.bar(), /watch:off/);
		assert.match(ui.bar(), /q quit/);

		await ui.run('W', () => /watch:on/.test(ui.bar()));
		assert.match(ui.bar(), /watch:on/, 'the bar reflects the toggle');

		// With the watcher on, a save goes up by itself.
		fx.write('b.txt', 'new');
		assert.ok(await ui.until(() => fx.remoteExists('b.txt')), 'watch uploads a saved file');

		await ui.run('W', () => /watch:off/.test(ui.bar()));
		fx.write('c.txt', 'later');
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(fx.remoteExists('c.txt'), false, 'and stops when switched off again');

		await quit(ui);
	});

	it('keeps a pending confirmation spelled out however narrow the terminal is', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' },
			config: { strategy: 'blacklist', deleteCap: 2 },
		});
		after(() => fx.cleanup());
		// Too narrow for the labels, so the bar has to give something up.
		const ui = start(fx, {}, { columns: 40 });
		await ui.until(() => ui.bars() > 0);

		assert.doesNotMatch(ui.bar(), /profile/, 'the labels furthest right go first');
		assert.match(ui.bar(), /S/);

		assert.ok(await ui.run('S', () => fx.remoteList().length === 3));
		fx.remove('a.txt');
		fx.remove('b.txt');
		fx.remove('c.txt');

		// A key that deletes files must never appear as a bare letter with nothing saying what it does.
		assert.ok(await ui.run('S', () => /delete anyway/.test(ui.bar())), 'the question survives the squeeze');
		assert.ok(ui.bar().length <= 40, `the bar still fits: ${ui.bar().length} columns`);

		await quit(ui);
	});

	it('does not strand a save that lands while a sync is running', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bars() > 0);
		await ui.run('W', () => /watch:on/.test(ui.bar()));

		// Written while a sync holds the session: its debounce fires into a busy loop, which drops the
		// batch. Nothing else would ever come back for it, so the file has to be picked up on the way
		// out of the action that was in the way.
		ui.press('S');
		fx.write('late.txt', 'written mid-sync');

		assert.ok(await ui.until(() => fx.remoteExists('late.txt')), 'the stranded save still goes up');
		await quit(ui);
	});

	it('asks before deleting over the cap, and only f goes through with it', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' },
			config: { strategy: 'blacklist', deleteCap: 2 },
		});
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bars() > 0);

		assert.ok(await ui.run('S', () => fx.remoteList().length === 3));
		fx.remove('a.txt');
		fx.remove('b.txt');
		fx.remove('c.txt');

		assert.ok(await ui.run('S', () => /F delete anyway/.test(ui.bar())), 'the cap turns into a question');
		assert.equal(fx.remoteList().length, 3, 'and nothing is deleted while it stands');

		// Anything else answers "no".
		await ui.run('n', () => !/F delete anyway/.test(ui.bar()));
		assert.equal(fx.remoteList().length, 3, 'another key drops the confirmation');

		assert.ok(await ui.run('S', () => /F delete anyway/.test(ui.bar())));
		assert.ok(await ui.run('F', () => fx.remoteList().length === 0), 'F confirms it');

		await quit(ui);
	});

	it('lists orphans on p and removes them on f', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bars() > 0);

		assert.ok(await ui.run('S', () => fx.remoteExists('a.txt')));
		fx.remoteWrite('leftover.txt', 'from before ftporter');

		assert.ok(await ui.run('p', () => /F delete orphans/.test(ui.bar())), 'prune lists and asks');
		assert.equal(fx.remoteExists('leftover.txt'), true, 'listing removes nothing');

		assert.ok(await ui.run('F', () => !fx.remoteExists('leftover.txt')), 'F removes them');
		await quit(ui);
	});

	describe('patrol', () => {
		it('asks how often, then runs a full pass on its own until switched off', async () => {
			const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
			after(() => fx.cleanup());
			const ui = start(fx);
			await ui.until(() => ui.bars() > 0);
			assert.match(ui.bar(), /I patrol:off/, 'off until asked for');

			ui.press('I');
			assert.ok(await ui.until(() => /full pass every/.test(ui.picker())), 'the prompt comes up');

			ui.clearLine();
			ui.type('1s');
			const drawn = ui.bars();
			ui.enter();
			assert.ok(await ui.until(() => ui.bars() > drawn), 'the prompt closes');
			assert.match(ui.bar(), /I patrol:1s/, 'and the bar carries the interval');

			// Nothing was pressed for this one — the timer did it.
			fx.write('b.txt', 'left for the patrol to find');
			assert.ok(await ui.until(() => fx.remoteExists('b.txt')), 'a pass runs on its own');

			assert.ok(await ui.pressUntil('I', () => /I patrol:off/.test(ui.bar())), 'and I again turns it off');
			fx.write('c.txt', 'after the patrol stopped');
			await new Promise((resolve) => setTimeout(resolve, 1500));
			assert.equal(fx.remoteExists('c.txt'), false, 'nothing goes up once it is off');

			await quit(ui);
		});

		it('puts a duration it cannot read back in front of you', async () => {
			const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
			after(() => fx.cleanup());
			const ui = start(fx);
			await ui.until(() => ui.bars() > 0);

			ui.press('I');
			assert.ok(await ui.until(() => /full pass every/.test(ui.picker())));
			ui.clearLine();
			ui.type('soon');
			ui.forget();
			ui.enter();

			assert.ok(await ui.until(() => /is not a duration/.test(ui.picker())), 'it says why');
			assert.match(ui.picker(), /soon/, 'and keeps what was typed, ready to fix');
			assert.match(ui.bar(), /I patrol:off/, 'nothing started');

			// A sub-second interval is refused for the same reason the config refuses one.
			ui.clearLine();
			ui.type('10ms');
			ui.forget();
			ui.enter();
			assert.ok(await ui.until(() => /is not a duration/.test(ui.picker())));

			const drawn = ui.bars();
			ui.escape();
			assert.ok(await ui.until(() => ui.bars() > drawn), 'escape leaves it alone');
			assert.match(ui.bar(), /I patrol:off/);

			await quit(ui);
		});
	});

	it('lists a directory on the server without changing anything', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a', 'public/b.txt': 'bb' },
			config: { strategy: 'blacklist' },
		});
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bars() > 0);
		assert.match(ui.bar(), /l list/);

		assert.ok(await ui.run('S', () => fx.remoteList().length === 2));

		const printed = [];
		ui.onLog((msg) => printed.push(msg));
		ui.press('l');
		assert.ok(await ui.until(() => /list which directory/.test(ui.picker())), 'it asks which one');

		ui.type('public');
		const drawn = ui.bars();
		ui.enter();
		assert.ok(await ui.until(() => ui.bars() > drawn), 'and the listing finishes');
		assert.ok(printed.some((line) => line.includes('/site/public')), 'naming the directory it looked in');
		assert.ok(printed.some((line) => line.includes('b.txt')), 'and what is in it');
		assert.equal(fx.remoteList().length, 2, 'nothing on the server changed');

		// The next look starts where the last one left off.
		ui.press('l');
		assert.ok(await ui.until(() => /public/.test(ui.picker())), 'it remembers where it looked');
		ui.escape();
		await ui.until(() => ui.bars() > drawn + 1);

		await quit(ui);
	});

	describe('picking a target', () => {
		const withTargets = () =>
			makeFixture({
				files: { 'a.txt': 'a' },
				config: {
					strategy: 'blacklist',
					targets: {
						other: { server: { protocol: 'sftp', remoteRoot: '/elsewhere' } },
						third: { server: { protocol: 'sftp', remoteRoot: '/third' } },
					},
				},
			});

		it('lists every target, marks the current one and switches on enter', async () => {
			const fx = await withTargets();
			after(() => fx.cleanup());
			const ui = start(fx);
			await ui.until(() => ui.bars() > 0);
			assert.match(ui.bar(), /T target/, 'the bar offers a list, not a direction');

			ui.press('T');
			assert.ok(await ui.until(() => /third/.test(ui.picker())), 'the list comes up');

			const list = ui.picker();
			assert.match(list, /base/);
			assert.match(list, /other/);
			assert.match(list, /third/, 'every target is on it, not just the next one');
			assert.match(list, /· base/, 'and the current one is marked');

			ui.arrow('down');
			ui.enter();
			assert.ok(await ui.until(() => /→ other\/default/.test(ui.bar())), 'enter takes the highlighted one');
			assert.ok(await ui.run('S', () => fx.remoteList('elsewhere').length === 1), 'and it uploads there');

			await quit(ui);
		});

		it('stays where it is when the list is escaped', async () => {
			const fx = await withTargets();
			after(() => fx.cleanup());
			const ui = start(fx);
			await ui.until(() => ui.bars() > 0);

			ui.press('T');
			assert.ok(await ui.until(() => /other/.test(ui.picker())));
			ui.arrow('down');

			// Waited for rather than fired blind, the way a person would: an Escape followed inside a
			// few milliseconds by another key is not two keystrokes to a terminal, it is one Alt-key
			// combination — so pressing on immediately would swallow the very Escape under test.
			const drawn = ui.bars();
			ui.escape();
			assert.ok(await ui.until(() => ui.bars() > drawn), 'the list closes and the bar comes back');
			assert.match(ui.bar(), /base\/default/, 'still on the target it started from');

			assert.ok(await ui.run('S', () => fx.remoteList().length === 1), 'and that is where it uploads');

			await quit(ui);
		});

		it('offers no list when there is nowhere else to go', async () => {
			const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
			after(() => fx.cleanup());
			const ui = start(fx);
			await ui.until(() => ui.bars() > 0);

			assert.doesNotMatch(ui.bar(), /T target/);
			assert.doesNotMatch(ui.bar(), /P profile/);

			await quit(ui);
		});
	});

	it('puts a real terminal into raw mode and always hands it back', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		// A stream that claims to be a terminal, so the branch a PassThrough never reaches is taken.
		// Leaving a terminal in raw mode outlives the process and breaks the shell the user goes back
		// to, so both halves of this are load-bearing.
		const input = new PassThrough();
		const modes = [];
		input.isTTY = true;
		input.setRawMode = (on) => modes.push(on);

		const done = runInteractive(fx.config, logger, { config: fx.configFile }, { input, columns: 100 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(modes, [true], 'raw mode on while it holds the keyboard');

		input.write('q');
		await done;
		assert.deepEqual(modes, [true, false], 'and off again on the way out');
		assert.equal(input.listenerCount('keypress'), 0, 'with the key handler detached');
	});

	it('quits on q and closes the session behind it', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);

		await new Promise((resolve) => setTimeout(resolve, 50));
		ui.press('q');
		await ui.done; // hangs the test if the loop does not come down on its own
	});
});
