import { isIP } from 'node:net';
import path from 'node:path';

import { Client, FTPError } from 'basic-ftp';

import { NO_SUCH_FILE, tempPath } from './session.mjs';
import { UserError } from './util.mjs';

/** FTP reply codes that mean "that path is not there". */
const FTP_NOT_FOUND = new Set([550, 450]);

/**
 * The FTP/FTPS counterpart of `SftpSession`, exposing the same operations to the engine.
 *
 * Two facts about FTP shape everything here:
 *
 * 1. A control connection carries one command at a time. Scanning and uploading are heavily
 *    parallel, so the session holds a small pool of connections instead of a single one and every
 *    operation borrows one for its round trip. `connections` caps the pool — servers commonly limit
 *    how many sessions one account may open, and being cut off mid-sync is worse than being slow.
 *
 * 2. The protocol has no `utimes` and no `chmod`. Both exist only as optional extensions: `MFMT` for
 *    the modification time and `SITE CHMOD` for the mode. When the server has neither — or cannot
 *    report times back through `MLSD` — the sync falls back to comparing against the local manifest,
 *    which is the same path SFTP takes for files it may not stamp.
 */
export class FtpSession {
	constructor(config, logger) {
		this.config = config;
		this.logger = logger;
		this.protocol = config.protocol;
		this.remoteRoot = config.connection.remoteRoot;
		this.closing = false;
		// Filled in by the first connection, from the server's FEAT reply.
		this.features = null;
		this.canStamp = true;
		this.canChmod = true;
		this.secure = false;
		this.slots = [];
		this.waiting = [];
		this.size = Math.max(1, Number(config.connection.connections) || 1);
	}

	static async open(config, logger) {
		const session = new FtpSession(config, logger);
		// Connect once up front so a wrong password or a missing TLS layer is reported before any
		// scanning starts, exactly as the SFTP session does.
		session.release(await session.acquire());
		return session;
	}

	// ────────────────────────────────────────────────────────────────────────────
	// The connection pool
	// ────────────────────────────────────────────────────────────────────────────

	async acquire() {
		for (;;) {
			// After `end()` nothing may quietly open a new connection — an operation still in flight
			// would otherwise reconnect to a session the caller has already finished with.
			if (this.closing) throw new Error('the connection has been closed');
			const free = this.slots.find((slot) => !slot.busy && !slot.client.closed);
			if (free) {
				free.busy = true;
				return free;
			}
			// A client that died while idle is of no use to anyone.
			this.slots = this.slots.filter((slot) => slot.busy || !slot.client.closed);

			if (this.slots.length < this.size) {
				const slot = { client: new Client(this.config.connection.readyTimeout), busy: true };
				this.slots.push(slot);
				try {
					await this.#login(slot.client);
				} catch (err) {
					this.#drop(slot);
					throw err;
				}
				return slot;
			}
			await new Promise((resolve) => this.waiting.push(resolve));
		}
	}

	release(slot) {
		slot.busy = false;
		this.waiting.shift()?.();
	}

