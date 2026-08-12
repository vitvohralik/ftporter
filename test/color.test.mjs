// Color is decided once, when the logger is first imported, from whether stdout is a terminal.
// The rest of the suite runs without one, so this file claims to be one before importing anything
// that asks — which is why every import below is dynamic, and why this lives in a file of its own:
// node runs each test file in its own process, so the pretence cannot leak into the others.
process.stdout.isTTY = true;
delete process.env.NO_COLOR;

const assert = (await import('node:assert/strict')).default;
const { PassThrough } = await import('node:stream');
const { after, describe, it } = await import('node:test');

const { color } = await import('../src/logger.mjs');
const { runInteractive } = await import('../src/interactive.mjs');
const { logger, makeFixture } = await import('./helpers.mjs');

/** The bar as it would reach a terminal, escape codes and all. */
function start(fx) {
	const input = new PassThrough();
	const bars = [];
	const recorder = { ...logger, status: (msg) => !msg.startsWith(' ') && bars.push(msg) };
	const done = runInteractive(fx.config, recorder, { config: fx.configFile }, {
		input,
		output: { write() {} },
		columns: 100,
	});
	return {
		done,
		press: (key) => input.write(key),
		bar: () => (bars.at(-1) ?? '').split('\n').at(-1),
		async until(condition) {
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				if (condition()) return true;
			}
			return false;
		},
	};
}

describe('the bar in color', () => {
	it('colors watch and patrol while they are running, and only then', async () => {
		assert.notEqual(color.green, '', 'the premise: color is on for this file');

		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		const ui = start(fx);
		await ui.until(() => ui.bar() !== '');

		// "Is anything going up without me?" — answered by color, so it needs no reading.
		const lit = (key) => new RegExp(`${color.green.replace('[', '\\[')}\\x1b\\[1m${key}`).test(ui.bar());
		assert.equal(lit('W'), false, 'nothing is lit while nothing runs on its own');
		assert.equal(lit('I'), false);

		ui.press('W');
		assert.ok(await ui.until(() => /watch:on/.test(ui.bar())));
		assert.equal(lit('W'), true, 'the watcher lights up');
		assert.equal(lit('I'), false, 'and only it');

		ui.press('W');
		assert.ok(await ui.until(() => /watch:off/.test(ui.bar())));
		assert.equal(lit('W'), false, 'switched off, it goes out again');

		ui.press('q');
		await ui.done;
	});

	it('keeps the color when the terminal is too narrow for the labels', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		const input = new PassThrough();
		const bars = [];
		const recorder = { ...logger, status: (msg) => !msg.startsWith(' ') && bars.push(msg) };
		const done = runInteractive(fx.config, recorder, { config: fx.configFile }, {
			input,
			output: { write() {} },
			columns: 30,
		});

		const bar = () => (bars.at(-1) ?? '').split('\n').at(-1);
		const until = async (condition) => {
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				if (condition()) return true;
			}
			return false;
		};

		await until(() => bar() !== '');
		assert.doesNotMatch(bar(), /watch:/, 'the label is gone at this width');

		input.write('W');
		assert.ok(await until(() => bar().includes(color.green)), 'but the key is still lit');

		input.write('q');
		await done;
	});
});
