import fs from 'node:fs';
import path from 'node:path';

import { Client } from 'ssh2';

import { NO_SUCH_FILE, PERMISSION_DENIED, tempPath } from './session.mjs';
import { UserError } from './util.mjs';

export const SFTP_NO_SUCH_FILE = NO_SUCH_FILE;
export const SFTP_PERMISSION_DENIED = PERMISSION_DENIED;
export { TEMP_PREFIX } from './session.mjs';

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
		this.protocol = 'sftp';
		this.remoteRoot = config.connection.remoteRoot;
		this.conn = null;
		this.sftp = null;
		this.closing = false;
		this.connecting = null;
		// null = not asked yet, true/false = what the server answered the first time.
		this.posixRename = null;
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
		const { connection: cfg, target } = this.config;
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
		return this.readdirAbs(this.remotePath(rel));
	}

	/**
	 * Uploads one file, optionally setting its mode and mtime.
	 *
	 * With `atomicUpload` the bytes go to a temporary name next to the target and are renamed over
	 * it once the file is complete, stamped and chmodded — so the server never serves a half-written
	 * file, whatever kills the run, and two instances uploading the same path cannot interleave.
	 * Without it the bytes land straight on the target, which is faster to reason about but leaves
	 * that window open.
	 *
	 * @returns {Promise<{stamped: boolean}>} `stamped` is false when the mtime could not be set —
	 *   not an upload failure, the file is up there correctly either way.
	 */
	async put(rel, localRoot, { chmod = null, mtimeMs = null, replacing = true } = {}) {
		const source = path.join(localRoot, rel);
		const target = this.remotePath(rel);
		if (!this.config.atomicUpload) {
			await this.#call('fastPut', source, target);
			if (chmod !== null) await this.#call('chmod', target, chmod);
			return { stamped: await this.#stamp(target, mtimeMs) };
		}

		const temp = tempPath(target);
		try {
			await this.#call('fastPut', source, temp);
			if (chmod !== null) await this.#call('chmod', temp, chmod);
			const stamped = await this.#stamp(temp, mtimeMs);
			await this.#renameOver(temp, target, replacing);
			return { stamped };
		} catch (err) {
			// Leave nothing behind on the way out. A hard kill still can, which is what `prune` is for.
			await this.#call('unlink', temp).catch(() => {});
			throw err;
		}
	}

	async #stamp(abs, mtimeMs) {
		if (mtimeMs === null) return true;
		const t = Math.floor(mtimeMs / 1000);
		return this.#call('utimes', abs, t, t).then(
			() => true,
			() => false,
		);
	}

	/**
	 * Renames over an existing file.
	 *
	 * SFTP v3 `rename` fails when the target exists, so the portable route is unlink-then-rename —
	 * with a window where the file is missing entirely. OpenSSH's `posix-rename@openssh.com` does it
	 * in one atomic step and is used whenever the server advertises it.
	 *
	 * `replacing` says whether the target was there during the scan. When it was not — the common
	 * case for a first upload of a big tree — the unlink is skipped, saving a round trip per file;
	 * if the file turned up in the meantime the rename fails and the slow path runs after all.
	 */
	async #renameOver(from, to, replacing) {
		if (this.#hasPosixRename()) return this.#call('ext_openssh_rename', from, to);

		if (!replacing) {
			try {
				return await this.#call('rename', from, to);
			} catch {
				// It exists after all — fall through and replace it properly.
			}
		}
		await this.#call('unlink', to).catch(() => {});
		await this.#call('rename', from, to);
	}

	/** Asked once per session: the extension list arrives with the SFTP handshake. */
	#hasPosixRename() {
		if (this.posixRename === null) {
			this.posixRename = this.sftp?._extensions?.['posix-rename@openssh.com'] === '1';
			if (!this.posixRename) {
				this.logger.trace('server has no posix-rename extension — using unlink + rename');
			}
		}
		return this.posixRename;
	}

	mkdir(rel) {
		return this.#call('mkdir', this.remotePath(rel));
	}

	mkdirAbs(abs) {
		return this.#call('mkdir', abs);
	}

	/**
	 * Directory listing in the shape every session speaks: `{name, dir, link, size, mtime}` with the
	 * mtime in milliseconds. FTP listings carry none of ssh2's `longname`, so the translation happens
	 * here rather than in the engine.
	 */
	async readdirAbs(abs) {
		const list = await this.#call('readdir', abs);
		return list.map((item) => ({
			name: item.filename,
			dir: item.longname.startsWith('d'),
			link: item.longname.startsWith('l'),
			size: item.attrs.size,
			mtime: item.attrs.mtime * 1000,
		}));
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

	/** `{size, mtime}` with the mtime in milliseconds — ssh2 counts in seconds. */
	async stat(rel) {
		const stats = await this.#call('stat', this.remotePath(rel));
		return { size: stats.size, mtime: stats.mtime * 1000 };
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
