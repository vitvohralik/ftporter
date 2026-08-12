import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

/**
 * A small FTP server backed by a real directory, the counterpart of `sftp-server.mjs`.
 *
 * It speaks only what ftporter uses, but it speaks it the way real servers do — including the parts
 * that make FTP awkward: one command at a time per connection, a fresh data connection per
 * transfer, and `RNTO` refusing to overwrite. What each server *can* do is configurable, because
 * the interesting cases are the servers that cannot do everything: no `MLSD`, no `MFMT`, no
 * `SITE CHMOD`, no TLS.
 */
export async function startFtpServer({
	root,
	user = 'tester',
	password = 'secret',
	mlsd = true,
	mfmt = true,
	chmod = true,
	tls: useTls = false,
	implicit = false,
} = {}) {
	fs.mkdirSync(root, { recursive: true });

	const credentials = { user, password };
	const abilities = { mlsd, mfmt, chmod, tls: useTls && !implicit };
	const tlsOptions = useTls || implicit
		? {
				key: fs.readFileSync(new URL('./localhost-key.pem', import.meta.url)),
				cert: fs.readFileSync(new URL('./localhost-cert.pem', import.meta.url)),
			}
		: null;

	const sockets = new Set();
	const onConnection = (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		handleConnection(socket, { root, credentials, abilities, tlsOptions, sockets }, implicit);
	};
	// Implicit FTPS is TLS from the first byte, before any command is exchanged.
	const server = implicit ? tls.createServer(tlsOptions, onConnection) : net.createServer(onConnection);

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

	return {
		port: server.address().port,
		/** Pulls every open connection out from under the client, as an idle timeout would. */
		dropConnections() {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
		},
		close: () =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(resolve);
			}),
	};
}

function handleConnection(control, ctx, secure = false) {
	const state = {
		control,
		cwd: '/',
		authenticated: false,
		secure,
		data: null, // { server, connection: Promise<socket> }
		renameFrom: null,
	};

	const send = (line) => state.control.write(`${line}\r\n`);

	// One command at a time, in order: a reply may be written only after the previous command is
	// fully handled, or a transfer's 150/226 pair can interleave with the next command's reply.
	let queue = Promise.resolve();
	let buffer = '';
	const onData = (chunk) => {
		buffer += chunk.toString('latin1');
		let at;
		while ((at = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, at).replace(/\r$/, '');
			buffer = buffer.slice(at + 1);
			queue = queue.then(() => handleCommand(line, state, ctx, send)).catch(() => send('451 internal error'));
		}
	};

	control.on('data', onData);
	control.on('error', () => {});
	send('220 ftporter test server');

	// Swapping in the TLS socket has to keep the same line reader, otherwise everything sent right
	// after the handshake is lost.
	state.upgrade = () => {
		const plain = state.control;
		plain.off('data', onData);
		const secure = new tls.TLSSocket(plain, { isServer: true, ...ctx.tlsOptions });
		secure.on('data', onData);
		secure.on('error', () => {});
		ctx.sockets.add(secure);
		state.control = secure;
		state.secure = true;
	};
}

