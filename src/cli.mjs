import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_NAMES, CONFIG_TEMPLATE, loadConfig, STRATEGIES } from './config.mjs';
import { prune, reconcile } from './engine.mjs';
import { runHook } from './hooks.mjs';
import { color, createLogger } from './logger.mjs';
import { SftpSession } from './sftp.mjs';
import { runWatch } from './watch.mjs';
import { formatDuration, parseDuration, UserError } from './util.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const COMMANDS = ['sync', 'watch', 'patrol', 'status', 'prune', 'test', 'init', 'config'];

const HELP = `
${color.bold}ftporter${color.reset} — your files' porter: SFTP deploy, watcher and interval patrol

  Usage: ftporter [command] [options]

${color.bold}Commands${color.reset}
  sync                One pass: upload what changed, delete what is gone. ${color.dim}(default)${color.reset}
  watch               Stay running and upload on every save.
  patrol              Stay running and run a full pass on a timer (--interval).
  status              Show what a sync would do, change nothing. ${color.dim}(= sync --dry-run)${color.reset}
  prune               List files on the server nobody knows about. Lists only until --force;
                      --temp narrows it to leftovers from interrupted uploads.
  test                Check the connection and the remote root, upload nothing.
  init                Write a commented config file into the current directory.
  config              Print the resolved configuration (secrets redacted).

${color.bold}Options${color.reset}
  -c, --config <file>     Config file to use ${color.dim}(default: nearest ${CONFIG_NAMES[3]} upwards)${color.reset}
  -t, --target <name>     Named server from "targets"
  -p, --profile <name>    Named variant from "profiles"
      --root <dir>        Project root to upload
  -n, --dry-run           Print what would happen, change nothing
  -w, --watch             Same as the watch command
  -i, --interval <time>   Full pass every 30s / 5m / 1h ${color.dim}(with watch or patrol)${color.reset}
      --strategy <name>   ${STRATEGIES.join(' | ')}
      --include <glob>    Extra path to upload ${color.dim}(repeatable, added to the config)${color.reset}
      --exclude <glob>    Extra path to skip ${color.dim}(repeatable, wins over include)${color.reset}
      --no-delete         Upload only, never delete
      --no-atomic         Write straight onto the target (faster, unsafe while in use)
      --temp              With prune: only .ftporter-tmp.* leftovers, anywhere on the server
  -f, --force             Allow a delete count over the cap; confirm prune
      --host/--user/--port/--remote-root/--key   Override the connection for one run
  -v, --verbose           Show timings
  -q, --quiet             Only errors
      --json              Print a JSON summary instead of the usual output
  -h, --help              This help
      --version           Print the version

${color.bold}Examples${color.reset}
  ftporter                          ${color.dim}# one pass from the current project${color.reset}
  ftporter watch                    ${color.dim}# upload on save${color.reset}
  ftporter patrol -i 5m             ${color.dim}# full pass every five minutes${color.reset}
  ftporter -t prod -n               ${color.dim}# what would go to production?${color.reset}
  ftporter -p assets --no-delete    ${color.dim}# just the build output${color.reset}

  Docs: https://github.com/vitvohralik/ftporter
`;

const FLAGS = {
	'--dry-run': 'dryRun',
	'-n': 'dryRun',
	'--watch': 'watch',
	'-w': 'watch',
	'--force': 'force',
	'-f': 'force',
	'--verbose': 'verbose',
	'-v': 'verbose',
	'--quiet': 'quiet',
	'-q': 'quiet',
	'--json': 'json',
	'--help': 'help',
	'-h': 'help',
	'--version': 'version',
	'--no-delete': 'noDelete',
	'--no-atomic': 'noAtomic',
	'--temp': 'temp',
};

const VALUES = {
	'--config': 'config',
	'-c': 'config',
	'--target': 'target',
	'-t': 'target',
	'--profile': 'profile',
	'-p': 'profile',
	'--root': 'root',
	'--interval': 'interval',
	'-i': 'interval',
	'--strategy': 'strategy',
	'--host': 'host',
	'--user': 'username',
	'--username': 'username',
	'--port': 'port',
	'--remote-root': 'remoteRoot',
	'--key': 'key',
};

export function parseArgs(argv) {
	const opts = { include: [], exclude: [] };
	let command = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--include' || arg === '--exclude') {
			const value = argv[++i];
			if (value === undefined) throw new UserError(`${arg} needs a value`);
			opts[arg === '--include' ? 'include' : 'exclude'].push(value);
			continue;
		}
		if (VALUES[arg]) {
			const value = argv[++i];
			if (value === undefined) throw new UserError(`${arg} needs a value`);
			// Silently keeping the last one turned `-p node -p vendor` into a run against `vendor`
			// alone, which looks like both were used until the file list says otherwise.
			if (opts[VALUES[arg]] !== undefined && opts[VALUES[arg]] !== value) {
				throw new UserError(
					`${arg} given twice ('${opts[VALUES[arg]]}' and '${value}')`,
					'Only one can apply — run the command once for each.',
				);
			}
			opts[VALUES[arg]] = value;
			continue;
		}
		// --key=value form
		const eq = arg.indexOf('=');
		if (arg.startsWith('--') && eq > 2 && VALUES[arg.slice(0, eq)]) {
			opts[VALUES[arg.slice(0, eq)]] = arg.slice(eq + 1);
			continue;
		}
		if (FLAGS[arg]) {
			opts[FLAGS[arg]] = true;
			continue;
		}
		if (arg.startsWith('-')) throw new UserError(`unknown option '${arg}' (see --help)`);
		if (command) throw new UserError(`unexpected argument '${arg}'`);
		if (!COMMANDS.includes(arg)) {
			throw new UserError(`unknown command '${arg}' (known: ${COMMANDS.join(', ')})`);
		}
		command = arg;
	}

	opts.command = command ?? 'sync';
	if (opts.noDelete) opts.delete = false;
	if (opts.noAtomic) opts.atomicUpload = false;
	if (opts.interval !== undefined && parseDuration(opts.interval) === null) {
		throw new UserError(`invalid --interval '${opts.interval}' (use 30s, 5m, 1h)`);
	}
	return opts;
}

