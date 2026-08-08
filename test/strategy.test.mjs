import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { reconcile } from '../src/engine.mjs';
import { scanLocal } from '../src/scan.mjs';
import { makeFixture, logger } from './helpers.mjs';

const files = {
	'index.php': 'app',
	'src/app.js': 'js',
	'src/app.js.map': 'map',
	'build/out.css': 'built',
	'secrets/.env': 'SECRET=1',
	'notes.log': 'log',
	'.gitignore': 'build/\n*.log\nsecrets/\n',
};

const rels = (fx) => [...scanLocal(fx.config, logger).keys()].sort();

describe('file selection', () => {
	it('git: follows .gitignore, including files not committed yet', async () => {
		const fx = await makeFixture({ files, config: { strategy: 'git' } });
		after(() => fx.cleanup());
		fx.git('init');

		assert.deepEqual(rels(fx), ['.gitignore', 'index.php', 'src/app.js', 'src/app.js.map']);

		fx.write('brand-new.php', 'new');
		assert.ok(rels(fx).includes('brand-new.php'), 'an uncommitted file is picked up without a commit');
	});

	it('git: include overrides .gitignore, exclude overrides everything', async () => {
		const fx = await makeFixture({
			files,
			config: { strategy: 'git', include: ['build'], exclude: ['*.map', 'ftporter.config.json'] },
		});
		after(() => fx.cleanup());
		fx.git('init');

		const selected = rels(fx);
		assert.ok(selected.includes('build/out.css'), 'include reaches a gitignored path');
		assert.ok(!selected.includes('src/app.js.map'), 'exclude wins');
		assert.ok(!selected.includes('secrets/.env'), '.gitignore still protects the rest');
	});

	it('git: an excluded path beats the same path in include', async () => {
		const fx = await makeFixture({
			files,
			config: { strategy: 'git', include: ['secrets'], exclude: ['secrets', 'ftporter.config.json'] },
		});
		after(() => fx.cleanup());
		fx.git('init');

		assert.ok(!rels(fx).includes('secrets/.env'));
	});

	it('whitelist: uploads only what is listed', async () => {
		const fx = await makeFixture({
			files,
			config: { strategy: 'whitelist', include: ['build', 'index.php'] },
		});
		after(() => fx.cleanup());

		assert.deepEqual(rels(fx), ['build/out.css', 'index.php']);

		const result = await reconcile(fx.session, fx.config, logger, {});
		assert.equal(result.uploaded, 2);
		assert.deepEqual(fx.remoteList(), ['build/out.css', 'index.php']);
	});

	it('whitelist: refuses an empty list instead of uploading nothing', async () => {
		await assert.rejects(
			makeFixture({ files, config: { strategy: 'whitelist', include: [] } }),
			/needs at least one entry/,
		);
	});

	it('blacklist: everything except the excluded paths', async () => {
		const fx = await makeFixture({
			files,
			config: { strategy: 'blacklist', exclude: ['secrets', '*.log', 'build', 'ftporter.config.json'] },
		});
		after(() => fx.cleanup());

		assert.deepEqual(rels(fx), ['.gitignore', 'index.php', 'src/app.js', 'src/app.js.map']);
	});

	it('blacklist: ** crosses directories, * does not', async () => {
		const fx = await makeFixture({
			files: { 'a/b/c/deep.txt': '1', 'a/top.txt': '2', 'root.txt': '3' },
			config: { strategy: 'blacklist', exclude: ['a/**/deep.txt', '*.json'] },
		});
		after(() => fx.cleanup());

		assert.deepEqual(rels(fx), ['a/top.txt', 'root.txt']);
	});

	it('roots narrows any strategy down to a subtree', async () => {
		const fx = await makeFixture({
			files,
			config: { strategy: 'blacklist', roots: ['src'], exclude: ['ftporter.config.json'] },
		});
		after(() => fx.cleanup());

		assert.deepEqual(rels(fx), ['src/app.js', 'src/app.js.map']);
	});

	it('falls back to blacklist when the root is not a git repository', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'a' }, config: { strategy: 'git' } });
		after(() => fx.cleanup());

		assert.deepEqual(rels(fx), ['a.txt']);
	});
});
