import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parseArgs } from '../src/cli.mjs';
import { interpolate, loadConfig, parseJsonc } from '../src/config.mjs';
import { matcher } from '../src/match.mjs';
import { formatDuration, merge, parseDuration } from '../src/util.mjs';

async function withConfig(contents, cli = {}, env = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), 'ftporter-cfg-'));
	const file = path.join(dir, 'ftporter.config.jsonc');
	fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
	const config = await loadConfig({ config: file, ...cli }, { cwd: dir, env });
	return { config, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const minimal = {
	server: { protocol: 'sftp', host: 'h', username: 'u', remoteRoot: '/srv/app', password: 'p' },
};

describe('config', () => {
	it('resolves defaults and derives the target label', async () => {
		const { config, cleanup } = await withConfig(minimal);
		after(cleanup);

		assert.equal(config.strategy, 'git');
		assert.equal(config.delete, true);
		assert.equal(config.deleteCap, 50);
		assert.equal(config.target, 'u@h:/srv/app');
		assert.equal(config.connection.port, 22);
	});

	it('applies targets and profiles over the base, CLI over both', async () => {
		const { config, cleanup } = await withConfig(
			{
				...minimal,
				deleteCap: 10,
				targets: { prod: { server: { host: 'prod.example', remoteRoot: '/var/www' }, delete: false } },
				profiles: { assets: { strategy: 'whitelist', include: ['public/build'], deleteCap: 500 } },
			},
			{ target: 'prod', profile: 'assets', strategy: 'blacklist' },
		);
		after(cleanup);

		assert.equal(config.connection.host, 'prod.example', 'target wins over the base');
		assert.equal(config.delete, false);
		assert.equal(config.deleteCap, 500, 'profile wins over the target');
		assert.equal(config.strategy, 'blacklist', 'CLI wins over everything');
		assert.deepEqual(config.include, ['public/build']);
		assert.equal(config.profileName, 'assets');
	});

	it('adds CLI include/exclude to the config instead of replacing it', async () => {
		const { config, cleanup } = await withConfig(
			{ ...minimal, exclude: ['*.log'] },
			{ exclude: ['tmp'], include: ['extra'] },
		);
		after(cleanup);

		assert.deepEqual(config.exclude, ['*.log', 'tmp']);
		assert.deepEqual(config.include, ['extra']);
	});

	it('names the known targets when an unknown one is asked for', async () => {
		await assert.rejects(
			withConfig({ ...minimal, targets: { prod: {}, stage: {} } }, { target: 'nope' }),
			/unknown target 'nope' \(known targets: prod, stage\)/,
		);
	});

	it('reads secrets from the environment', async () => {
		const { config, cleanup } = await withConfig(
			{ server: { protocol: 'sftp', host: 'h', username: 'u', remoteRoot: '/x', password: '${DEPLOY_PW}' } },
			{},
			{ DEPLOY_PW: 'hunter2' },
		);
		after(cleanup);

		assert.equal(config.connection.password, 'hunter2');
	});

	it('rejects a config with no way to authenticate', async () => {
		await assert.rejects(
			withConfig({ server: { protocol: 'sftp', host: 'h', username: 'u', remoteRoot: '/x' } }),
			/no authentication configured/,
		);
	});

	it('rejects an unknown strategy and a sub-second interval', async () => {
		await assert.rejects(withConfig({ ...minimal, strategy: 'magic' }), /unknown strategy/);
		await assert.rejects(withConfig({ ...minimal, watch: { interval: '10ms' } }), /at least 1s/);
	});

	it('accepts comments and trailing commas', () => {
		const parsed = parseJsonc('{ /* a */ "a": 1, // b\n "b": [1,2,], }', 'x.jsonc');
		assert.deepEqual(parsed, { a: 1, b: [1, 2] });
	});

	it('leaves // inside strings alone', () => {
		assert.deepEqual(parseJsonc('{"url": "https://example.com"}', 'x'), { url: 'https://example.com' });
	});

	it('interpolates with fallbacks and escapes', () => {
		assert.equal(interpolate('${A}/${B:-default}', { A: 'x' }), 'x/default');
		assert.equal(interpolate('$${LITERAL}', {}), '${LITERAL}');
		assert.deepEqual(interpolate({ a: ['${A}'] }, { A: '1' }), { a: ['1'] });
	});

	it('parses the config file it is pointed at, wherever it lives', async () => {
		const { config, cleanup } = await withConfig({ ...minimal, root: '.' });
		after(cleanup);
		assert.equal(config.root, path.dirname(config.configFile));
	});
});

describe('protocol', () => {
	const credentials = { host: 'h', username: 'u', remoteRoot: '/srv/app', password: 'p' };

	it('defaults to sftp, as every config written before this did', async () => {
		const { config, cleanup } = await withConfig(minimal);
		after(cleanup);

		assert.equal(config.protocol, 'sftp');
		assert.equal(config.connection.port, 22);
		assert.equal(config.sftp, undefined, 'and the 1.x alias is gone with the 1.x block');
	});

	it('takes the protocol from inside the server block, port and all', async () => {
		for (const [protocol, port] of [
			['ftp', 21],
			['ftps', 21],
			['ftps-implicit', 990],
		]) {
			const { config, cleanup } = await withConfig({ server: { protocol, ...credentials } });
			after(cleanup);

			assert.equal(config.protocol, protocol);
			assert.equal(config.connection.port, port, 'and the port that goes with it');
			assert.equal(config.connection.host, 'h');
		}
	});

	it('accepts the protocol spelled the other common ways', async () => {
		for (const spelling of ['FTPS', 'ftpes', 'ftp-tls', 'ftps-explicit']) {
			const { config, cleanup } = await withConfig({ server: { protocol: spelling, ...credentials } });
			after(cleanup);
			assert.equal(config.protocol, 'ftps', `${spelling} is FTPS`);
		}
	});

	it('keeps an explicit port and an explicit protocol', async () => {
		const { config, cleanup } = await withConfig({
			server: { protocol: 'ftps-implicit', ...credentials, port: 9990 },
		});
		after(cleanup);

		assert.equal(config.protocol, 'ftps-implicit');
		assert.equal(config.connection.port, 9990);
	});

	it('lets a target switch protocol without touching the base', async () => {
		const file = {
			server: { protocol: 'sftp', ...credentials, privateKey: null },
			targets: { shared: { server: { protocol: 'ftps', host: 'ftp.example', username: 'web', password: 'p', remoteRoot: '/www' } } },
		};

		const base = await withConfig(file);
		after(base.cleanup);
		assert.equal(base.config.protocol, 'sftp');

		const shared = await withConfig(file, { target: 'shared' });
		after(shared.cleanup);
		assert.equal(shared.config.protocol, 'ftps');
		assert.equal(shared.config.connection.host, 'ftp.example');
		assert.equal(shared.config.target, 'ftps://web@ftp.example:/www');
	});

	it('takes --protocol and FTPORTER_PROTOCOL over what the file says', async () => {
		const cli = await withConfig({ server: { protocol: 'ftp', ...credentials } }, { protocol: 'ftps' });
		after(cli.cleanup);
		assert.equal(cli.config.protocol, 'ftps');

		const env = await withConfig({ server: { protocol: 'ftp', ...credentials } }, {}, { FTPORTER_PROTOCOL: 'ftps' });
		after(env.cleanup);
		assert.equal(env.config.protocol, 'ftps');
	});

	it('refuses a 1.x connection block, and says which level it sits on', async () => {
		await assert.rejects(
			withConfig({ sftp: credentials }),
			/the configuration uses the 1.x connection block "sftp"/,
			'ignoring it would drop the host and the credentials and blame a missing server.host',
		);
		await assert.rejects(
			withConfig({ server: { protocol: 'sftp', ...credentials }, targets: { prod: { ftps: credentials } } }),
			/target "prod" uses the 1.x connection block "ftps"/,
		);
		await assert.rejects(
			withConfig({ server: { protocol: 'sftp', ...credentials }, profiles: { assets: { ftp: credentials } } }),
			/profile "assets" uses the 1.x connection block "ftp"/,
		);
		await assert.rejects(
			withConfig({ server: { protocol: 'sftp', ...credentials }, targets: { prod: { profiles: { a: { connection: credentials } } } } }),
			/profile "a" of target "prod" uses the 1.x connection block "connection"/,
		);
	});

	it('names the protocol to move to in the hint', async () => {
		await assert.rejects(withConfig({ ftps: credentials }), (err) => {
			assert.match(err.hint, /"server": \{ "protocol": "ftps", … \}/);
			return true;
		});
	});

	it('reports a 1.x block in a target nobody selected on this run', async () => {
		await assert.rejects(
			withConfig({ server: { protocol: 'sftp', ...credentials }, targets: { broken: { sftp: credentials } } }),
			/target "broken" uses the 1.x connection block/,
			"a config is broken whether or not today's run happens to reach that target",
		);
	});

	it('rejects an unknown protocol', async () => {
		await assert.rejects(withConfig({ server: { protocol: 'scp', ...credentials } }), /unknown protocol 'scp'/);
	});

	it('retires the port and the SSH keys a target left behind when it changed protocol', async () => {
		// The everyday shape: a keyed SFTP base on port 22, one shared-hosting target over FTPS.
		// Neither the key nor the port was written for that server, and both would break it.
		const file = {
			server: { protocol: 'sftp', ...credentials, port: 22, privateKey: '~/.ssh/id_rsa', agent: '/tmp/agent' },
			targets: { shared: { server: { protocol: 'ftps', host: 'ftp.example', username: 'web', password: 'p', remoteRoot: '/www' } } },
		};

		const { config, cleanup } = await withConfig(file, { target: 'shared' });
		after(cleanup);
		assert.equal(config.protocol, 'ftps');
		assert.equal(config.connection.port, 21, 'the port follows the protocol that is actually in use');
		assert.equal(config.connection.privateKey, null);
		assert.equal(config.connection.agent, null);
		assert.equal(config.connection.password, 'p', 'what the target does say still applies');
	});

	it('keeps a port and a key a target did not contradict', async () => {
		const file = {
			server: { protocol: 'sftp', ...credentials, port: 2222, privateKey: '/tmp/id_test', password: null },
			targets: {
				staging: { server: { host: 'staging.example' } },
				same: { server: { protocol: 'sftp', host: 'same.example' } },
			},
		};
		fs.writeFileSync('/tmp/id_test', 'x');

		for (const target of ['staging', 'same']) {
			const { config, cleanup } = await withConfig(file, { target });
			after(cleanup);
			assert.equal(config.connection.port, 2222, `${target}: restating the same protocol retires nothing`);
			assert.equal(config.connection.privateKey, '/tmp/id_test', 'the key is for the same protocol');
		}
	});

	it('keeps a port given alongside the protocol on the same layer', async () => {
		const cli = await withConfig({ server: { protocol: 'sftp', ...credentials } }, { protocol: 'ftps', port: 9021 });
		after(cli.cleanup);
		assert.equal(cli.config.connection.port, 9021);
	});

	it('rejects SSH-only settings on an FTP connection', async () => {
		await assert.rejects(
			withConfig({ server: { protocol: 'ftp', ...credentials, privateKey: '~/.ssh/id_rsa' } }),
			/server.privateKey is an SFTP setting/,
		);
	});

	it('needs a password unless the login is anonymous', async () => {
		await assert.rejects(withConfig({ server: { protocol: 'ftp', host: 'h', username: 'u', remoteRoot: '/x' } }), /no password configured/);

		const { config, cleanup } = await withConfig({ server: { protocol: 'ftp', host: 'h', username: 'anonymous', remoteRoot: '/x' } });
		after(cleanup);
		assert.equal(config.protocol, 'ftp');
	});
});

describe('matching', () => {
	it('anchors patterns with a slash and floats those without', () => {
		const match = matcher(['build/out.css', 'node_modules', '*.log', 'src/**/*.map']);

		assert.ok(match('build/out.css'));
		assert.ok(!match('deep/build/out.css'), 'a slash anchors the pattern at the root');
		assert.ok(match('node_modules/x/y.js'));
		assert.ok(match('app/node_modules/x.js'), 'a bare name matches at any depth');
		assert.ok(match('var/logs/app.log'));
		assert.ok(match('src/a/b/app.js.map'));
		assert.ok(!match('other/a.map'));
		assert.ok(!match('index.php'));
	});

	it('treats a trailing slash as the same directory prefix', () => {
		assert.ok(matcher(['tests/'])('tests/unit/a.php'));
		assert.ok(matcher(['tests'])('tests/unit/a.php'));
	});

	it('lets a negated pattern carve an exception out', () => {
		const match = matcher(['*.log', '!keep.log']);
		assert.ok(match('a.log'));
		assert.ok(!match('keep.log'));
	});

	it('matches nothing when empty', () => {
		assert.equal(matcher([])('anything'), false);
	});
});

describe('cli arguments', () => {
	it('takes a path after list, and refuses one anywhere else', () => {
		assert.equal(parseArgs(['list']).path, undefined);
		assert.equal(parseArgs(['list', 'public/build']).path, 'public/build');
		assert.equal(parseArgs(['list', '/var/www']).path, '/var/www');

		assert.throws(() => parseArgs(['list', 'a', 'b']), /takes one path, not two/);
		assert.throws(() => parseArgs(['sync', 'public']), /unexpected argument 'public'/);
	});

	it('leaves the command unset when none is given, for run() to decide', () => {
		// No command means interactive in a terminal and a single pass anywhere else, which only
		// run() can tell apart — parseArgs must not guess one of them here.
		assert.equal(parseArgs([]).command, null);
		assert.equal(parseArgs(['sync']).command, 'sync');
		assert.equal(parseArgs(['ui']).command, 'ui');
		assert.equal(parseArgs(['watch']).command, 'watch');
	});

	it('reads values, repeated globs and --key=value', () => {
		const opts = parseArgs(['-t', 'prod', '--profile=assets', '--exclude', 'a', '--exclude', 'b', '-n']);
		assert.equal(opts.target, 'prod');
		assert.equal(opts.profile, 'assets');
		assert.deepEqual(opts.exclude, ['a', 'b']);
		assert.equal(opts.dryRun, true);
	});

	it('accepts --include and --exclude in the --key=value form too', () => {
		// They were parsed before the `=` form was, so `--exclude=*.log` came back as an unknown
		// option — for the two flags whose whole job is to be spelled the way .gitignore spells them.
		const opts = parseArgs(['--include=public/build', '--exclude=*.log', '--exclude', 'vendor']);
		assert.deepEqual(opts.include, ['public/build']);
		assert.deepEqual(opts.exclude, ['*.log', 'vendor'], 'and mix with the separate-argument form');
	});

	it('catches a repeat across the two spellings of the same option', () => {
		// The `=` form used to skip the repeat check entirely and quietly keep the last one.
		assert.throws(() => parseArgs(['-t', 'prod', '--target=staging']), /--target given twice/);
		assert.throws(() => parseArgs(['--profile=a', '-p', 'b']), /-p given twice \('a' and 'b'\)/);
		assert.equal(parseArgs(['-t', 'prod', '--target=prod']).target, 'prod', 'saying it twice is fine');
	});

	it('refuses a value attached to a flag that takes none', () => {
		assert.throws(() => parseArgs(['--dry-run=true']), /--dry-run takes no value/);
	});

	it('turns --no-delete into delete: false', () => {
		assert.equal(parseArgs(['--no-delete']).delete, false);
	});

	it('rejects unknown options, unknown commands and missing values', () => {
		assert.throws(() => parseArgs(['--nope']), /unknown option/);
		assert.throws(() => parseArgs(['deploy']), /unknown command/);
		assert.throws(() => parseArgs(['--target']), /needs a value/);
		assert.throws(() => parseArgs(['-i', 'soon']), /invalid --interval/);
	});
});

describe('helpers', () => {
	it('parses and formats durations', () => {
		assert.equal(parseDuration('30s'), 30_000);
		assert.equal(parseDuration('5m'), 300_000);
		assert.equal(parseDuration('1h'), 3_600_000);
		assert.equal(parseDuration(1500), 1500);
		assert.equal(parseDuration('nope'), null);
		assert.equal(formatDuration(300_000), '5m');
	});

	it('merges nested objects without letting undefined win', () => {
		const merged = merge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2], e: undefined });
		assert.deepEqual(merged, { a: { b: 1, c: 3 }, d: [2] });
	});
});
