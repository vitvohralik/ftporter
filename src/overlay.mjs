import { color } from './logger.mjs';

/**
 * The two things that borrow the keyboard from the key bar: a list to choose from, and a line to
 * type into.
 *
 * Both draw over the bar, redraw in place while they are up, and erase themselves on the way out,
 * so the scrollback keeps only the outcome and stays the ordinary log it is everywhere else in the
 * session. Neither listens for keys itself — they are handed in by whoever owns the keyboard, which
 * keeps one handler in charge throughout and makes both testable without a terminal.
 */

/** Redrawing a block of lines where it stands, without disturbing the log above it. */
function inPlace(output) {
	let drawn = 0;
	return {
		draw(rows) {
			// Back to the top of the previous render, then overwrite line by line. Clearing each line
			// as we go matters because a shorter one would otherwise leave the tail of a longer one.
			if (drawn) output.write(`\x1b[${drawn}A`);
			output.write(rows.map((row) => `\x1b[2K${row}`).join('\n') + '\n');
			drawn = rows.length;
		},
		erase() {
			if (!drawn) return;
			output.write(`\x1b[${drawn}A${'\x1b[2K\n'.repeat(drawn)}\x1b[${drawn}A`);
			drawn = 0;
		},
	};
}

/**
 * A list: arrows to move, Enter to take it, Escape to back out.
 *
 * Cycling through targets with one key was fine with two of them and useless with five — you cannot
 * see where you are going, and passing the one you wanted means going all the way round. A list
 * shows every option and which one is current before anything happens.
 */
export function createPicker({ items, current, title, output = process.stdout }) {
	const screen = inPlace(output);
	const start = items.findIndex((item) => item.value === current);
	let index = start === -1 ? 0 : start;
	let settle;

	const draw = () =>
		screen.draw([
			`${color.dim}${title} — ↑↓ to move, ⏎ to switch, esc to stay${color.reset}`,
			...items.map((item, at) => {
				const label = `${item.value === current ? '·' : ' '} ${item.label}`;
				return at === index ? `${color.cyan}❯ ${label}${color.reset}` : `  ${label}`;
			}),
		]);

	const close = (value) => {
		screen.erase();
		settle(value);
	};

	draw();

	return {
		/** @returns {Promise<unknown|null>} the chosen value, or null when nothing was chosen. */
		done: new Promise((resolve) => {
			settle = resolve;
		}),

		key(str, key) {
			const name = key?.name;
			if (name === 'up' || name === 'k') index = (index - 1 + items.length) % items.length;
			else if (name === 'down' || name === 'j') index = (index + 1) % items.length;
			else if (name === 'home') index = 0;
			else if (name === 'end') index = items.length - 1;
			else if (name === 'return' || name === 'enter' || str === ' ') {
				// Choosing what is already current is a no-op, not a needless reconnect.
				return close(items[index].value === current ? null : items[index].value);
			} else if (name === 'escape' || str === 'q') return close(null);
			else return;
			draw();
		},

		/** For a caller that has to tear everything down — Ctrl-C, a signal — mid-choice. */
		abort: () => close(null),
	};
}

/**
 * A line to type into, for the one answer a keystroke cannot carry: how often to patrol.
 *
 * It starts on whatever the config already suggests, so the common case is a single Enter. `error`
 * puts a rejected answer back in front of the person who typed it rather than dropping them back at
 * the bar wondering what happened.
 */
export function createPrompt({ title, initial = '', error = null, output = process.stdout }) {
	const screen = inPlace(output);
	let value = initial;
	let settle;

	const draw = () =>
		screen.draw([
			...(error ? [`${color.yellow}! ${error}${color.reset}`] : []),
			`${color.dim}${title} — ⏎ to accept, esc to cancel${color.reset}`,
			`${color.cyan}❯ ${color.reset}${value}${color.dim}▏${color.reset}`,
		]);

	const close = (result) => {
		screen.erase();
		settle(result);
	};

	draw();

	return {
		/** @returns {Promise<string|null>} what was typed, or null when it was cancelled. */
		done: new Promise((resolve) => {
			settle = resolve;
		}),

		key(str, key) {
			const name = key?.name;
			if (name === 'return' || name === 'enter') return close(value.trim());
			if (name === 'escape') return close(null);
			if (name === 'backspace') value = value.slice(0, -1);
			// Ctrl-U, as everywhere else a line is typed.
			else if (key?.ctrl && name === 'u') value = '';
			// Printable characters only: control bytes and escape sequences are not text.
			else if (!key?.ctrl && !key?.meta && str && str.length === 1 && str >= ' ') value += str;
			else return;
			draw();
		},

		abort: () => close(null),
	};
}
