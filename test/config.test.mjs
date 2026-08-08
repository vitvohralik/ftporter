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
	sftp: { host: 'h', username: 'u', remoteRoot: '/srv/app', password: 'p' },
};

describe('config', () => {
	it('resolves defaults and derives the target label', async () => {
		const { config, cleanup } = await withConfig(minimal);
		after(cleanup);

		assert.equal(config.strategy, 'git');
		assert.equal(config.delete, true);
		assert.equal(config.deleteCap, 50);
		assert.equal(config.target, 'u@h:/srv/app');
		assert.equal(config.sftp.port, 22);
	});

	it('applies targets and profiles over the base, CLI over both', async () => {
		const { config, cleanup } = await withConfig(
			{
				...minimal,
				deleteCap: 10,
				targets: { prod: { sftp: { host: 'prod.example', remoteRoot: '/var/www' }, delete: false } },
				profiles: { assets: { strategy: 'whitelist', include: ['public/build'], deleteCap: 500 } },
			},
			{ target: 'prod', profile: 'assets', strategy: 'blacklist' },
		);
		after(cleanup);

		assert.equal(config.sftp.host, 'prod.example', 'target wins over the base');
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
			{ sftp: { host: 'h', username: 'u', remoteRoot: '/x', password: '${DEPLOY_PW}' } },
			{},
			{ DEPLOY_PW: 'hunter2' },
		);
		after(cleanup);

		assert.equal(config.sftp.password, 'hunter2');
	});

	it('rejects a config with no way to authenticate', async () => {
		await assert.rejects(
			withConfig({ sftp: { host: 'h', username: 'u', remoteRoot: '/x' } }),
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
	it('defaults to the sync command', () => {
		assert.equal(parseArgs([]).command, 'sync');
		assert.equal(parseArgs(['watch']).command, 'watch');
	});

	it('reads values, repeated globs and --key=value', () => {
		const opts = parseArgs(['-t', 'prod', '--profile=assets', '--exclude', 'a', '--exclude', 'b', '-n']);
		assert.equal(opts.target, 'prod');
		assert.equal(opts.profile, 'assets');
		assert.deepEqual(opts.exclude, ['a', 'b']);
		assert.equal(opts.dryRun, true);
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