async function handleCommand(line, state, ctx, send) {
	const at = line.indexOf(' ');
	const command = (at === -1 ? line : line.slice(0, at)).toUpperCase();
	const arg = at === -1 ? '' : line.slice(at + 1);

	if (command === 'USER') {
		state.user = arg;
		return send('331 password required');
	}
	if (command === 'PASS') {
		state.authenticated = state.user === ctx.credentials.user && arg === ctx.credentials.password;
		return send(state.authenticated ? '230 logged in' : '530 Login incorrect');
	}
	if (command === 'AUTH') {
		if (!ctx.abilities.tls) return send('500 AUTH not understood');
		send('234 proceed with TLS');
		return state.upgrade();
	}
	if (command === 'FEAT') {
		const features = [];
		if (ctx.abilities.mlsd) features.push('MLST type*;size*;modify*;', 'MLSD');
		if (ctx.abilities.mfmt) features.push('MFMT');
		if (ctx.abilities.tls && !state.secure) features.push('AUTH TLS', 'PBSZ', 'PROT');
		features.push('SIZE', 'UTF8');
		return send(`211-Features:\r\n ${features.join('\r\n ')}\r\n211 End`);
	}
	if (['OPTS', 'TYPE', 'STRU', 'NOOP', 'PBSZ', 'PROT', 'MODE'].includes(command)) {
		return send('200 ok');
	}
	if (command === 'QUIT') {
		send('221 bye');
		return state.control.end();
	}
	if (!state.authenticated) return send('530 not logged in');

	const absolute = (value) => (value.startsWith('/') ? value : path.posix.join(state.cwd, value));
	const local = (value) => {
		const rel = path.posix.normalize(absolute(value));
		if (rel.split('/').includes('..')) return null;
		return path.join(ctx.root, rel);
	};

	switch (command) {
		case 'PWD':
			return send(`257 "${state.cwd}"`);
		case 'CWD': {
			const target = local(arg);
			if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) return send('550 no such directory');
			state.cwd = path.posix.normalize(absolute(arg));
			return send('250 ok');
		}
		case 'PASV': {
			const port = await openDataPort(state, ctx);
			return send(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
		}
		case 'EPSV': {
			const port = await openDataPort(state, ctx);
			return send(`229 Entering Extended Passive Mode (|||${port}|)`);
		}
		case 'MLSD':
		case 'LIST':
		case 'NLST': {
			if (command === 'MLSD' && !ctx.abilities.mlsd) return send('500 MLSD not understood');
			const target = local(stripListFlags(arg));
			if (!target || !fs.existsSync(target)) return send('550 no such directory');
			const listing = fs.readdirSync(target, { withFileTypes: true }).map((entry) => {
				const stat = fs.lstatSync(path.join(target, entry.name));
				return command === 'MLSD'
					? `type=${describeType(entry)};size=${stat.size};modify=${stamp(stat.mtimeMs)};unix.mode=0${(stat.mode & 0o777).toString(8)}; ${entry.name}`
					: `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : '-'}rw-r--r-- 1 u g ${stat.size} Jan 01 00:00 ${entry.name}`;
			});
			return transfer(state, send, `${listing.join('\r\n')}${listing.length ? '\r\n' : ''}`);
		}
		case 'RETR': {
			const target = local(arg);
			if (!target || !fs.existsSync(target)) return send('550 no such file');
			return transfer(state, send, fs.readFileSync(target));
		}
		case 'STOR': {
			const target = local(arg);
			if (!target || !fs.existsSync(path.dirname(target))) return send('550 no such directory');
			return receive(state, send, target);
		}
		case 'SIZE': {
			const target = local(arg);
			if (!target || !fs.existsSync(target)) return send('550 no such file');
			return send(`213 ${fs.statSync(target).size}`);
		}
		case 'MDTM': {
			const target = local(arg);
			if (!target || !fs.existsSync(target)) return send('550 no such file');
			return send(`213 ${stamp(fs.statSync(target).mtimeMs)}`);
		}
		case 'MFMT': {
			if (!ctx.abilities.mfmt) return send('500 MFMT not understood');
			const space = arg.indexOf(' ');
			const target = local(arg.slice(space + 1));
			if (!target || !fs.existsSync(target)) return send('550 no such file');
			const when = parseStamp(arg.slice(0, space));
			if (!when) return send('501 bad time');
			fs.utimesSync(target, when, when);
			return send(`213 Modify=${arg.slice(0, space)}; ${arg.slice(space + 1)}`);
		}
		case 'DELE': {
			const target = local(arg);
			if (!target || !fs.existsSync(target)) return send('550 no such file');
			fs.rmSync(target);
			return send('250 deleted');
		}
		case 'MKD': {
			const target = local(arg);
			if (!target || fs.existsSync(target)) return send('550 cannot create directory');
			if (!fs.existsSync(path.dirname(target))) return send('550 no such parent');
			fs.mkdirSync(target);
			return send(`257 "${absolute(arg)}" created`);
		}
		case 'RMD': {
			const target = local(arg);
			if (!target || !fs.existsSync(target)) return send('550 no such directory');
			if (fs.readdirSync(target).length) return send('550 directory not empty');
			fs.rmdirSync(target);
			return send('250 removed');
		}
		case 'RNFR': {
			const target = local(arg);
			if (!target || !fs.existsSync(target)) return send('550 no such file');
			state.renameFrom = target;
			return send('350 waiting for RNTO');
		}
		case 'RNTO': {
			const target = local(arg);
			if (!state.renameFrom || !target) return send('503 RNFR first');
			// Strict, like most servers: an existing target has to be removed first.
			if (fs.existsSync(target)) return send('550 target exists');
			fs.renameSync(state.renameFrom, target);
			state.renameFrom = null;
			return send('250 renamed');
		}
		case 'SITE': {
			const [action, mode, ...rest] = arg.split(' ');
			if (action.toUpperCase() !== 'CHMOD' || !ctx.abilities.chmod) return send('500 SITE not understood');
			const target = local(rest.join(' '));
			if (!target || !fs.existsSync(target)) return send('550 no such file');
			fs.chmodSync(target, Number.parseInt(mode, 8));
			return send('200 mode changed');
		}
		default:
			return send('500 not understood');
	}
}

/** Opens a one-shot passive port and keeps the connection it receives. */
async function openDataPort(state, ctx) {
	state.data?.server.close();

	const secure = state.secure && ctx.tlsOptions;
	const server = secure ? tls.createServer(ctx.tlsOptions) : net.createServer();
	const connection = new Promise((resolve) => {
		server.once(secure ? 'secureConnection' : 'connection', (socket) => {
			socket.on('error', () => {});
			resolve(socket);
		});
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	state.data = { server, connection };
	return server.address().port;
}

async function transfer(state, send, payload) {
	if (!state.data) return send('425 use PASV first');
	const { server, connection } = state.data;
	state.data = null;
	send('150 opening data connection');
	const socket = await connection;
	await new Promise((resolve) => socket.end(payload, resolve));
	server.close();
	send('226 transfer complete');
}

async function receive(state, send, target) {
	if (!state.data) return send('425 use PASV first');
	const { server, connection } = state.data;
	state.data = null;
	send('150 opening data connection');
	const socket = await connection;
	const chunks = [];
	await new Promise((resolve, reject) => {
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('end', resolve);
		socket.on('error', reject);
	});
	fs.writeFileSync(target, Buffer.concat(chunks));
	server.close();
	send('226 transfer complete');
}

const describeType = (entry) => (entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'OS.unix=symlink' : 'file');

const stripListFlags = (arg) =>
	arg
		.split(' ')
		.filter((part) => part && !part.startsWith('-'))
		.join(' ');

/** RFC 3659 time: YYYYMMDDHHMMSS in UTC. */
const stamp = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);

function parseStamp(value) {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const [, y, mo, d, h, mi, s] = m.map(Number);
	return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}
