/**
 * A real, in-process SFTP server backed by a temporary directory.
 *
 * The tests need to exercise the actual ssh2 transport — connection, concurrency, readdir shapes,
 * utimes, error codes — without anyone owning a server. This is a full enough SFTP v3 subset for
 * that: the client under test cannot tell it apart from a remote host.
 */
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';

import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

let cachedHostKey = null;
const hostKey = () => {
	cachedHostKey ??= generateKeyPairSync('rsa', {
		modulusLength: 2048,
		privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
		publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
	}).privateKey;
	return cachedHostKey;
};

const modeString = (st) => {
	const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
	const bits = ['r', 'w', 'x'];
	let out = type;
	for (let i = 8; i >= 0; i--) out += st.mode & (1 << i) ? bits[(8 - i) % 3] : '-';
	return out;
};

const toAttrs = (st) => ({
	mode: st.mode,
	uid: st.uid,
	gid: st.gid,
	size: st.size,
	atime: Math.floor(st.atimeMs / 1000),
	mtime: Math.floor(st.mtimeMs / 1000),
});

const errorStatus = (err) => {
	if (err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
	if (err.code === 'EACCES' || err.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
	if (err.code === 'EEXIST') return STATUS_CODE.FAILURE;
	return STATUS_CODE.FAILURE;
};

/**
 * @param {{root: string, password?: string, noTimestampPaths?: string[]}} options
 * @returns {Promise<{port: number, close: () => Promise<void>, root: string}>}
 */
export function startSftpServer({ root, password = 'secret', noTimestampPaths = [] } = {}) {
	fs.mkdirSync(root, { recursive: true });

	const server = new Server({ hostKeys: [hostKey()] }, (client) => {
		client.on('authentication', (ctx) => {
			if (ctx.method === 'password' && ctx.password === password) ctx.accept();
			else if (ctx.method === 'none') ctx.reject(['password']);
			else ctx.reject();
		});

		client.on('ready', () => {
			client.on('session', (acceptSession) => {
				const session = acceptSession();
				session.on('sftp', (acceptSftp) => attach(acceptSftp(), root, noTimestampPaths));
			});
		});
		client.on('error', () => {});
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve({
				port: server.address().port,
				root,
				close: () =>
					new Promise((done) => {
						server.close(done);
					}),
			});
		});
	});
}