export async function run(argv) {
	const opts = parseArgs(argv);

	if (opts.help) {
		console.log(HELP);
		return 0;
	}
	if (opts.version) {
		console.log(pkg.version);
		return 0;
	}
	if (opts.command === 'init') return initConfig(opts);

	const logger = createLogger({ quiet: opts.quiet || opts.json, verbose: opts.verbose });
	const config = await loadConfig(opts);

	if (opts.command === 'config') return printConfig(config);

	if (opts.command === 'status') opts.dryRun = true;
	if (opts.command === 'patrol' && !config.watch.interval) {
		throw new UserError('patrol needs an interval', 'Pass --interval 5m, or set "watch": { "interval": "5m" }.');
	}

	logger.dim(
		`ftporter ${config.label}${config.targetName ? ` → ${config.targetName}` : ''} → ${config.target}` +
			`${opts.dryRun ? ' (dry run)' : ''}`,
	);
	logger.trace(`config ${config.configFile ?? '(none)'} · root ${config.root} · strategy ${config.strategy}`);
	logger.status('  connecting…');

	const session = await SftpSession.open(config, logger);
	let exitCode = 0;
	try {
		switch (opts.command) {
			case 'test':
				await testConnection(session, config, logger);
				break;
			case 'prune':
				await prune(session, config, logger, opts);
				break;
			case 'watch':
			case 'patrol':
				await runWatch(session, config, logger, { ...opts, useWatcher: opts.command === 'watch' });
				break;
			default: {
				if (opts.watch) {
					await runWatch(session, config, logger, { ...opts, useWatcher: true });
					break;
				}
				await runHook('beforeSync', config, logger);
				const result = await reconcile(session, config, logger, opts);
				await runHook('afterSync', config, logger, result);
				if (opts.json) console.log(JSON.stringify({ ok: true, ...summarize(config, result) }, null, 2));
			}
		}
	} catch (err) {
		await runHook('onError', config, logger, { error: err.message }).catch(() => {});
		if (opts.json) {
			console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
			exitCode = 1;
		} else {
			throw err;
		}
	} finally {
		logger.clearStatus();
		session.end();
	}
	return exitCode;
}

const summarize = (config, result) => ({
	target: config.target,
	profile: config.profileName,
	files: result.files,
	uploaded: result.uploaded,
	deleted: result.deleted,
	failed: result.failed,
	uploads: result.uploads,
	deletes: result.deletes,
	ms: result.ms,
});

/**
 * Answers the three questions a first run actually fails on: can I log in, does the remote root
 * exist, and may I write there. When the root does not exist yet the write check moves up to the
 * nearest directory that does — that is the one the first upload would have to create it in.
 */
async function testConnection(session, config, logger) {
	logger.ok(`connected to ${config.target}`);

	const parts = config.sftp.remoteRoot.split('/').filter(Boolean);
	let base = null;
	for (let depth = parts.length; depth >= 0; depth--) {
		const abs = `/${parts.slice(0, depth).join('/')}`;
		const list = await session.readdirAbs(abs).catch(() => null);
		if (!list) continue;
		base = abs;
		if (depth === parts.length) logger.dim(`  remote root exists, ${list.length} entries`);
		else logger.warn(`remote root ${config.sftp.remoteRoot} does not exist yet — the first upload would create it`);
		break;
	}

	if (base === null) {
		logger.warn(`cannot read any part of ${config.sftp.remoteRoot}`);
	} else {
		const probe = `${base === '/' ? '' : base}/.ftporter-write-test-${process.pid}`;
		try {
			await session.mkdirAbs(probe);
			await session.rmdirAbs(probe);
			logger.ok(`write access to ${base} confirmed`);
		} catch (err) {
			logger.warn(`no write access to ${base}: ${err.message}`);
		}
	}

	logger.dim(`  strategy ${config.strategy} · root ${config.root}`);
	if (config.watch.interval) logger.dim(`  patrol interval ${formatDuration(config.watch.interval)}`);
}

function initConfig(opts) {
	const file = path.resolve(process.cwd(), opts.config ?? 'ftporter.config.jsonc');
	if (fs.existsSync(file) && !opts.force) {
		throw new UserError(`${path.basename(file)} already exists`, 'Pass --force to overwrite it.');
	}
	fs.writeFileSync(file, CONFIG_TEMPLATE);
	console.log(`${color.green}✓${color.reset} wrote ${file}`);
	console.log(`${color.dim}  Edit the sftp block, then run: ftporter test${color.reset}`);
	console.log(`${color.dim}  Add it to .gitignore if it ends up holding a password.${color.reset}`);
	return 0;
}

function printConfig(config) {
	const redacted = {
		...config,
		sftp: {
			...config.sftp,
			password: config.sftp.password ? '***' : null,
			passphrase: config.sftp.passphrase ? '***' : null,
		},
	};
	delete redacted.profiles;
	delete redacted.targets;
	console.log(JSON.stringify(redacted, null, 2));
	return 0;
}

export { HELP };
