import fs from 'node:fs';
import path from 'node:path';

import { Client } from 'ssh2';

import { UserError } from './util.mjs';

export const SFTP_NO_SUCH_FILE = 2;
export const SFTP_PERMISSION_DENIED = 3;

/**
 * A thin promise layer over ssh2.
 *
 * ssh2-sftp-client is deliberately avoided: it attaches temporary listeners to every operation, so
 * requests cannot be issued concurrently over a single connection. Scanning a mid-sized project
 * that way takes ~50 s instead of ~1 s.
 *
 * The session survives a dropped connection: any call that fails because the transport went away
 * reconnects once and runs again. That matters for `watch` and `patrol`, which hold a connection
 * open for hours, and for servers with an idle timeout.
 */
export class SftpSession {
	constructor(config, logger) {
		this.config = config;
		this.logger = logger;
		this.remoteRoot = config.sftp.remoteRoot;
		this.conn = null;
		this.sftp = null;
		this.closing = false;
		this.connecting = null;
	}

	static async open(config, logger) {
		const session = new SftpSession(config, logger);
		await session.connect();
		return session;
	}

	async connect() {
		if (this.sftp) return this.sftp;
		this.connecting ??= this.#doConnect().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	async #doConnect() {
		const { sftp: cfg, target } = this.config;
		const conn = new Client();

		const options = {
			host: cfg.host,
			port: cfg.port,
			username: cfg.username,
			readyTimeout: cfg.readyTimeout,
			keepaliveInterval: cfg.keepaliveInterval,
		};
		if (cfg.privateKey) {
			options.privateKey = fs.readFileSync(cfg.privateKey);
			if (cfg.passphrase) options.passphrase = cfg.passphrase;
		}
		if (cfg.password) {
			options.password = cfg.password;
			options.tryKeyboard = true;
		}
		if (cfg.agent) options.agent = cfg.agent;

		await new Promise((resolve, reject) => {
			conn
				.on('ready', resolve)
				.on('error', reject)
				.on('keyboard-interactive', (_n, _i, _l, prompts, finish) =>
					finish(prompts.map(() => cfg.password ?? '')),
				)
				.connect(options);
		}).catch((err) => {
			throw new UserError(`cannot connect to ${target}: ${err.message}`, authHint(err, cfg));
		});

		const sftp = await new Promise((resolve, reject) => {
			conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
		});

		// A drop mid-run would otherwise surface as an unhandled exception. Losing the handles here
		// makes the next call reconnect instead.
		const forget = () => {
			this.conn = null;
			this.sftp = null;
		};
		conn.on('error', (err) => {
			forget();
			if (!this.closing) this.logger.warn(`connection to ${target} lost: ${err.message}`);
		});
		conn.on('close', forget);

		this.conn = conn;
		this.sftp = sftp;
		return sftp;
	}

	async #call(method, ...args) {
		for (let attempt = 0; ; attempt++) {
			const sftp = this.sftp ?? (await this.connect());
			try {
				return await new Promise((resolve, reject) => {
					sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
				});
			} catch (err) {
				if (attempt > 0 || this.closing || !isTransportError(err)) throw err;
				this.logger.trace(`reconnecting after: ${err.message}`);
				this.sftp = null;
				this.conn = null;
			}
		}
	}

	remotePath(rel) {
		if (!rel) return this.remoteRoot;
		return this.remoteRoot === '/' ? `/${rel}` : `${this.remoteRoot}/${rel}`;
	}

	readdir(rel) {
		return this.#call('readdir', this.remotePath(rel));
	}

	put(rel, localRoot) {
		return this.#call('fastPut', path.join(localRoot, rel), this.remotePath(rel));
	}

	mkdir(rel) {
		return this.#call('mkdir', this.remotePath(rel));
	}

	mkdirAbs(abs) {
		return this.#call('mkdir', abs);
	}

	readdirAbs(abs) {
		return this.#call('readdir', abs);
	}

	rmdirAbs(abs) {
		return this.#call('rmdir', abs);
	}

	rmdir(rel) {
		return this.#call('rmdir', this.remotePath(rel));
	}

	unlink(rel) {
		return this.#call('unlink', this.remotePath(rel));
	}

	stat(rel) {
		return this.#call('stat', this.remotePath(rel));
	}

	chmod(rel, mode) {
		return this.#call('chmod', this.remotePath(rel), mode);
	}

	utimes(rel, mtimeMs) {
		const t = Math.floor(mtimeMs / 1000);
		return this.#call('utimes', this.remotePath(rel), t, t);
	}

	end() {
		this.closing = true;
		this.conn?.end();
		this.conn = null;
		this.sftp = null;
	}
}

const isTransportError = (err) =>
	/not connected|no response|channel|closed|ECONNRESET|EPIPE|timed out/i.test(err?.message ?? '');

function authHint(err, cfg) {
	const message = err?.message ?? '';
	if (/All configured authentication methods failed/i.test(message)) {
		if (cfg.privateKey) {
			return `Key ${cfg.privateKey} was rejected. Check that its public half is in the server's authorized_keys, and that the key has no passphrase (or set "passphrase").`;
		}
		return 'Check the username and password, or configure "privateKey".';
	}
	if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'The hostname could not be resolved.';
	if (/ECONNREFUSED/i.test(message)) return `Nothing is listening on port ${cfg.port}.`;
	if (/Encrypted private key/i.test(message)) return 'The key is encrypted — set "passphrase" or use a passphrase-free key.';
	return undefined;
}
