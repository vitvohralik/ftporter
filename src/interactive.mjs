import { emitKeypressEvents } from 'node:readline';

import { loadConfig } from './config.mjs';
import { listRemote, prune, reconcile, reconcilePaths } from './engine.mjs';
import { runHook } from './hooks.mjs';
import { color } from './logger.mjs';
import { createPicker, createPrompt } from './overlay.mjs';
import { openSession } from './session.mjs';
import { createWatcher } from './watch.mjs';
import { formatDuration, parseDuration, UserError } from './util.mjs';

/**
 * A session that stays open and does nothing until you ask it to.
 *
 * This exists for the way a deploy-only project is actually worked on: changes are finished at
 * irregular moments and want to go up *then* — not on a timer, and not on every save, because a
 * save is often the middle of an edit rather than the end of one. `watch` uploads too eagerly for
 * that and `patrol` uploads on a schedule that has nothing to do with when work is done. Both were
 * the wrong shape, and running one-off syncs instead means paying for a connection, a handshake and
 * a cold scan every single time.
 *
 * So: one connection, held open and kept warm, and a keystroke to use it. The actions are exactly
 * the ones the CLI already has — this only decides *when* they run, never what they do.
 */
/** Between groups of keys on the bar. Wide enough to read as a break, narrow enough to be cheap. */
const SEPARATOR = ' │ ';

