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

/**
 * How to reach the server, in FileZilla's terms:
 *   sftp          — SSH file transfer. The original behaviour and still the default.
 *   ftps          — FTP with explicit TLS, required: a server that cannot do TLS is an error.
 *   ftp           — plain FTP that still upgrades to TLS whenever the server offers it, and only
 *                   falls back to an unencrypted session when it does not.
 *   ftps-implicit — legacy FTPS, TLS from the first byte (usually port 990).
 */
export const PROTOCOLS = ['sftp', 'ftps', 'ftp', 'ftps-implicit'];

export const DEFAULT_PORTS = { sftp: 22, ftps: 21, ftp: 21, 'ftps-implicit': 990 };

/** The one block that carries connection settings, at every level of the file. */
const CONNECTION_BLOCK = 'server';

/**
 * Block names 1.x used, where the name itself picked the protocol. They are refused rather than
 * silently ignored: a `"sftp"` block left in place would drop the host, the credentials and the
 * remote root in one go, and the run would fail with "missing server.host" — which says nothing
 * about the block sitting right there in the file.
 */
const LEGACY_BLOCKS = ['sftp', 'ftps', 'ftp', 'connection'];

/** Connection settings that only mean anything over SSH. */
const SSH_ONLY = ['privateKey', 'passphrase', 'agent'];

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
	atomicUpload: true,
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
	protocol: 'sftp',
	connection: {
		host: null,
		// null means "whatever the protocol uses" — 22 for SFTP, 21 for FTP/FTPS, 990 for implicit.
		port: null,
		username: null,
		remoteRoot: null,
		// SFTP only.
		privateKey: null,
		passphrase: null,
		password: null,
		agent: null,
		readyTimeout: 20_000,
		keepaliveInterval: 10_000,
		strictHostKey: false,
		// FTP only.
		rejectUnauthorized: true,
		connections: 4,
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
	const connection = {};
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
		if (env[name]) connection[key] = key === 'port' ? Number(env[name]) : env[name];
	}
	const out = {};
	if (Object.keys(connection).length) out.connection = connection;
	if (env.FTPORTER_ROOT) out.root = env.FTPORTER_ROOT;
	if (env.FTPORTER_STRATEGY) out.strategy = env.FTPORTER_STRATEGY;
	if (env.FTPORTER_PROTOCOL) out.protocol = env.FTPORTER_PROTOCOL;
	return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Connection block
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Folds a layer's `server` block into the internal `connection` block.
 *
 * One block name at every level, and `"protocol"` inside it says how to get there. 1.x picked the
 * protocol from the block's *name* — `"sftp"`, `"ftp"`, `"ftps"` — which meant a target could not
 * change protocol without being rewritten, implicit FTPS had no name at all, and every layer of the
 * merge had to agree on which of four keys it was looking at. `"protocol"` is a value like any
 * other, so it merges, a target overrides it, and `--protocol` can override that in turn.
 */
function normalizeLayer(layer, where = 'the configuration') {
	const { profiles, targets, defaultTarget, $schema, protocol, ...rest } = layer ?? {};

	checkLegacyBlocks(layer, where);
	delete rest[CONNECTION_BLOCK];

	const out = rest;
	if (protocol) out.protocol = normalizeProtocol(protocol);
	if (isPlainObject(layer?.[CONNECTION_BLOCK])) {
		const { protocol: inner, ...fields } = layer[CONNECTION_BLOCK];
		out.connection = fields;
		if (inner) out.protocol = normalizeProtocol(inner);
	}
	return out;
}

/**
 * Stops on a 1.x connection block instead of quietly ignoring it.
 *
 * `where` names the level, since `targets` and `profiles` may each carry their own block and "which
 * one of them" is the whole question when this fires.
 */
function checkLegacyBlocks(layer, where) {
	// In the order the file writes them, so the message reads like the config the user is looking at.
	const found = Object.keys(layer ?? {}).filter((name) => LEGACY_BLOCKS.includes(name) && isPlainObject(layer[name]));
	if (found.length === 0) return;

	const protocol = found.find((name) => PROTOCOLS.includes(name)) ?? 'sftp';
	throw new UserError(
		`${where} uses the 1.x connection block ${found.map((name) => `"${name}"`).join(' and ')}`,
		`Rename it to "server" and say the protocol inside it: "server": { "protocol": "${protocol}", … }.` +
			' See the 2.0.0 entry in the changelog.',
	);
}

