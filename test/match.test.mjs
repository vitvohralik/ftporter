import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matcher } from '../src/match.mjs';

const hits = (pattern, paths) => paths.filter(matcher([pattern]));

describe('gitignore spellings', () => {
	const paths = ['node_modules', 'node_modules/lodash/index.js', 'app/node_modules/x.js', 'src/app.js'];

	it('matches a bare name at any depth', () => {
		assert.deepEqual(hits('node_modules', paths), paths.slice(0, 3));
		assert.deepEqual(hits('node_modules/', paths), paths.slice(0, 3));
	});

	it('anchors a leading slash to the project root', () => {
		// Used to match nothing: the pattern kept its slash, the paths never have one.
		assert.deepEqual(hits('/node_modules', paths), ['node_modules', 'node_modules/lodash/index.js']);
		assert.deepEqual(hits('/node_modules/', paths), ['node_modules', 'node_modules/lodash/index.js']);
	});

	it('treats a leading **/ as any depth, root included', () => {
		// Used to require a slash before the name, so the top-level directory slipped through.
		assert.deepEqual(hits('**/node_modules', paths), paths.slice(0, 3));
	});

	it('leaves the documented spellings alone', () => {
		assert.deepEqual(hits('node_modules/**', paths), ['node_modules/lodash/index.js']);
		assert.deepEqual(hits('*.js', paths), ['node_modules/lodash/index.js', 'app/node_modules/x.js', 'src/app.js']);
		assert.deepEqual(hits('src/app.js', paths), ['src/app.js']);
	});

	it('still lets a negation win', () => {
		const m = matcher(['node_modules', '!node_modules/keep.txt']);
		assert.equal(m('node_modules/lodash/index.js'), true);
		assert.equal(m('node_modules/keep.txt'), false);
	});
});
