import { spawn } from 'node:child_process';

import { UserError } from './util.mjs';

/**
 * Shell commands run around a sync — build before uploading, clear a cache after, notify on error.
 * A hook may be a string, an array of strings (run in order), or a function in a JS config.
 *
 * The command runs in the project root with the outcome exposed as environment variables
 * (FTPORTER_UPLOADED, FTPORTER_DELETED, FTPORTER_TARGET, FTPORTER_PROFILE), so a hook can react
 * to what actually happened. A failing `beforeSync` aborts the run; the others only warn.
 */
export async function runHook(name, config, logger, context = {}) {
	const hook = config.hooks?.[name];
	if (!hook) return;

	const env = {
		...process.env,
		FTPORTER_TARGET: config.target,
		FTPORTER_PROFILE: config.profileName,
		FTPORTER_ROOT: config.root,
		FTPORTER_UPLOADED: String(context.uploaded ?? 0),
		FTPORTER_DELETED: String(context.deleted ?? 0),
		FTPORTER_ERROR: context.error ? String(context.error) : '',
	};

	for (const command of [hook].flat()) {
		if (typeof command === 'function') {
			// The hook may print; get the status line out of its way first, like logger.dim does
			// for the spawned variant below.
			logger.clearStatus();
			await command({ config, ...context });
			continue;
		}
		logger.dim(`  hook ${name}: ${command}`);
		const code = await new Promise((resolve) => {
			const child = spawn(command, { cwd: config.root, env, shell: true, stdio: 'inherit' });
			child.on('error', () => resolve(-1));
			child.on('close', resolve);
		});
		if (code !== 0) {
			const message = `hook ${name} failed (exit ${code}): ${command}`;
			if (name === 'beforeSync') throw new UserError(message);
			logger.warn(message);
			return;
		}
	}
}