export async function runInteractive(initial, logger, opts = {}, io = {}) {
	const input = io.input ?? process.stdin;
	const columns = () => io.columns ?? process.stdout.columns ?? 80;

	let config = initial;
	let session = null;
	let watcher = null;
	let busy = false;
	let quitting = false;
	// Set when an action stopped to ask: the delete cap was hit, or prune found orphans. `f` runs the
	// same action again with the answer, and anything else drops it — a confirmation that outlives
	// the question it belongs to is how the wrong thing gets deleted.
	let confirm = null;
	// Non-null while a list or a prompt is up: it owns the keyboard until it closes.
	let picker = null;
	// The patrol timer, off until asked for, and whether a tick came due while something was busy.
	let ticker = null;
	let duePass = false;

	const pending = new Set();
	let debounce = null;
	const screen = io.output ?? process.stdout;
	// Where `l` looked last, so going back to the same directory is one keystroke and an Enter.
	let lastListed = '';

	/**
	 * What `T` and `P` can offer, worked out once and kept.
	 *
	 * The base config — no target named — is on the list only when this run resolved to it, which
	 * means no `defaultTarget` is forcing one; otherwise it is not a state the config can be resolved
	 * into at all. Reading them once also keeps the list whole: taken from the *current* config it
	 * would be re-derived after every switch, and a target that named no targets of its own would
	 * leave you with nowhere to go back to.
	 */
	const targetNames = initial.targetName === null ? [null, ...initial.knownTargets] : initial.knownTargets;
	const profileNames = initial.knownProfiles;
	const nameOf = (target) => target ?? 'base';

	// ────────────────────────────────────────────────────────────────────────────
	// The bar
	// ────────────────────────────────────────────────────────────────────────────

	/**
	 * Drawn with the logger's own status line, which is already the one thing allowed to own the
	 * bottom row: every printed line wipes it first and it is restored afterwards. That is why the
	 * scrollback above stays an ordinary log — copyable, pipeable, exactly what `ftporter sync`
	 * prints — instead of a redrawn screen.
	 */
	const draw = () => {
		if (busy || quitting) return;

		// Grouped by what the keys are for, because eight of them in a row read as a wall. Order is
		// how often you reach for them: the one thing that just asked, then syncing, then the two
		// switches that make it automatic, then looking around, then where it all points, then out.
		//
		// Case still carries the weight inside the groups: a capital letter changes something —
		// uploads, deletes, or moves where the next upload would go — and a small one only ever
		// looks. So a key hit by accident is a key that reads.
		const groups = [
			[confirm && ['F', confirm.label]],
			[['S', 'sync'], ['n', 'dry-run']],
			// The two that act on their own get a color while they are on, because "is anything going
			// up without me?" is the one thing about this screen worth answering at a glance. The key
			// itself is tinted, not just the label, so the answer survives a bar too narrow for labels.
			[
				['W', `watch:${watcher ? 'on' : 'off'}`, Boolean(watcher)],
				['I', `patrol:${ticker ? formatDuration(ticker.every) : 'off'}`, Boolean(ticker)],
			],
			[['l', 'list'], ['p', 'prune']],
			[targetNames.length > 1 && ['T', 'target'], profileNames.length > 1 && ['P', 'profile']],
			[['q', 'quit']],
		]
			.map((group) => group.filter(Boolean))
			.filter((group) => group.length);

		// An arrow, because "prod/assets" alone reads as a label for the keys next to it rather than as
		// where they would send anything. It says which target and profile are in use, and is the
		// first thing dropped when the window is too narrow — it informs, it does not do.
		const where = `→ ${nameOf(config.targetName)}/${config.profileName}`;

		const render = (rows, suffix) =>
			rows
				.map((group) =>
					group
						.map(([key, label, live]) => {
							const tint = live ? color.green : '';
							return `${tint}${color.bold}${key}${color.reset}${label ? `${tint} ${label}${color.reset}` : ''}`;
						})
						.join('  '),
				)
				.join(`${color.dim}${SEPARATOR}${color.reset}`) + (suffix ? `  ${color.dim}${suffix}${color.reset}` : '');

		// Measured without the escape codes, which take up no space on screen.
		const width = (rows, suffix) =>
			rows.reduce(
				(total, group) =>
					total + group.reduce((n, [key, label]) => n + key.length + (label ? label.length + 1 : 0) + 2, -2),
				(rows.length - 1) * SEPARATOR.length,
			) + (suffix ? suffix.length + 2 : 0);

		// The bar is one row, so a narrow terminal has to give something up — and it gives it up from
		// the right, where the keys are the ones you reach for least and guess most easily. Losing
		// every label at the first pixel too few was a cliff: at a hundred columns the whole thing
		// went to bare letters when dropping "target" and "profile" alone would have done.
		//
		// The pending question is never reduced, whatever the width. A key that deletes files, shown
		// as a bare "F" with no word anywhere saying so, is the one thing here that must not happen.
		const trim = (count) =>
			groups.map((group, at) =>
				at >= groups.length - count && !(confirm && at === 0)
					? group.map(([key, , live]) => [key, null, live])
					: group,
			);

		const candidates = [
			[groups, where],
			[groups, null],
			...Array.from({ length: groups.length }, (_, at) => [trim(at + 1), null]),
		];
		const [rows, suffix] = candidates.find(([candidate, tail]) => width(candidate, tail) <= columns()) ?? candidates.at(-1);

		// A rule above it, so the bar reads as the edge of the window rather than as one more line of
		// log — which is what it looked like the moment an action printed something right above it.
		logger.status(`${'─'.repeat(Math.max(0, columns() - 1))}\n${render(rows, suffix)}`);
	};

	// ────────────────────────────────────────────────────────────────────────────
	// Actions
	// ────────────────────────────────────────────────────────────────────────────

	/**
	 * One action at a time, whatever asked for it — a keystroke or the watcher. Two syncs over one
	 * connection would interleave their uploads and their manifest writes.
	 *
	 * A keystroke that arrives mid-action is simply dropped, which is what you want from a keyboard.
	 * A watcher batch is not: its debounce may well fire while a sync is running, and forgetting it
	 * there would strand those saves until the next key — the one failure mode that would quietly
	 * make `w` untrustworthy. So anything still pending is rescheduled on the way out.
	 */
	const act = async (fn) => {
		// A list on screen owns the terminal too: a log line printed over it would land inside the
		// rendered rows and leave the redraw counting from the wrong place. Same rule as `busy`, and
		// the same rescheduling, so a save made while choosing a target goes up once it closes.
		if (busy || quitting || picker) {
			if (picker && watcher && pending.size) scheduleFlush();
			return;
		}
		busy = true;
		logger.clearStatus();
		try {
			await fn();
		} catch (err) {
			logger.warn(err.message);
			if (err.hint) logger.dim(`  ${err.hint}`);
			await runHook('onError', config, logger, { error: err.message }).catch(() => {});
		} finally {
			busy = false;
			if (quitting) await finish();
			else {
				if (watcher && pending.size) scheduleFlush();
				// A patrol tick that came due while this ran goes now. It starts before `draw`, which
				// then correctly skips: the session is busy again.
				runDuePass();
				draw();
			}
		}
	};

	const sync = (force = false) =>
		act(async () => {
			confirm = null;
			await runHook('beforeSync', config, logger);
			try {
				const result = await reconcile(session, config, logger, { ...opts, dryRun: false, force });
				await runHook('afterSync', config, logger, result);
			} catch (err) {
				// The cap is a question, not a failure: it has already printed what it would remove.
				if (err instanceof UserError && /would be deleted/.test(err.message)) {
					logger.warn(err.message);
					confirm = { label: 'delete anyway', run: () => sync(true) };
					return;
				}
				throw err;
			}
		});

	const dryRun = () =>
		act(async () => {
			confirm = null;
			await reconcile(session, config, logger, { ...opts, dryRun: true });
		});

	/**
	 * Looks at a directory on the server. Asks which one, starting from wherever it looked last, so
	 * an empty line is the remote root and Enter alone repeats the previous look.
	 */
	const listNow = async () => {
		if (busy || quitting || picker) return;
		logger.clearStatus();
		picker = createPrompt({ title: 'list which directory', initial: lastListed, output: screen });
		const where = await picker.done;
		picker = null;
		if (where === null) {
			runDuePass();
			return draw();
		}
		lastListed = where;
		await act(() => listRemote(session, config, logger, { ...opts, path: where }));
	};

	const pruneNow = (force = false) =>
		act(async () => {
			confirm = null;
			const result = await prune(session, config, logger, { ...opts, force, dryRun: false });
			if (result.orphans.length && !force) confirm = { label: 'delete orphans', run: () => pruneNow(true) };
		});

	const scheduleFlush = () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => flush(), config.watch.debounce);
	};

	const flush = () =>
		act(async () => {
			const batch = [...pending];
			pending.clear();
			if (batch.length === 0) return;
			const result = await reconcilePaths(session, config, logger, batch);
			if (result.uploaded || result.deleted) {
				logger.dim(`  ${result.uploaded} uploaded · ${result.deleted} deleted`);
				await runHook('afterSync', config, logger, result);
			}
		});

	/**
	 * The patrol timer: a full pass every so often, on top of — not instead of — pressing S.
	 *
	 * Off until asked for, like everything else here. A tick that lands while a sync, a list or a
	 * prompt is in the way is remembered rather than skipped, so the interval means "at least this
	 * often" instead of "unless you happened to be doing something".
	 */
	const runDuePass = () => {
		if (!duePass || busy || quitting || picker) return;
		duePass = false;
		sync();
	};

	const stopPatrol = () => {
		clearInterval(ticker?.timer);
		ticker = null;
		duePass = false;
	};

	const togglePatrol = async () => {
		if (ticker) {
			const was = formatDuration(ticker.every);
			stopPatrol();
			logger.dim(`  patrol off — it was running every ${was}`);
			return draw();
		}

		// Whatever the config already says is the obvious answer, so the common case is one Enter.
		let answer = config.watch.interval ? formatDuration(config.watch.interval) : '5m';
		let error = null;
		for (;;) {
			logger.clearStatus();
			picker = createPrompt({ title: 'run a full pass every', initial: answer, error, output: screen });
			answer = await picker.done;
			picker = null;
			if (answer === null) return draw();

			const every = parseDuration(answer);
			if (every === null || every < 1000) {
				error = `'${answer}' is not a duration of at least a second — try 30s, 5m, 1h`;
				continue;
			}
			ticker = { every, timer: setInterval(() => {
				duePass = true;
				runDuePass();
			}, every) };
			ticker.timer.unref?.();
			logger.dim(`  patrol on — a full pass every ${formatDuration(every)}`);
			return draw();
		}
	};

	const toggleWatch = async () => {
		if (watcher) {
			await watcher.close();
			watcher = null;
			pending.clear();
			clearTimeout(debounce);
			logger.dim('  watch off — nothing goes up until you say so');
		} else {
			watcher = await createWatcher(config, logger, (rel) => {
				pending.add(rel);
				scheduleFlush();
			});
			logger.dim('  watch on — every save goes up');
		}
		draw();
	};

	// ────────────────────────────────────────────────────────────────────────────
	// Switching where it points
	// ────────────────────────────────────────────────────────────────────────────

	/**
	 * A session belongs to one server, so switching target means closing it and opening another —
	 * the one thing here that costs a handshake. The old config is kept: a target that cannot be
	 * connected to leaves the session it had rather than dropping you nowhere.
	 */
	const switchTo = (target, profile) =>
		act(async () => {
			confirm = null;
			const previous = { config, session };
			try {
				logger.status('  connecting…');
				config = await loadConfig({ ...opts, target, profile });
				session = await openSession(config, logger);
			} catch (err) {
				config = previous.config;
				session = previous.session;
				throw err;
			}
			previous.session?.end();
			announce();
			// The watcher covers whatever the profile uploads, which the switch may have changed.
			if (watcher) {
				await watcher.close();
				watcher = null;
				await toggleWatch();
			}
		});

	/**
	 * Opens a list and switches to what comes back. The picker owns the keyboard while it is up —
	 * `onKey` hands everything over — and `null` means the choice was dropped, which is also what
	 * choosing the current entry means.
	 */
	const choose = async (title, names, current, label, apply) => {
		if (busy || quitting || names.length < 2) return;
		logger.clearStatus();
		picker = createPicker({
			title,
			current,
			items: names.map((name) => ({ value: name, label: label(name) })),
			output: screen,
		});
		const chosen = await picker.done;
		picker = null;
		if (chosen === null) {
			runDuePass();
			return draw();
		}
		await apply(chosen);
	};

	const chooseTarget = () =>
		choose('target', targetNames, config.targetName, nameOf, (name) => switchTo(name, config.profileName));

	const chooseProfile = () =>
		choose('profile', profileNames, config.profileName, (name) => name, (name) => switchTo(config.targetName, name));

	const announce = () =>
		logger.info(
			`ftporter ${config.label}${config.targetName ? ` → ${config.targetName}` : ''} → ${config.target}`,
		);

	// ────────────────────────────────────────────────────────────────────────────
	// Keys
	// ────────────────────────────────────────────────────────────────────────────

	const keymap = {
		S: () => sync(),
		n: dryRun,
		l: listNow,
		p: () => pruneNow(),
		W: toggleWatch,
		I: togglePatrol,
		T: chooseTarget,
		P: chooseProfile,
		F: () => confirm?.run(),
	};

	let resolveDone;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});

	const finish = async () => {
		if (watcher) await watcher.close().catch(() => {});
		stopPatrol();
		clearTimeout(debounce);
		logger.clearStatus();
		restore();
		session?.end();
		logger.dim('stopped');
		resolveDone();
	};

	const quit = () => {
		quitting = true;
		picker?.abort();
		// Mid-upload, the current action finishes first: killing a transfer is what leaves temporary
		// files on the server, and it is at most a few seconds.
		if (busy) logger.dim('  finishing the current action, then stopping…');
		else finish();
	};

	const onKey = (str, key) => {
		if (key?.ctrl && key.name === 'c') return quit();
		if (picker) return picker.key(str, key);
		if (str === 'q') return quit();
		if (busy || quitting) return;
		const action = keymap[str];
		if (!action) return;
		if (str !== 'F' && confirm) {
			// Any other key answers "no" to the pending question.
			confirm = null;
		}
		action();
	};

	// ────────────────────────────────────────────────────────────────────────────
	// Wiring
	// ────────────────────────────────────────────────────────────────────────────

	const restore = () => {
		input.off('keypress', onKey);
		if (input.isTTY) input.setRawMode(false);
		input.pause();
		process.off('SIGINT', quit);
		process.off('SIGTERM', quit);
	};

	logger.status('  connecting…');
	session = await openSession(config, logger);
	announce();
	logger.dim(`  ${config.root} · strategy ${config.strategy} · connection stays open between actions`);

	// The second argument is not optional in practice: without it a lone Escape that follows any
	// other escape sequence — an arrow, which is exactly how the picker is used — is held back
	// forever, waiting to see whether it is the start of a longer one. The timeout is what tells the
	// two apart, and 500 ms is both readline's own default and the usual terminal convention.
	emitKeypressEvents(input, { escapeCodeTimeout: 500 });
	if (input.isTTY) input.setRawMode(true);
	input.resume();
	input.on('keypress', onKey);
	process.on('SIGINT', quit);
	process.on('SIGTERM', quit);

	draw();
	await done;
	return { ok: true };
}
