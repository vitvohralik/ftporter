import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expandHome, isPlainObject, merge, parseDuration, sha1, UserError } from './util.mjs';

/** Config file names, in priority order, searched from the working directory upwards. */
export const CONFIG_NAMES = [
	'ftporter.config.js',
	'ftporter.config.mjs',
	'ftporter.config.cjs',
	'ftporter.config.json',
	'ftporter.config.jsonc',
	'.ftporter.json',
	'.ftporter.jsonc',
	'ftporter.json',
];

export const STRATEGIES = ['git', 'whitelist', 'blacklist'];

/** Directories a walk never descends into, on top of whatever the user configures. */
export const DEFAULT_IGNORED = ['.git', '.svn', '.hg', '.DS_Store', '.idea', '.vscode', ...CONFIG_NAMES];

export const DEFAULTS = {
	root: '.',
	strategy: 'git',
	include: [],
	exclude: [],
	roots: null,
	delete: true,
	deleteCap: 50,
	preserveTimestamps: true,
	chmod: null,
	followSymlinks: false,
	mtimeToleranceMs: 2000,
	concurrency: { scan: 64, io: 8 },
	watch: {
		debounce: 300,
		interval: null,
		ignored: ['node_modules', 'vendor', '.git'],
		usePolling: false,
		pollInterval: 400,
	},
	hooks: { beforeSync: null, afterSync: null, onError: null },
	sftp: {
		host: null,
		port: 22,
		username: null,
		remoteRoot: null,
		privateKey: null,
		passphrase: null,
		password: null,
		agent: null,
		readyTimeout: 20_000,
		keepaliveInterval: 10_000,
		strictHostKey: false,
	},
	stateFile: null,
	profiles: {},
	targets: {},
	defaultTarget: null,
};

// ──────────────────────────────────────────────────────────────────────────────
// Finding and reading the file
// ──────────────────────────────────────────────────────────────────────────────

/** Walks up from `from` until a config file turns up, or the filesystem root is reached. */
export function findConfigFile(from = process.cwd()) {
	let dir = path.resolve(from);
	for (;;) {
		for (const name of CONFIG_NAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Strips `//` and `/* *\/` comments plus trailing commas, so `.jsonc` files are accepted. */
export function parseJsonc(text, file) {
	const stripped = text
		.replaceAll(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ''))
		.replaceAll(/,(\s*[}\]])/g, '$1');
	try {
		return JSON.parse(stripped);
	} catch (err) {
		throw new UserError(`${path.basename(file)}: ${err.message}`);
	}
}

async function readConfigFile(file) {
	if (/\.(js|mjs|cjs)$/.test(file)) {
		const mod = await import(pathToFileURL(file).href);
		const value = mod.default ?? mod.config ?? mod;
		const resolved = typeof value === 'function' ? await value() : value;
		if (!isPlainObject(resolved)) throw new UserError(`${path.basename(file)}: must export an object`);
		return resolved;
	}
	const raw = fs.readFileSync(file, 'utf8');
	const parsed = parseJsonc(raw, file);
	if (!isPlainObject(parsed)) throw new UserError(`${path.basename(file)}: must contain an object`);
	return parsed;
}

// ──────────────────────────────────────────────────────────────────────────────
// Environment interpolation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Replaces `${VAR}` and `${VAR:-fallback}` in every string of the config, so secrets can stay in
 * the environment (or a shell profile) while the config file itself is safe to commit.
 * `$${` escapes a literal `${`.
 */
export function interpolate(value, env = process.env) {
	if (typeof value === 'string') {
		return value.replaceAll(/\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, escape, name, fallback) =>
			escape ? all.slice(1) : (env[name] ?? fallback ?? ''),
		);
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, env));
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
	}
	return value;
}