function attach(sftp, root, noTimestampPaths) {
	const handles = new Map();
	let nextHandle = 0;

	const resolve = (p) => {
		const clean = path.posix.normalize(String(p));
		const abs = path.join(root, clean.replace(/^\/+/, ''));
		if (!abs.startsWith(root)) throw Object.assign(new Error('escape'), { code: 'EACCES' });
		return abs;
	};
	// Files that are writable but whose timestamps cannot be changed — the "owned by another uid"
	// case the manifest fallback exists for.
	const noTimestamps = (p) => noTimestampPaths.some((r) => String(p).replace(/^\/+/, '').endsWith(r));

	const newHandle = (value) => {
		const id = nextHandle++;
		const buf = Buffer.alloc(4);
		buf.writeUInt32BE(id, 0);
		handles.set(id, value);
		return buf;
	};
	const getHandle = (buf) => handles.get(buf.readUInt32BE(0));

	const guard = (reqid, fn) => {
		try {
			fn();
		} catch (err) {
			sftp.status(reqid, errorStatus(err));
		}
	};

	sftp.on('REALPATH', (reqid, givenPath) =>
		guard(reqid, () => {
			const clean = path.posix.normalize(givenPath === '.' ? '/' : givenPath);
			sftp.name(reqid, [{ filename: clean, longname: clean, attrs: {} }]);
		}),
	);

	for (const op of ['STAT', 'LSTAT']) {
		sftp.on(op, (reqid, givenPath) =>
			guard(reqid, () => {
				const st = op === 'STAT' ? fs.statSync(resolve(givenPath)) : fs.lstatSync(resolve(givenPath));
				sftp.attrs(reqid, toAttrs(st));
			}),
		);
	}

	sftp.on('FSTAT', (reqid, handle) =>
		guard(reqid, () => {
			const entry = getHandle(handle);
			sftp.attrs(reqid, toAttrs(fs.fstatSync(entry.fd)));
		}),
	);

	sftp.on('OPENDIR', (reqid, givenPath) =>
		guard(reqid, () => {
			const abs = resolve(givenPath);
			if (!fs.statSync(abs).isDirectory()) throw Object.assign(new Error('not a dir'), { code: 'ENOTDIR' });
			sftp.handle(reqid, newHandle({ type: 'dir', abs, read: false }));
		}),
	);

	sftp.on('READDIR', (reqid, handle) =>
		guard(reqid, () => {
			const entry = getHandle(handle);
			if (!entry || entry.read) return sftp.status(reqid, STATUS_CODE.EOF);
			entry.read = true;
			const names = fs.readdirSync(entry.abs).map((name) => {
				const st = fs.lstatSync(path.join(entry.abs, name));
				return { filename: name, longname: `${modeString(st)} 1 u g ${st.size} Jan 1 00:00 ${name}`, attrs: toAttrs(st) };
			});
			sftp.name(reqid, names);
		}),
	);

	sftp.on('OPEN', (reqid, filename, flags) =>
		guard(reqid, () => {
			const abs = resolve(filename);
			let mode = 'r';
			if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.APPEND ? 'a' : 'w';
			if (flags & OPEN_MODE.READ && flags & OPEN_MODE.WRITE) mode = 'r+';
			const fd = fs.openSync(abs, mode);
			sftp.handle(reqid, newHandle({ type: 'file', fd, abs }));
		}),
	);

	sftp.on('WRITE', (reqid, handle, offset, data) =>
		guard(reqid, () => {
			const entry = getHandle(handle);
			fs.writeSync(entry.fd, data, 0, data.length, Number(offset));
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('READ', (reqid, handle, offset, length) =>
		guard(reqid, () => {
			const entry = getHandle(handle);
			const buf = Buffer.alloc(length);
			const read = fs.readSync(entry.fd, buf, 0, length, Number(offset));
			if (read === 0) sftp.status(reqid, STATUS_CODE.EOF);
			else sftp.data(reqid, buf.subarray(0, read));
		}),
	);

	sftp.on('CLOSE', (reqid, handle) =>
		guard(reqid, () => {
			const id = handle.readUInt32BE(0);
			const entry = handles.get(id);
			if (entry?.type === 'file') fs.closeSync(entry.fd);
			handles.delete(id);
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('MKDIR', (reqid, givenPath) =>
		guard(reqid, () => {
			fs.mkdirSync(resolve(givenPath));
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('RMDIR', (reqid, givenPath) =>
		guard(reqid, () => {
			fs.rmdirSync(resolve(givenPath));
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('REMOVE', (reqid, givenPath) =>
		guard(reqid, () => {
			fs.unlinkSync(resolve(givenPath));
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('RENAME', (reqid, from, to) =>
		guard(reqid, () => {
			fs.renameSync(resolve(from), resolve(to));
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('SETSTAT', (reqid, givenPath, attrs) =>
		guard(reqid, () => {
			const abs = resolve(givenPath);
			if (noTimestamps(givenPath) && attrs.atime !== undefined) {
				return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
			}
			if (attrs.mode !== undefined) fs.chmodSync(abs, attrs.mode);
			if (attrs.atime !== undefined && attrs.mtime !== undefined) fs.utimesSync(abs, attrs.atime, attrs.mtime);
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('FSETSTAT', (reqid, handle, attrs) =>
		guard(reqid, () => {
			const entry = getHandle(handle);
			if (attrs.mode !== undefined) fs.fchmodSync(entry.fd, attrs.mode);
			if (attrs.atime !== undefined && attrs.mtime !== undefined) fs.futimesSync(entry.fd, attrs.atime, attrs.mtime);
			sftp.status(reqid, STATUS_CODE.OK);
		}),
	);

	sftp.on('error', () => {});
}
