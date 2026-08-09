import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { prune, reconcile } from '../src/engine.mjs';
import { TEMP_PREFIX } from '../src/sftp.mjs';
import { makeFixture, logger } from './helpers.mjs';

const run = (fx, opts = {}) => reconcile(fx.session, fx.config, logger, opts);

describe('prune --temp', () => {
	it('finds leftovers inside directories the ordinary prune refuses to enter', async () => {
		const fx = await makeFixture({
			files: { 'index.php': '<?php' },
			config: { strategy: 'blacklist', exclude: ['node_modules', 'vendor'] },
		});
		after(() => fx.cleanup());

		await run(fx);
		// What a killed upload leaves behind: one in the project, two inside trees this profile
		// excludes — which is exactly where an ordinary prune will not look.
		fx.remoteWrite(`${TEMP_PREFIX}index.php.k1abcd`, 'half');
		fx.remoteWrite(`node_modules/lodash/${TEMP_PREFIX}index.js.k2abcd`, 'half');
		fx.remoteWrite(`vendor/${TEMP_PREFIX}autoload.php.k3abcd`, 'half');
		fx.remoteWrite('vendor/autoload.php', 'real');

		const listed = await prune(fx.session, fx.config, logger, { temp: true, dryRun: true });
		assert.deepEqual(listed.orphans, [
			`${TEMP_PREFIX}index.php.k1abcd`,
			`node_modules/lodash/${TEMP_PREFIX}index.js.k2abcd`,
			`vendor/${TEMP_PREFIX}autoload.php.k3abcd`,
		]);
		assert.equal(listed.deleted, 0, 'a dry run deletes nothing');

		const done = await prune(fx.session, fx.config, logger, { temp: true, force: true });
		assert.equal(done.deleted, 3);
		assert.equal(fx.remoteRead('vendor/autoload.php'), 'real', 'a real file next to them is untouched');
		assert.equal(fx.remoteRead('index.php'), '<?php');
		assert.ok(
			!fx.remoteList().some((rel) => rel.includes(TEMP_PREFIX)),
			'every leftover is gone',
		);
	});

	it('leaves ordinary orphans alone', async () => {
		const fx = await makeFixture({ files: { 'a.txt': 'one' }, config: { strategy: 'blacklist' } });
		after(() => fx.cleanup());

		await run(fx);
		fx.remoteWrite('stranger.txt', 'not mine');

		const temps = await prune(fx.session, fx.config, logger, { temp: true, force: true });
		assert.equal(temps.deleted, 0, 'nothing matched');
		assert.equal(fx.remoteRead('stranger.txt'), 'not mine', 'the real orphan survives --temp');

		const all = await prune(fx.session, fx.config, logger, { dryRun: true });
		assert.deepEqual(all.orphans, ['stranger.txt'], 'and a plain prune still finds it');
	});
});

describe('prune scope follows the strategy', () => {
	it('audits node_modules when that is what the profile uploads', async () => {
		const fx = await makeFixture({
			files: { 'index.php': '<?php', 'node_modules/keep/index.js': 'x' },
			config: { strategy: 'whitelist', include: ['node_modules'] },
		});
		after(() => fx.cleanup());

		await run(fx);
		fx.remoteWrite('node_modules/removed-pkg/index.js', 'old');

		const r = await prune(fx.session, fx.config, logger, { dryRun: true });
		assert.deepEqual(r.orphans, ['node_modules/removed-pkg/index.js'], 'only what the project dropped');
	});

	it('leaves it alone when exclude puts it out of scope', async () => {
		const fx = await makeFixture({
			files: { 'index.php': '<?php' },
			config: { strategy: 'blacklist', exclude: ['node_modules'] },
		});
		after(() => fx.cleanup());

		await run(fx);
		fx.remoteWrite('node_modules/removed-pkg/index.js', 'old');
		fx.remoteWrite('vendor.bak/tracy/x.js', 'stray');

		const r = await prune(fx.session, fx.config, logger, { dryRun: true });
		assert.deepEqual(r.orphans, ['vendor.bak/tracy/x.js'], 'a lookalike name is not the excluded one');
	});
});

describe('prune under a profile', () => {
	/** A site, a vendor tree, an asset tree, and junk in several places. */
	const fixture = () =>
		makeFixture({
			files: {
				'index.php': '<?php',
				'vite.config.js': 'x',
				'vendor/tracy/Tracy.php': 'x',
				'public/css/app.css': 'x',
			},
			config: {
				strategy: 'blacklist',
				exclude: ['ftporter.config.json'],
				profiles: {
					assets: { strategy: 'whitelist', include: ['public/css'] },
					vendor: { strategy: 'whitelist', include: ['vendor'] },
				},
			},
		});

	const junk = (fx) => {
		fx.remoteWrite('vendor/dropped-pkg/x.php', 'x');
		fx.remoteWrite('vendor.bak/tracy/x.php', 'x');
		fx.remoteWrite('vendor-bin/deployer/composer.json', 'x');
		fx.remoteWrite('public/css/old.css', 'x');
	};

	it('keeps a whitelist profile inside the tree it owns', async () => {
		const fx = await fixture();
		after(() => fx.cleanup());
		await run(fx);
		junk(fx);

		const vendor = await prune(fx.session, await fx.reload({ profile: 'vendor' }), logger, { dryRun: true });
		assert.deepEqual(vendor.orphans, ['vendor/dropped-pkg/x.php'], 'the rest of the site is not its business');

		const assets = await prune(fx.session, await fx.reload({ profile: 'assets' }), logger, { dryRun: true });
		assert.deepEqual(assets.orphans, ['public/css/old.css']);
	});

	it('still walks everything without a profile', async () => {
		const fx = await fixture();
		after(() => fx.cleanup());
		await run(fx);
		junk(fx);

		const all = await prune(fx.session, fx.config, logger, { dryRun: true });
		assert.deepEqual(
			all.orphans,
			[
				'public/css/old.css',
				'vendor-bin/deployer/composer.json',
				'vendor.bak/tracy/x.php',
				'vendor/dropped-pkg/x.php',
			],
			'a blacklist run uploads vendor/, so prune audits it too',
		);
	});

	it('does not narrow when the profile owns the whole tree', async () => {
		const fx = await fixture();
		after(() => fx.cleanup());
		await run(fx);
		junk(fx);

		// A glob cannot be turned into a starting directory, so the walk stays full.
		const globbed = await fx.reload({ profile: undefined });
		globbed.strategy = 'whitelist';
		globbed.include = ['public/**/*.css'];
		const r = await prune(fx.session, globbed, logger, { dryRun: true });
		assert.ok(r.orphans.includes('vendor-bin/deployer/composer.json'), 'full walk, as before');
	});
});