	#drop(slot) {
		slot.client.close();
		this.slots = this.slots.filter((other) => other !== slot);
		this.waiting.shift()?.();
	}

	/**
	 * Runs one operation on a borrowed connection.
	 *
	 * An `FTPError` is the server answering — "no such file", "permission denied" — and belongs to the
	 * caller, connection intact. Anything else means the transport went away (timeout, reset, a server
	 * that drops idle sessions), and basic-ftp has closed that client for good; it is thrown away and
	 * the operation runs once more on a fresh one. That is what keeps `watch` and `patrol` alive over
	 * hours.
	 */
	async #run(fn, attempt = 0) {
		const slot = await this.acquire();
		try {
			return await fn(slot.client);
		} catch (err) {
			if (err instanceof FTPError) throw asStatusError(err);
			this.#drop(slot);
			if (this.closing || attempt > 0) throw err;
			this.logger.trace(`reconnecting after: ${err.message}`);
			return this.#run(fn, attempt + 1);
		} finally {
			if (this.slots.includes(slot)) this.release(slot);
		}
	}

	// ────────────────────────────────────────────────────────────────────────────
	// Logging in
	// ────────────────────────────────────────────────────────────────────────────

	async #login(client) {
		const cfg = this.config.connection;
		const { protocol, target } = this.config;
		const tlsOptions = {
			host: cfg.host,
			// SNI is a hostname; passing an IP there is rejected outright by Node.
			...(isIpAddress(cfg.host) ? {} : { servername: cfg.host }),
			rejectUnauthorized: cfg.rejectUnauthorized !== false,
		};

		try {
			if (protocol === 'ftps-implicit') {
				await client.connectImplicitTLS(cfg.host, cfg.port, tlsOptions);
				this.secure = true;
			} else {
				await client.connect(cfg.host, cfg.port);
				// `ftps` demands TLS and fails without it; `ftp` takes it when the server offers it and
				// carries on in the clear when it does not. Either way the upgrade happens *before* the
				// password goes over the wire — an upgrade after login would protect nothing that matters.
				const offered = (await client.features()).has('AUTH');
				if (protocol === 'ftps' || offered) {
					await client.useTLS(tlsOptions);
					this.secure = true;
				}
			}

			await client.login(cfg.username, cfg.password ?? '');
			await client.useDefaultSettings();
		} catch (err) {
			client.close();
			throw new UserError(`cannot connect to ${target}: ${err.message}`, connectHint(err, this.config));
		}

		if (this.features === null) this.#describe(await client.features());
	}

	/**
	 * What this server can do, asked once and applied to every connection after it.
	 *
	 * Timestamps are only kept when the server can both set one (`MFMT`) and report it back with
	 * second precision (`MLSD`, advertised as `MLST`). Half of that is worse than none: stamping files
	 * whose times cannot be read back would make every run look like everything had changed.
	 */
	#describe(features) {
		if (this.features) return;
		this.features = features;
		// `SITE CHMOD` is not advertised by anyone, so `canChmod` stays true until a server says no.
		const canSet = features.has('MFMT');
		const canRead = features.has('MLST');
		this.canStamp = canSet && canRead;

		if (this.config.protocol === 'ftp') {
			this.logger[this.secure ? 'trace' : 'warn'](
				this.secure
					? 'server offered TLS — the connection is encrypted'
					: 'server does not offer TLS — this connection is unencrypted. Use "protocol": "ftps" to require it.',
			);
		}
		if (!this.canStamp) {
			this.logger.trace(
				`server cannot ${canSet ? 'report' : 'set'} modification times — comparing against the local manifest instead`,
			);
		}
	}

	// ────────────────────────────────────────────────────────────────────────────
	// Operations
	// ────────────────────────────────────────────────────────────────────────────

	remotePath(rel) {
		if (!rel) return this.remoteRoot;
		return this.remoteRoot === '/' ? `/${rel}` : `${this.remoteRoot}/${rel}`;
	}

	readdir(rel) {
		return this.readdirAbs(this.remotePath(rel));
	}

	async readdirAbs(abs) {
		const list = await this.#run((client) => client.list(abs));
		return list
			.filter((item) => item.name !== '.' && item.name !== '..')
			.map((item) => ({
				name: item.name,
				dir: item.isDirectory,
				link: item.isSymbolicLink,
				size: item.size,
				// Only MLSD gives a date that can be trusted; a LIST listing is left at 0 and the
				// comparison falls back to the manifest, which is why `canStamp` requires MLSD too.
				mtime: item.modifiedAt ? item.modifiedAt.getTime() : 0,
			}));
	}

	/** Same contract as the SFTP session: see the comment on `SftpSession#put`. */
	async put(rel, localRoot, { chmod = null, mtimeMs = null, replacing = true } = {}) {
		const source = path.join(localRoot, rel);
		const target = this.remotePath(rel);

		if (!this.config.atomicUpload) {
			await this.#run((client) => client.uploadFrom(source, target));
			if (chmod !== null) await this.#chmodAbs(target, chmod);
			return { stamped: await this.#stamp(target, mtimeMs) };
		}

		const temp = tempPath(target);
		try {
			await this.#run((client) => client.uploadFrom(source, temp));
			if (chmod !== null) await this.#chmodAbs(temp, chmod);
			const stamped = await this.#stamp(temp, mtimeMs);
			await this.#renameOver(temp, target, replacing);
			return { stamped };
		} catch (err) {
			await this.#run((client) => client.remove(temp, true)).catch(() => {});
			throw err;
		}
	}

	/**
	 * FTP's `RNTO` is not defined to replace an existing file and most servers refuse it, so the
	 * target is deleted first — the same unavoidable window the SFTP session has on servers without
	 * `posix-rename`. When the scan did not see the file there, the delete is skipped and only
	 * retried if the rename turns out to disagree.
	 */
	async #renameOver(from, to, replacing) {
		if (!replacing) {
			try {
				return await this.#run((client) => client.rename(from, to));
			} catch {
				// It exists after all — fall through and replace it properly.
			}
		}
		await this.#run((client) => client.remove(to, true)).catch(() => {});
		await this.#run((client) => client.rename(from, to));
	}

	/** @returns {Promise<boolean>} whether the modification time made it onto the server. */
	async #stamp(abs, mtimeMs) {
		if (mtimeMs === null) return true;
		if (!this.canStamp) return false;
		return this.#run((client) => client.send(`MFMT ${mfmtTime(mtimeMs)} ${abs}`)).then(
			() => true,
			() => false,
		);
	}

	async #chmodAbs(abs, mode) {
		if (!this.canChmod) return;
		try {
			await this.#run((client) => client.send(`SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${abs}`));
		} catch (err) {
			// Plenty of servers have no SITE CHMOD at all. Say so once, then stop asking.
			this.canChmod = false;
			this.logger.warn(`server rejected SITE CHMOD (${err.message}) — "chmod" is ignored from here on`);
		}
	}

	mkdir(rel) {
		return this.mkdirAbs(this.remotePath(rel));
	}

	mkdirAbs(abs) {
		return this.#run((client) => client.send(`MKD ${abs}`));
	}

	rmdir(rel) {
		return this.rmdirAbs(this.remotePath(rel));
	}

	rmdirAbs(abs) {
		return this.#run((client) => client.removeEmptyDir(abs));
	}

	unlink(rel) {
		return this.#run((client) => client.remove(this.remotePath(rel)));
	}

	/** `{size, mtime}` with the mtime in milliseconds, matching the SFTP session. */
	async stat(rel) {
		const abs = this.remotePath(rel);
		const size = await this.#run((client) => client.size(abs));
		const mtime = await this.#run((client) => client.lastMod(abs)).catch(() => null);
		return { size, mtime: mtime ? mtime.getTime() : 0 };
	}

	chmod(rel, mode) {
		return this.#chmodAbs(this.remotePath(rel), mode);
	}

	async utimes(rel, mtimeMs) {
		if (!(await this.#stamp(this.remotePath(rel), mtimeMs))) {
			throw new Error('the server does not support setting modification times');
		}
	}

	end() {
		this.closing = true;
		for (const slot of this.slots) slot.client.close();
		this.slots = [];
		for (const resolve of this.waiting.splice(0)) resolve();
	}
}

