import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_NAMES, CONFIG_TEMPLATE, loadConfig, PROTOCOLS, STRATEGIES } from './config.mjs';
import { forgetManifest } from './state.mjs';
import { listRemote, prune, reconcile } from './engine.mjs';
import { runHook } from './hooks.mjs';
import { runInteractive } from './interactive.mjs';
import { color, createLogger } from './logger.mjs';
import { openSession } from './session.mjs';
import { runWatch } from './watch.mjs';
import { formatDuration, parseDuration, UserError } from './util.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const COMMANDS = ['ui', 'sync', 'watch', 'patrol', 'status', 'list', 'prune', 'test', 'init', 'config', 'forget'];

/** Commands that take one path after the command name. */
const TAKES_PATH = new Set(['list']);

const HELP = `
${color.bold}ftporter${color.reset} — your files' porter: SFTP/FTPS/FTP deploy, watcher and interval patrol

  Usage: ftporter [command] [options]

${color.bold}Commands${color.reset}
  ${color.dim}(none)${color.reset}              Open the interactive session: one connection, held open, and keys
                      to sync on demand — ${color.bold}S${color.reset}ync, ${color.bold}n${color.reset} dry-run, ${color.bold}W${color.reset}atch, patrol (${color.bold}I${color.reset}), ${color.bold}l${color.reset}ist, ${color.bold}p${color.reset}rune, ${color.bold}T${color.reset}arget, ${color.bold}P${color.reset}rofile, ${color.bold}q${color.reset}uit.
                      ${color.dim}Capitals change something, small letters only look.${color.reset}
                      ${color.dim}Without a terminal this runs one pass instead.${color.reset}
  sync                One pass: upload what changed, delete what is gone.
  watch               Stay running and upload on every save.
  patrol              Stay running and run a full pass on a timer (--interval).
  status              Show what a sync would do, change nothing. ${color.dim}(= sync --dry-run)${color.reset}
  list [path]         List a directory on the server. ${color.dim}Defaults to the remote root; a relative${color.reset}
                      ${color.dim}path is taken from it, a leading / is absolute.${color.reset}
  prune               List files on the server nobody knows about. Lists only until --force;
                      --temp narrows it to leftovers from interrupted uploads.
  test                Check the connection and the remote root, upload nothing.
  init                Write a commented config file into the current directory.
  config              Print the resolved configuration (secrets redacted).
  forget              Delete this run's manifest. --all covers every target and profile of
                      the project; --everything takes the config file with it (needs -f).

${color.bold}Options${color.reset}
  -c, --config <file>     Config file to use ${color.dim}(default: nearest ${CONFIG_NAMES[3]} upwards)${color.reset}
  -t, --target <name>     Named server from "targets"
  -p, --profile <name>    Named variant from "profiles"
      --root <dir>        Project root to upload
  -n, --dry-run           Print what would happen, change nothing
  -w, --watch             Same as the watch command
  -i, --interval <time>   Full pass every 30s / 5m / 1h ${color.dim}(with watch or patrol)${color.reset}
      --strategy <name>   ${STRATEGIES.join(' | ')}
      --protocol <name>   ${PROTOCOLS.join(' | ')} ${color.dim}(default: sftp, or what "server" says)${color.reset}
      --include <glob>    Extra path to upload ${color.dim}(repeatable, added to the config)${color.reset}
      --exclude <glob>    Extra path to skip ${color.dim}(repeatable, wins over include)${color.reset}
      --no-delete         Upload only, never delete
      --no-atomic         Write straight onto the target (faster, unsafe while in use)
      --temp              With prune: only .ftporter-tmp.* leftovers, anywhere on the server
      --all               With forget: every target and profile, not just this run's
      --everything        With forget: the config file too — nothing is left behind
  -f, --force             Allow a delete count over the cap; confirm prune
      --host/--user/--password/--port/--remote-root/--key   Override the connection for one run
  -v, --verbose           Show timings
  -q, --quiet             Only errors
      --json              Print a JSON summary instead of the usual output
  -h, --help              This help
      --version           Print the version

${color.bold}Examples${color.reset}
  ftporter                          ${color.dim}# interactive: press S when you want it uploaded${color.reset}
  ftporter sync                     ${color.dim}# one pass, no questions${color.reset}
  ftporter watch                    ${color.dim}# upload on save${color.reset}
  ftporter patrol -i 5m             ${color.dim}# full pass every five minutes${color.reset}
  ftporter -t prod -n               ${color.dim}# what would go to production?${color.reset}
  ftporter list                     ${color.dim}# what is in the remote root?${color.reset}
  ftporter list public/build        ${color.dim}# and in one directory under it${color.reset}
  ftporter -p assets --no-delete    ${color.dim}# just the build output${color.reset}
  ftporter --protocol ftps          ${color.dim}# same config, over FTP with TLS${color.reset}
  ftporter forget                   ${color.dim}# start the manifest over on the next run${color.reset}

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
	'--all': 'all',
	'--everything': 'everything',
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
	'--protocol': 'protocol',
	'--host': 'host',
	'--user': 'username',
	'--username': 'username',
	'--port': 'port',
	'--remote-root': 'remoteRoot',
	'--key': 'key',
	'--password': 'password',
};

export function parseArgs(argv) {
	const opts = { include: [], exclude: [] };
	let command = null;

	for (let i = 0; i < argv.length; i++) {
		// `--name=value` is split before anything looks at the name, so the two spellings of every
		// option meet the same rules from here on — including the repeat check below, which the
		// `=` form used to walk straight past.
		let arg = argv[i];
		let attached;
		const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
		if (eq > 2) {
			attached = arg.slice(eq + 1);
			arg = arg.slice(0, eq);
		}
		const value = () => {
			const given = attached ?? argv[++i];
			if (given === undefined) throw new UserError(`${arg} needs a value`);
			return given;
		};

		if (arg === '--include' || arg === '--exclude') {
			opts[arg === '--include' ? 'include' : 'exclude'].push(value());
			continue;
		}
		if (VALUES[arg]) {
			const given = value();
			// Silently keeping the last one turned `-p node -p vendor` into a run against `vendor`
			// alone, which looks like both were used until the file list says otherwise.
			if (opts[VALUES[arg]] !== undefined && opts[VALUES[arg]] !== given) {
				throw new UserError(
					`${arg} given twice ('${opts[VALUES[arg]]}' and '${given}')`,
					'Only one can apply — run the command once for each.',
				);
			}
			opts[VALUES[arg]] = given;
			continue;
		}
		if (FLAGS[arg]) {
			// `--dry-run=true` is a misunderstanding worth naming: the flag would come out true either
			// way, so accepting it silently teaches a spelling that does nothing.
			if (attached !== undefined) throw new UserError(`${arg} takes no value (got '${attached}')`);
			opts[FLAGS[arg]] = true;
			continue;
		}
		if (arg.startsWith('-')) throw new UserError(`unknown option '${arg}' (see --help)`);
		if (command) {
			// A second bare word is a path for the commands that take one, and a mistake everywhere else.
			if (!TAKES_PATH.has(command)) throw new UserError(`unexpected argument '${arg}'`);
			if (opts.path !== undefined) throw new UserError(`${command} takes one path, not two`);
			opts.path = arg;
			continue;
		}
		if (!COMMANDS.includes(arg)) {
			throw new UserError(`unknown command '${arg}' (known: ${COMMANDS.join(', ')})`);
		}
		command = arg;
	}

	opts.command = command ?? null;
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
	if (opts.command === 'forget') return forgetState(config, logger, opts);

	// Typing the program's name opens the program — the bargain every terminal UI makes.
	// One-off work says so: `sync`, `status`, `watch`. Without a terminal there is nothing to open
	// and no ambiguity about what was meant, so a bare run stays the one pass it has always been;
	// that keeps every cron job and CI step written against 1.x working untouched.
	const interactive = opts.command === 'ui' || (opts.command === null && process.stdin.isTTY && process.stdout.isTTY);
	if (opts.command === 'ui' && !(process.stdin.isTTY && process.stdout.isTTY)) {
		throw new UserError('interactive mode needs a terminal', 'Use `ftporter sync` for a one-off run.');
	}
	if (interactive) {
		logger.trace(`config ${config.configFile ?? '(none)'} · root ${config.root}`);
		await runInteractive(config, logger, opts);
		return 0;
	}
	if (opts.command === null) {
		opts.command = 'sync';
		logger.trace('no terminal — running a single pass, as `ftporter sync` does');
	}

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

	const session = await openSession(config, logger);
	let exitCode = 0;
	try {
		switch (opts.command) {
			case 'test':
				await testConnection(session, config, logger);
				break;
			case 'list': {
				const listed = await listRemote(session, config, logger, opts);
				if (opts.json) {
					console.log(JSON.stringify({ ok: true, path: listed.path, entries: listed.entries }, null, 2));
				}
				break;
			}
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

	const parts = config.connection.remoteRoot.split('/').filter(Boolean);
	let base = null;
	for (let depth = parts.length; depth >= 0; depth--) {
		const abs = `/${parts.slice(0, depth).join('/')}`;
		const list = await session.readdirAbs(abs).catch(() => null);
		if (!list) continue;
		base = abs;
		if (depth === parts.length) logger.dim(`  remote root exists, ${list.length} entries`);
		else logger.warn(`remote root ${config.connection.remoteRoot} does not exist yet — the first upload would create it`);
		break;
	}

	if (base === null) {
		logger.warn(`cannot read any part of ${config.connection.remoteRoot}`);
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
	console.log(`${color.dim}  Edit the server block, then run: ftporter test${color.reset}`);
	console.log(`${color.dim}  Then just: ftporter${color.reset}`);
	console.log(`${color.dim}  Add it to .gitignore if it ends up holding a password.${color.reset}`);
	return 0;
}

/**
 * The configuration this run actually uses, printed in the shape a config file is written in.
 *
 * Internally the connection block is called `connection` and the protocol sits beside it; both are
 * put back the way the file spells them — `"server": { "protocol": … }` — so what comes out can be
 * read against what went in, and pasted back into a file if it is worth keeping. `targets` and
 * `profiles` are dropped: they are the alternatives to this run, and one of them is already
 * resolved into everything above.
 *
 * The rest is genuinely resolved rather than copied — `root`, `stateFile` and `configFile` are
 * absolute, `target` is where this run points, and `label`, `targetName`, `profileName`,
 * `knownTargets` and `knownProfiles` say which of the file's variants it picked.
 */
/**
 * Throws the local record away, so the next run starts from the server rather than from what this
 * machine remembers.
 *
 * Three depths, because "reset it" means three different things: the manifest for this target and
 * profile, every manifest of the project, or that plus the config file. The first two are safe by
 * construction — nothing on the server changes, and the next pass rebuilds what it needs from the
 * live server state, with only deletion unavailable until it does. The config file is not: it is
 * written by hand, it may hold the only copy of a password, and nothing rebuilds it. So it is the
 * one depth that lists first and waits for --force, the same bargain `prune` makes.
 */
function forgetState(config, logger, opts) {
	const everything = Boolean(opts.everything);
	const all = everything || Boolean(opts.all);

	if (everything && !opts.force) {
		logger.log(`  ? ${config.configFile ?? '(no config file)'}`);
		logger.dim('  the config file is written by hand and nothing rebuilds it');
		logger.dim('  Take it, and every manifest for this project, with: ftporter forget --everything --force');
		return 0;
	}

	const { sections, files, removedFile } = forgetManifest(config, { all, dryRun: opts.dryRun });
	const what = opts.dryRun ? 'would forget' : 'forgot';

	if (sections.length === 0) {
		logger.ok(all ? 'nothing recorded for this project' : `nothing recorded for ${config.target} (${config.profileName})`);
	} else {
		logger.ok(`${what} ${files} ${files === 1 ? 'file' : 'files'} in ${sections.length} ${sections.length === 1 ? 'manifest' : 'manifests'}`);
		for (const section of sections) logger.dim(`  ${section}`);
		if (removedFile) logger.dim(`  ${config.stateFile} is gone`);
		logger.dim('  The next pass reads the server and writes it again; until then nothing is deleted.');
	}

	if (everything && config.configFile) {
		if (!opts.dryRun) fs.rmSync(config.configFile, { force: true });
		logger.ok(`${opts.dryRun ? 'would remove' : 'removed'} ${config.configFile}`);
	}

	if (opts.json) {
		console.log(JSON.stringify({ ok: true, forgot: sections, files, stateFile: removedFile ? null : config.stateFile }, null, 2));
	}
	return 0;
}

function printConfig(config) {
	const server = {
		protocol: config.protocol,
		...config.connection,
		password: config.connection.password ? '***' : null,
		passphrase: config.connection.passphrase ? '***' : null,
	};

	// Rebuilt key by key so `server` keeps the place `connection` had, rather than being appended
	// after the resolved-run fields and reading as an afterthought.
	const printed = Object.fromEntries(
		Object.entries(config).flatMap(([key, value]) => {
			if (key === 'protocol' || key === 'profiles' || key === 'targets') return [];
			return [key === 'connection' ? ['server', server] : [key, value]];
		}),
	);

	console.log(JSON.stringify(printed, null, 2));
	return 0;
}

export { HELP };
