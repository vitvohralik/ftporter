import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { silentLogger } from '../src/logger.mjs';
import { openSession } from '../src/session.mjs';
import { startFtpServer } from './ftp-server.mjs';
import { startSftpServer } from './sftp-server.mjs';

export const logger = silentLogger();

/**
 * A temporary project, a temporary "server" and a config wired between the two.
 *
 * `protocol` picks which server gets started and which block the config uses, so the same test can
 * be run over SFTP and over FTP; `server` is passed on to it (which features it supports).
 */
export async function makeFixture({ files = {}, config = {}, noTimestampPaths = [], protocol = 'sftp', server: serverOptions = {} } = {}) {
	const base = await mkdtemp(path.join(tmpdir(), 'ftporter-test-'));
	const local = path.join(base, 'project');
	const remote = path.join(base, 'server');
	fs.mkdirSync(local, { recursive: true });

	for (const [rel, content] of Object.entries(files)) writeFile(local, rel, content);

	const server =
		protocol === 'sftp'
			? await startSftpServer({ root: remote, noTimestampPaths })
			: await startFtpServer({
					root: remote,
					tls: protocol === 'ftps',
					implicit: protocol === 'ftps-implicit',
					...serverOptions,
				});

	const configFile = path.join(local, 'ftporter.config.json');
	fs.writeFileSync(
		configFile,
		JSON.stringify({
			root: '.',
			stateFile: path.join(base, 'state.json'),
			exclude: ['ftporter.config.json'],
			// One block at every level, with the protocol inside it.
			server: {
				protocol,
				host: '127.0.0.1',
				port: server.port,
				username: 'tester',
				password: 'secret',
				remoteRoot: '/site',
				...(protocol === 'sftp' ? {} : { rejectUnauthorized: false }),
			},
			...config,
		}),
	);

	// A config that fails validation must still tear the server down, or `node --test` hangs on the
	// open handle instead of reporting the failure.
	let resolved;
	let session;
	try {
		resolved = await loadConfig({ config: configFile }, { cwd: local, env: {} });
		session = await openSession(resolved, logger);
	} catch (err) {
		await server.close();
		await rm(base, { recursive: true, force: true });
		throw err;
	}

	return {
		base,
		server,
		local,
		remote: path.join(remote, 'site'),
		config: resolved,
		session,
		configFile,
		reload: (cli = {}) => loadConfig({ config: configFile, ...cli }, { cwd: local, env: {} }),
		write: (rel, content) => writeFile(local, rel, content),
		remove: (rel) => fs.rmSync(path.join(local, rel), { recursive: true, force: true }),
		remoteList: () => listTree(path.join(remote, 'site')),
		remoteRead: (rel) => fs.readFileSync(path.join(remote, 'site', rel), 'utf8'),
		remoteWrite: (rel, content) => writeFile(path.join(remote, 'site'), rel, content),
		remoteExists: (rel) => fs.existsSync(path.join(remote, 'site', rel)),
		git: (...args) => execFileSync('git', args, { cwd: local, stdio: 'ignore' }),
		async cleanup() {
			session.end();
			await server.close();
			await rm(base, { recursive: true, force: true });
		},
	};
}

function writeFile(root, rel, content) {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	return abs;
}

/** Every regular file under `dir`, as sorted relative POSIX paths. */
export function listTree(dir) {
	const out = [];
	const walk = (rel) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(child);
			else out.push(child);
		}
	};
	walk('');
	return out.sort();
}
