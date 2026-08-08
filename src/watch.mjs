import path from 'node:path';

import { DEFAULT_IGNORED } from './config.mjs';
import { reconcile, reconcilePaths } from './engine.mjs';
import { runHook } from './hooks.mjs';
import { matcher } from './match.mjs';
import { formatDuration, toPosix } from './util.mjs';

/**
 * Keeps running and uploads as files change.
 *
 * Chokidar is attached first and a full pass runs immediately after, so the tree is known to be in
 * sync before anything is trusted to events. Changes are then collected into a batch after
 * `watch.debounce` ms. The batch goes through the same comparison as a full run — only the scope
 * differs, not the rules.
 *
 * With `watch.interval` set (`ftporter watch --interval 5m`) a full pass also runs on a timer.
 * That is the safety net for anything the filesystem events miss: files written by another machine,
 * a network share that does not emit events, a watcher that fell asleep after a laptop suspend.
 *
 * `ftporter patrol` is the same loop with the watcher turned off — the timer alone.
 */
export async function runWatch(session, config, logger, opts = {}) {
	const { useWatcher = true } = opts;
	const interval = config.watch.interval;
	const pending = new Set();
	let timer = null;
	let running = false;
	let stopped = false;
	let queuedFullPass = false;

	const isIgnored = matcher([...DEFAULT_IGNORED, ...config.watch.ignored, ...config.exclude]);

	const runFullPass = async () => {
		try {
			await runHook('beforeSync', config, logger);
			const result = await reconcile(session, config, logger, opts);
			await runHook('afterSync', config, logger, result);
		} catch (err) {
			logger.warn(err.message);
			await runHook('onError', config, logger, { error: err.message }).catch(() => {});
		}
	};

	const flush = async () => {
		if (running || stopped) return;
		if (pending.size === 0 && !queuedFullPass) return;
		running = true;
		try {
			if (queuedFullPass) {
				queuedFullPass = false;
				pending.clear();
				await runFullPass();
			} else {
				const batch = [...pending];
				pending.clear();
				const result = await reconcilePaths(session, config, logger, batch);
				if (result.uploaded || result.deleted) {
					logger.dim(`  ${stamp()} ${result.uploaded} uploaded · ${result.deleted} deleted`);
					await runHook('afterSync', config, logger, result);
				}
			}
			logger.clearStatus();
		} catch (err) {
			logger.warn(err.message);
			await runHook('onError', config, logger, { error: err.message }).catch(() => {});
		} finally {
			running = false;
			if (pending.size || queuedFullPass) schedule();
		}
	};

	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(flush, config.watch.debounce);
	};

	// The watcher goes up before the first pass, not after it. `ignoreInitial` keeps it quiet about
	// the files that are already there, so the pass below still does the real work — but a file
	// written *during* that pass now lands in `pending` instead of falling into the gap between the
	// two, where it would have waited for its next save or for the interval to come around.
	let watcher = null;
	if (useWatcher) {
		const { watch: chokidarWatch } = await import('chokidar');
		const roots = config.roots?.length ? config.roots : config.strategy === 'whitelist' ? config.include : [''];

		watcher = chokidarWatch(
			roots.filter((r) => !r.startsWith('!')).map((r) => path.join(config.root, r)),
			{
				ignoreInitial: true,
				ignored: (abs) => {
					const rel = toPosix(path.relative(config.root, abs));
					return rel !== '' && !rel.startsWith('..') && isIgnored(rel);
				},
				awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
				usePolling: config.watch.usePolling,
				interval: config.watch.pollInterval,
			},
		);

		watcher.on('all', (event, abs) => {
			if (!['add', 'change', 'unlink'].includes(event)) return;
			pending.add(toPosix(path.relative(config.root, abs)));
			schedule();
		});
		watcher.on('error', (err) => logger.warn(`watcher: ${err.message}`));

		await new Promise((resolve) => watcher.on('ready', resolve));
	}

	// `running` holds off the debounced flush: whatever the watcher reports meanwhile waits its turn
	// rather than opening a second batch over the same connection.
	running = true;
	try {
		await runFullPass();
	} finally {
		running = false;
		if (pending.size || queuedFullPass) schedule();
	}

	let ticker = null;
	if (interval) {
		ticker = setInterval(() => {
			queuedFullPass = true;
			schedule();
		}, interval);
		ticker.unref?.();
	}

	const what = useWatcher ? 'Watching' : 'Patrolling';
	const every = interval ? ` (full pass every ${formatDuration(interval)})` : '';
	logger.info(`${what} ${config.root} → ${config.target}${every}. Ctrl-C to stop.`);

	await new Promise((resolve) => {
		const stop = () => {
			stopped = true;
			clearTimeout(timer);
			if (ticker) clearInterval(ticker);
			process.off('SIGINT', stop);
			process.off('SIGTERM', stop);
			(watcher ? watcher.close() : Promise.resolve()).then(resolve, resolve);
		};
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
	});
	logger.dim('stopped');
}

const stamp = () => new Date().toTimeString().slice(0, 8);