/** Env overrides applied last but one, before CLI flags. */
function envOverrides(env = process.env) {
	const sftp = {};
	const map = {
		FTPORTER_HOST: 'host',
		FTPORTER_PORT: 'port',
		FTPORTER_USER: 'username',
		FTPORTER_USERNAME: 'username',
		FTPORTER_REMOTE_ROOT: 'remoteRoot',
		FTPORTER_KEY: 'privateKey',
		FTPORTER_PASSPHRASE: 'passphrase',
		FTPORTER_PASSWORD: 'password',
		FTPORTER_AGENT: 'agent',
	};
	for (const [name, key] of Object.entries(map)) {
		if (env[name]) sftp[key] = key === 'port' ? Number(env[name]) : env[name];
	}
	const out = {};
	if (Object.keys(sftp).length) out.sftp = sftp;
	if (env.FTPORTER_ROOT) out.root = env.FTPORTER_ROOT;
	if (env.FTPORTER_STRATEGY) out.strategy = env.FTPORTER_STRATEGY;
	return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Resolution
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds the config the engine actually runs on.
 *
 * Precedence, lowest first:
 *   built-in defaults → config file → selected target → selected profile → environment → CLI flags
 *
 * A target may carry its own `profiles`, so `--target prod --profile assets` picks up both the
 * production credentials and the production-specific asset paths.
 */
export async function loadConfig(cli = {}, { cwd = process.cwd(), env = process.env } = {}) {
	const configFile = cli.config
		? path.resolve(cwd, expandHome(cli.config))
		: (env.FTPORTER_CONFIG ? path.resolve(cwd, expandHome(env.FTPORTER_CONFIG)) : findConfigFile(cwd));

	if (cli.config && !fs.existsSync(configFile)) throw new UserError(`config file not found: ${configFile}`);

	let file = {};
	if (configFile) {
		if (!fs.existsSync(configFile)) throw new UserError(`config file not found: ${configFile}`);
		file = interpolate(await readConfigFile(configFile), env);
	} else if (!cli.allowMissingConfig) {
		throw new UserError(
			`no config file found in ${cwd} or any parent directory`,
			'Run `ftporter init` to create one.',
		);
	}

	const targetName = cli.target ?? env.FTPORTER_TARGET ?? file.defaultTarget ?? null;
	const targets = file.targets ?? {};
	if (targetName && !targets[targetName]) {
		const known = Object.keys(targets).join(', ') || 'none defined';
		throw new UserError(`unknown target '${targetName}' (known targets: ${known})`);
	}
	const target = targetName ? targets[targetName] : {};

	const profileName = cli.profile ?? 'default';
	const profiles = merge(file.profiles ?? {}, target.profiles ?? {});
	if (profileName !== 'default' && !profiles[profileName]) {
		const known = Object.keys(profiles).join(', ') || 'none defined';
		throw new UserError(`unknown profile '${profileName}' (known profiles: ${known})`);
	}
	const profile = profileName === 'default' ? (profiles.default ?? {}) : profiles[profileName];

	let resolved = DEFAULTS;
	for (const layer of [stripMeta(file), stripMeta(target), stripMeta(profile), envOverrides(env), cliOverrides(cli)]) {
		resolved = merge(resolved, layer);
	}

	const baseDir = configFile ? path.dirname(configFile) : cwd;
	const root = path.resolve(baseDir, expandHome(cli.root ?? resolved.root ?? '.'));

	// `--include` / `--exclude` add to what the config says rather than replacing it: a one-off run
	// should be able to narrow the set without silently dropping the project's own rules.
	const include = [...(resolved.include ?? []), ...(cli.include ?? [])];
	const exclude = [...(resolved.exclude ?? []), ...(cli.exclude ?? [])];

	const config = {
		...resolved,
		include,
		exclude,
		configFile,
		root,
		targetName,
		profileName,
		label: profileName === 'default' ? 'files' : profileName,
		sftp: {
			...resolved.sftp,
			privateKey: resolved.sftp.privateKey ? expandHome(resolved.sftp.privateKey) : null,
			port: Number(resolved.sftp.port) || 22,
			remoteRoot: normalizeRemote(resolved.sftp.remoteRoot),
		},
		watch: {
			...resolved.watch,
			interval: parseDuration(resolved.watch.interval),
			debounce: parseDuration(resolved.watch.debounce) ?? 300,
		},
		mtimeToleranceMs: Number(resolved.mtimeToleranceMs) || 0,
		chmod: parseChmod(resolved.chmod),
		deleteCap: resolved.deleteCap === null || resolved.deleteCap === false ? null : Number(resolved.deleteCap),
	};

	config.stateFile = resolveStateFile(config);
	config.target = `${config.sftp.username}@${config.sftp.host}:${config.sftp.remoteRoot}`;
	validate(config);
	return config;
}

/** Keys that only steer resolution and must not leak into the resolved config. */
const stripMeta = (layer) => {
	const { profiles, targets, defaultTarget, $schema, ...rest } = layer ?? {};
	return rest;
};

function cliOverrides(cli) {
	const out = {};
	const sftp = {};
	if (cli.host) sftp.host = cli.host;
	if (cli.port) sftp.port = Number(cli.port);
	if (cli.username) sftp.username = cli.username;
	if (cli.remoteRoot) sftp.remoteRoot = cli.remoteRoot;
	if (cli.key) sftp.privateKey = cli.key;
	if (Object.keys(sftp).length) out.sftp = sftp;

	if (cli.strategy) out.strategy = cli.strategy;
	if (cli.delete === false) out.delete = false;
	if (cli.delete === true) out.delete = true;
	if (cli.interval) out.watch = { interval: cli.interval };
	return out;
}

const normalizeRemote = (value) => (value ? String(value).replace(/\/+$/, '') || '/' : value);

function parseChmod(value) {
	if (value === null || value === undefined || value === false) return null;
	const mode = typeof value === 'number' ? value : Number.parseInt(String(value), 8);
	if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new UserError(`invalid chmod: ${value}`);
	return mode;
}

/**
 * The state file lives outside the project by default, keyed by root + remote target, so a repo
 * stays clean and two checkouts of the same project keep separate manifests. Point `stateFile`
 * anywhere (relative paths resolve against the project root) to keep it with the project instead.
 */
function resolveStateFile(config) {
	if (config.stateFile) return path.resolve(config.root, expandHome(config.stateFile));
	const stateHome =
		process.env.FTPORTER_STATE_DIR ||
		(process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'ftporter') : null) ||
		path.join(homedir(), '.local', 'state', 'ftporter');
	return path.join(stateHome, `${path.basename(config.root)}-${sha1(config.root).slice(0, 12)}.json`);
}

