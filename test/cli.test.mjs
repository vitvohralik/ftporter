import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

import { makeFixture } from './helpers.mjs';

const exec = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/ftporter.mjs');

/** Runs the real binary and reports the outcome instead of throwing on a non-zero exit. */
async function cli(args, options = {}) {
	try {
		const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
			...options,
			env: { ...process.env, NO_COLOR: '1', ...options.env },
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

describe('cli', () => {
	it('prints help and version without a config', async () => {
		const help = await cli(['--help']);
		assert.equal(help.code, 0);
		assert.match(help.stdout, /Commands/);
		assert.match(help.stdout, /patrol/);

		const version = await cli(['--version']);
		assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
	});

	it('explains itself when no config can be found', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'ftporter-empty-'));
		after(() => rm(dir, { recursive: true, force: true }));

		const result = await cli([], { cwd: dir });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /no config file found/);
		assert.match(result.stderr, /ftporter init/);
	});

	it('writes a config with init and refuses to clobber it', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'ftporter-init-'));
		after(() => rm(dir, { recursive: true, force: true }));

		const first = await cli(['init'], { cwd: dir });
		assert.equal(first.code, 0);
		const file = path.join(dir, 'ftporter.config.jsonc');
		assert.ok(fs.existsSync(file));
		assert.match(fs.readFileSync(file, 'utf8'), /"remoteRoot"/);

		const second = await cli(['init'], { cwd: dir });
		assert.equal(second.code, 1);
		assert.match(second.stderr, /already exists/);
		assert.equal((await cli(['init', '--force'], { cwd: dir })).code, 0);
	});

	it('syncs from the working directory and reports JSON', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a', 'b.txt': 'b' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		fx.session.end();

		const result = await cli(['--json'], { cwd: fx.local });
		assert.equal(result.code, 0);
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.ok, true);
		assert.equal(summary.uploaded, 2);
		assert.deepEqual(fx.remoteList().sort(), ['a.txt', 'b.txt']);

		// A second run from a subdirectory must find the same config by walking up.
		fs.mkdirSync(path.join(fx.local, 'sub'), { recursive: true });
		const again = await cli(['status'], { cwd: path.join(fx.local, 'sub') });
		assert.equal(again.code, 0);
		assert.match(again.stdout, /up to date/);
	});

	it('syncs over FTPS end to end, from the binary', async () => {
		const fx = await makeFixture({
			protocol: 'ftps',
			files: { 'a.txt': 'a', 'sub/b.txt': 'b' },
			config: { strategy: 'blacklist' },
		});
		after(() => fx.cleanup());
		fx.session.end();

		const test = await cli(['test'], { cwd: fx.local });
		assert.equal(test.code, 0, test.stderr);
		assert.match(test.stdout, /connected to ftps:\/\//);

		const result = await cli(['--json'], { cwd: fx.local });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).uploaded, 2);
		assert.deepEqual(fx.remoteList(), ['a.txt', 'sub/b.txt']);
	});

	it('falls back to a single pass where there is no terminal, and says so under ui', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		fx.session.end();

		// execFile gives the child no TTY, which is exactly the cron and CI case.
		const bare = await cli([], { cwd: fx.local });
		assert.equal(bare.code, 0, bare.stderr);
		assert.deepEqual(fx.remoteList(), ['a.txt'], 'a bare run still syncs where it cannot open a session');

		const ui = await cli(['ui'], { cwd: fx.local });
		assert.equal(ui.code, 1);
		assert.match(ui.stderr, /interactive mode needs a terminal/);
		assert.match(ui.stderr, /ftporter sync/);
	});

	it('lists a directory on the server, and takes a path', async () => {
		const fx = await makeFixture({
			files: { 'a.txt': 'a', 'public/b.txt': 'bb' },
			config: { strategy: 'blacklist' },
		});
		after(() => fx.cleanup());
		fx.session.end();
		await cli(['sync'], { cwd: fx.local });

		const root = await cli(['list'], { cwd: fx.local });
		assert.equal(root.code, 0, root.stderr);
		assert.match(root.stdout, /public\//, 'directories are marked');
		assert.match(root.stdout, /a\.txt/);
		assert.match(root.stdout, /1 directory · 1 file/);

		const sub = await cli(['list', 'public'], { cwd: fx.local });
		assert.equal(sub.code, 0, sub.stderr);
		assert.match(sub.stdout, /b\.txt/);
		assert.doesNotMatch(sub.stdout, /a\.txt/, 'and only that directory');

		const missing = await cli(['list', 'nope'], { cwd: fx.local });
		assert.equal(missing.code, 1);
		assert.match(missing.stderr, /no such directory on the server/);

		const json = await cli(['list', '--json'], { cwd: fx.local });
		const parsed = JSON.parse(json.stdout);
		assert.equal(parsed.path, '/site');
		assert.deepEqual(parsed.entries.map((entry) => entry.name).sort(), ['a.txt', 'public']);
	});

	it('checks a connection with the test command', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		fx.session.end();

		const result = await cli(['test'], { cwd: fx.local });
		assert.equal(result.code, 0);
		assert.match(result.stdout, /connected to/);
		assert.match(result.stdout, /write access to .+ confirmed/);
	});

	it('prints the resolved config with secrets redacted', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		fx.session.end();

		const result = await cli(['config'], { cwd: fx.local });
		const printed = JSON.parse(result.stdout);
		assert.equal(printed.connection.password, '***');
		assert.equal(printed.protocol, 'sftp');
		assert.equal(printed.strategy, 'blacklist');
	});

	it('refuses patrol without an interval', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());
		fx.session.end();

		const result = await cli(['patrol'], { cwd: fx.local });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /patrol needs an interval/);
	});
});
