/**
 * Path matching for `include`, `exclude` and `watch.ignored`.
 *
 * Syntax (deliberately small, and the same everywhere in the config):
 *   app/config.php   exact path
 *   tests, tests/    directory prefix — matches the directory and everything under it
 *   *.log            `*` matches anything except `/`
 *   docs/ ** /*.md   `**` matches across `/`
 *   !keep.log        a leading `!` negates — useful as an exception inside a broad pattern
 */

const escapeRegex = (text) => text.replaceAll(/[.+^${}()|[\]\\?]/g, String.raw`\$&`);

/**
 * Turns a star pattern into a regular expression. Split on `**` first, then split each chunk on
 * `*`; whatever is left is literal. Doing it with successive replaceAll calls would need a
 * placeholder so `*` and `**` do not clobber each other — this way none is needed.
 */
export const globToRegex = (pattern) =>
	new RegExp(
		`^${pattern
			.split('**')
			.map((chunk) => chunk.split('*').map(escapeRegex).join('[^/]*'))
			.join('.*')}$`,
	);

/**
 * A pattern containing `/` is anchored at the project root (`build/out.css`, `src/**\/*.map`).
 * A pattern without one floats, the way .gitignore behaves: `*.log` matches a log file at any
 * depth, and `node_modules` matches every directory of that name, not just the top-level one.
 */
function compile(patterns) {
	const rootedRe = [];
	const rootedLiteral = [];
	const floatingRe = [];
	const floatingLiteral = [];

	for (const raw of patterns) {
		const pattern = String(raw).replace(/^\.\//, '').replace(/\/+$/, '');
		if (!pattern) continue;
		const floating = !pattern.includes('/');
		if (pattern.includes('*')) (floating ? floatingRe : rootedRe).push(globToRegex(pattern));
		else (floating ? floatingLiteral : rootedLiteral).push(pattern);
	}

	return (rel) => {
		if (rootedLiteral.some((p) => rel === p || rel.startsWith(`${p}/`))) return true;
		if (rootedRe.some((r) => r.test(rel))) return true;
		if (floatingLiteral.length === 0 && floatingRe.length === 0) return false;
		const segments = rel.split('/');
		return segments.some((segment) => floatingLiteral.includes(segment) || floatingRe.some((r) => r.test(segment)));
	};
}

/**
 * Returns a predicate answering "does this path match any of those patterns?".
 * Negated patterns (`!foo`) win over positive ones.
 */
export function matcher(patterns = []) {
	const list = patterns.filter(Boolean).map(String);
	if (list.length === 0) return () => false;
	const positive = compile(list.filter((p) => !p.startsWith('!')));
	const negative = compile(list.filter((p) => p.startsWith('!')).map((p) => p.slice(1)));
	return (rel) => positive(rel) && !negative(rel);
}