const isIpAddress = (host) => isIP(String(host)) !== 0;

/** `MFMT` wants UTC as YYYYMMDDHHMMSS. */
function mfmtTime(mtimeMs) {
	return new Date(Math.floor(mtimeMs / 1000) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Gives a server refusal the same `code` the engine already understands from SFTP, so "the directory
 * is not there yet" reads identically whichever protocol reported it.
 */
function asStatusError(err) {
	if (FTP_NOT_FOUND.has(err.code)) err.code = NO_SUCH_FILE;
	return err;
}

function connectHint(err, config) {
	const message = err?.message ?? '';
	const cfg = config.connection;
	if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'The hostname could not be resolved.';
	if (/ECONNREFUSED/i.test(message)) return `Nothing is listening on port ${cfg.port}.`;
	if (/^530|Login|password/i.test(message)) return 'Check the username and password.';
	if (/AUTH|TLS not|not (understood|supported|implemented)/i.test(message) && config.protocol === 'ftps') {
		return 'The server did not accept AUTH TLS. Use "protocol": "ftp" to allow an unencrypted session, or "ftps-implicit" for a legacy TLS-only server (port 990).';
	}
	if (/certificate|self.signed|ssl|tls/i.test(message)) {
		return 'The TLS certificate was rejected. If the server uses a self-signed certificate, set "rejectUnauthorized": false.';
	}
	if (/timeout|timed out/i.test(message) && config.protocol === 'ftps-implicit') {
		return `Implicit FTPS usually listens on port 990, not ${cfg.port}.`;
	}
	return undefined;
}