/**
 * Every level of the file, whether this run selects it or not.
 *
 * A legacy block inside `targets.prod` is a broken config the moment it is written, not the moment
 * somebody happens to run `--target prod`, and finding it then means finding it in production.
 */
function checkConnectionBlocks(file) {
	checkLegacyBlocks(file, 'the configuration');
	for (const [name, profile] of Object.entries(file.profiles ?? {})) {
		checkLegacyBlocks(profile, `profile "${name}"`);
	}
	for (const [name, target] of Object.entries(file.targets ?? {})) {
		checkLegacyBlocks(target, `target "${name}"`);
		for (const [inner, profile] of Object.entries(target?.profiles ?? {})) {
			checkLegacyBlocks(profile, `profile "${inner}" of target "${name}"`);
		}
	}
}

function normalizeProtocol(value) {
	const name = String(value).trim().toLowerCase();
	const alias = { ftpes: 'ftps', 'ftp-tls': 'ftps', 'ftps-explicit': 'ftps', 'implicit-ftps': 'ftps-implicit' }[name];
	return alias ?? name;
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

	// Checked across the whole file before anything is selected: a target nobody asked for today is
	// still broken, and it should say so now rather than on the run that first reaches for it.
	checkConnectionBlocks(file);

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

	const layers = [
		normalizeLayer(file),
		normalizeLayer(target, `target "${targetName}"`),
		normalizeLayer(profile, `profile "${profileName}"`),
		envOverrides(env),
		cliOverrides(cli),
	];
	let resolved = { ...DEFAULTS };
	for (const layer of layers) resolved = merge(resolved, layer);

	const protocol = resolved.protocol ?? DEFAULTS.protocol;
	if (!PROTOCOLS.includes(protocol)) {
		throw new UserError(`unknown protocol '${protocol}' (use: ${PROTOCOLS.join(', ')})`);
	}

	/**
	 * Whether a protocol-specific setting was written for a protocol this run is not using.
	 *
	 * The everyday case is a keyed SFTP base with one FTPS target for shared hosting. Merging alone
	 * would hand that target port 22 and the SSH key from the block below it — settings written for
	 * a server it has nothing to do with, one of which is nonsense over FTP and the other of which
	 * `validate` rightly refuses to pretend is in use. So each of them is read together with the
	 * protocol that was in force where it was written, and dropped when the two disagree.
	 *
	 * Asked only about the port and the three SSH-only keys: the host, the username, the remote root
	 * and the password mean the same thing whichever protocol carries them, and retiring those would
	 * break a target that changes nothing but the protocol. And naming an SSH key and an FTP
	 * protocol in the *same* block is still the mistake it looks like — same layer, same protocol,
	 * nothing retired, and the run stops.
	 */
	const protocolIn = (upTo) => {
		for (let at = upTo; at >= 0; at--) if (layers[at].protocol != null) return layers[at].protocol;
		return DEFAULTS.protocol;
	};
	const outdated = (key) => {
		const at = layers.reduce((last, layer, index) => (layer.connection?.[key] != null ? index : last), -1);
		return at !== -1 && protocolIn(at) !== protocol;
	};

	const baseDir = configFile ? path.dirname(configFile) : cwd;
	const root = path.resolve(baseDir, expandHome(cli.root ?? resolved.root ?? '.'));

	// `--include` / `--exclude` add to what the config says rather than replacing it: a one-off run
	// should be able to narrow the set without silently dropping the project's own rules.
	const include = [...(resolved.include ?? []), ...(cli.include ?? [])];
	const exclude = [...(resolved.exclude ?? []), ...(cli.exclude ?? [])];

	const config = {
		...resolved,
		protocol,
		include,
		exclude,
		configFile,
		root,
		targetName,
		profileName,
		// What else this config file offers. Only interactive mode uses them — it cycles through the
		// targets and profiles at runtime and has no other way to learn their names, since the blocks
		// that declare them are stripped out of every resolved layer.
		knownTargets: Object.keys(targets),
		knownProfiles: [...new Set(['default', ...Object.keys(profiles)])],
		label: profileName === 'default' ? 'files' : profileName,
		connection: {
			...resolved.connection,
			...Object.fromEntries(SSH_ONLY.filter(outdated).map((key) => [key, null])),
			privateKey:
				resolved.connection.privateKey && !outdated('privateKey')
					? expandHome(resolved.connection.privateKey)
					: null,
			port: (!outdated('port') && Number(resolved.connection.port)) || DEFAULT_PORTS[protocol],
			remoteRoot: normalizeRemote(resolved.connection.remoteRoot),
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
	// The SFTP form is left exactly as it was: this string keys the manifest, and changing it would
	// silently orphan every state file already on disk.
	const where = `${config.connection.username}@${config.connection.host}:${config.connection.remoteRoot}`;
	config.target = protocol === 'sftp' ? where : `${protocol}://${where}`;
	validate(config);
	return config;
}

function cliOverrides(cli) {
	const out = {};
	const connection = {};
	if (cli.host) connection.host = cli.host;
	if (cli.port) connection.port = Number(cli.port);
	if (cli.username) connection.username = cli.username;
	if (cli.remoteRoot) connection.remoteRoot = cli.remoteRoot;
	if (cli.key) connection.privateKey = cli.key;
	if (cli.password) connection.password = cli.password;
	if (Object.keys(connection).length) out.connection = connection;

	if (cli.protocol) out.protocol = normalizeProtocol(cli.protocol);
	if (cli.strategy) out.strategy = cli.strategy;
	if (cli.delete === false) out.delete = false;
	if (cli.delete === true) out.delete = true;
	if (cli.atomicUpload === false) out.atomicUpload = false;
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
	const { protocol } = config;
	for (const key of ['host', 'username', 'remoteRoot']) {
		if (!config.connection[key]) throw new UserError(`missing server.${key} in the configuration`);
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
	if (protocol === 'sftp') {
		if (config.connection.privateKey && !fs.existsSync(config.connection.privateKey)) {
			throw new UserError(`private key not found: ${config.connection.privateKey}`);
		}
		if (!config.connection.privateKey && !config.connection.password && !config.connection.agent) {
			throw new UserError(
				'no authentication configured — set server.privateKey, server.password or server.agent',
				'Typically: "privateKey": "~/.ssh/id_rsa", or "agent": "${SSH_AUTH_SOCK}".',
			);
		}
	} else {
		// Keys are an SSH concept; silently ignoring one here would look like it was in use.
		for (const key of SSH_ONLY) {
			if (config.connection[key]) {
				throw new UserError(
					`server.${key} is an SFTP setting and does nothing over ${protocol.toUpperCase()}`,
					'FTP authenticates with a username and a password. Use "protocol": "sftp" for key authentication.',
				);
			}
		}
		if (!config.connection.password && config.connection.username !== 'anonymous') {
			throw new UserError(
				'no password configured — set server.password',
				'Keep it out of the file with "password": "${DEPLOY_PASSWORD}", or use "username": "anonymous".',
			);
		}
		if (!(Number(config.connection.connections) > 0)) {
			throw new UserError('server.connections must be at least 1');
		}
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
  // Everything below is optional except the "server" block.
  // Run \`ftporter\` to open the session (S uploads), or \`ftporter sync\` for a single pass.

  // Project root that gets uploaded. Relative to this file.
  "root": ".",

  // ── Connection ────────────────────────────────────────────────────────────
  "server": {
    // "protocol" picks the transport:
    //   "sftp"  — file transfer over SSH (port 22)                                      [default]
    //   "ftps"  — FTP with TLS, required: no TLS on the server means no upload (port 21)
    //   "ftp"   — FTP that upgrades to TLS when the server offers it, plain when it does not
    //   "ftps-implicit" — legacy FTPS encrypted from the first byte (port 990)
    "protocol": "sftp",

    "host": "example.com",
    "port": 22,
    "username": "deploy",
    "remoteRoot": "/var/www/example",

    // Key auth (passphrase-free key, or set "passphrase"). "~/" expands to your home directory.
    // SFTP only — FTP and FTPS log in with a password.
    "privateKey": "~/.ssh/id_rsa",

    // Anything can read from the environment: "password": "\${DEPLOY_PASSWORD}"
    // or use the running ssh-agent: "agent": "\${SSH_AUTH_SOCK}"

    // FTP/FTPS only:
    // "rejectUnauthorized": false   // accept a self-signed certificate
    // "connections": 4              // parallel FTP connections (servers often cap these)
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

  // Named servers, picked with --target <name>. Each one overrides the settings above,
  // protocol included — a target may use a different one than the block above.
  "targets": {
    // "prod": { "server": { "host": "prod.example.com", "remoteRoot": "/var/www/prod" }, "delete": false },
    // "shared": { "server": { "protocol": "ftps", "host": "ftp.example.com", "username": "web123", "password": "\${FTP_PASSWORD}", "remoteRoot": "/www" } }
  }
}
`;