function validate(config) {
	for (const key of ['host', 'username', 'remoteRoot']) {
		if (!config.sftp[key]) throw new UserError(`missing sftp.${key} in the configuration`);
	}
	if (!STRATEGIES.includes(config.strategy)) {
		throw new UserError(`unknown strategy '${config.strategy}' (use: ${STRATEGIES.join(', ')})`);
	}
	if (!fs.existsSync(config.root)) throw new UserError(`project root does not exist: ${config.root}`);
	if (config.strategy === 'whitelist' && config.include.length === 0 && !config.roots) {
		throw new UserError(
			'strategy "whitelist" needs at least one entry in "include" (or "roots")',
			'Whitelist uploads only what you list, so an empty list would upload nothing.',
		);
	}
	if (config.sftp.privateKey && !fs.existsSync(config.sftp.privateKey)) {
		throw new UserError(`private key not found: ${config.sftp.privateKey}`);
	}
	if (!config.sftp.privateKey && !config.sftp.password && !config.sftp.agent) {
		throw new UserError(
			'no authentication configured — set sftp.privateKey, sftp.password or sftp.agent',
			'Typically: "privateKey": "~/.ssh/id_rsa", or "agent": "${SSH_AUTH_SOCK}".',
		);
	}
	if (config.watch.interval !== null && config.watch.interval < 1000) {
		throw new UserError('watch.interval must be at least 1s');
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// init template
// ──────────────────────────────────────────────────────────────────────────────

export const CONFIG_TEMPLATE = `{
  // ftporter configuration — https://github.com/vitvohralik/ftporter
  // Everything below is optional except the "sftp" block.

  // Project root that gets uploaded. Relative to this file.
  "root": ".",

  "sftp": {
    "host": "example.com",
    "port": 22,
    "username": "deploy",
    "remoteRoot": "/var/www/example",

    // Key auth (passphrase-free key, or set "passphrase"). "~/" expands to your home directory.
    "privateKey": "~/.ssh/id_rsa",

    // Anything can read from the environment: "password": "\${DEPLOY_PASSWORD}"
    // or use the running ssh-agent: "agent": "\${SSH_AUTH_SOCK}"
  },

  // How the file list is decided:
  //   "git"       — everything git tracks or would track (.gitignore is respected)   [default]
  //   "whitelist" — only what "include" lists
  //   "blacklist" — everything under root except what "exclude" lists
  "strategy": "git",

  // include adds paths the strategy would miss, exclude removes paths — exclude always wins.
  "include": [],
  "exclude": [".env", "*.log", "node_modules", "vendor"],

  // Remove files on the server after they disappear locally (only ever files this tool uploaded).
  "delete": true,
  "deleteCap": 50,

  "watch": {
    "debounce": 300,
    // Set to e.g. "5m" to also run a full pass on a timer (\`ftporter patrol\`).
    "interval": null,
    "ignored": ["node_modules", "vendor", ".git"]
  },

  // Named variants of the config above, picked with --profile <name>.
  "profiles": {
    // "assets": { "strategy": "whitelist", "include": ["public/build", "public/css"], "deleteCap": 500 }
  },

  // Named servers, picked with --target <name>. Each one overrides the settings above.
  "targets": {
    // "prod": { "sftp": { "host": "prod.example.com", "remoteRoot": "/var/www/prod" }, "delete": false }
  }
}
`;
