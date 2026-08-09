const useColor =
	process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

export const color = useColor
	? {
			dim: '\x1b[2m',
			red: '\x1b[31m',
			green: '\x1b[32m',
			yellow: '\x1b[33m',
			cyan: '\x1b[36m',
			bold: '\x1b[1m',
			reset: '\x1b[0m',
		}
	: { dim: '', red: '', green: '', yellow: '', cyan: '', bold: '', reset: '' };

// Width of the status line currently on screen. Module scope, not per logger: whoever prints next
// has to wipe it, and that includes the top-level error handler in bin/, which has no logger.
let statusWidth = 0;

/** Wipe the live status line, if any. Safe to call from anywhere, including after a throw. */
export function clearStatus() {
	if (statusWidth === 0) return;
	// Erase the whole line where the terminal supports it: the status text is not always the last
	// thing on it (Ctrl-C makes the shell echo ^C right after it), and padding only covers what we
	// wrote ourselves. Falls back to blanking our own width on dumb terminals.
	process.stdout.write(useColor ? '\r\x1b[2K' : `\r${' '.repeat(statusWidth)}\r`);
	statusWidth = 0;
}

/**
 * Output with a live status line.
 *
 * Scanning and uploading take a while — a second for a small project, minutes for a huge tree —
 * and without the status line it looks like nothing is happening. Outside a terminal (pipe, log
 * file, CI) the status line is not printed at all, so logs stay clean.
 */
export function createLogger({ quiet = false, verbose = false } = {}) {
	const interactive = process.stdout.isTTY && !quiet;

	// Every regular line must wipe the status line first, or it would print on top of it.
	const line = (msg) => {
		clearStatus();
		if (!quiet) console.log(msg);
	};

	return {
		verbose,
		status(msg) {
			if (!interactive) return;
			clearStatus();
			process.stdout.write(`${color.dim}${msg}${color.reset}`);
			statusWidth = msg.length;
		},
		clearStatus,
		log: line,
		dim: (msg) => line(`${color.dim}${msg}${color.reset}`),
		info: (msg) => line(`${color.cyan}${msg}${color.reset}`),
		warn(msg) {
			clearStatus();
			console.error(`${color.yellow}! ${msg}${color.reset}`);
		},
		ok: (msg) => line(`${color.green}✓ ${msg}${color.reset}`),
		trace(msg) {
			if (verbose) line(`${color.dim}  ${msg}${color.reset}`);
		},
		error(msg) {
			clearStatus();
			console.error(`${color.red}ftporter: ${msg}${color.reset}`);
		},
	};
}

/** A logger that swallows everything — used by the programmatic API and the tests. */
export const silentLogger = () => ({
	verbose: false,
	status() {},
	clearStatus() {},
	log() {},
	dim() {},
	info() {},
	warn() {},
	ok() {},
	trace() {},
	error() {},
});
