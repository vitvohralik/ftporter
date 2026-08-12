/**
 * Programmatic API.
 *
 *   import { sync, watch } from 'ftporter';
 *   await sync({ target: 'prod' });
 *
 * Every entry point takes the same options as the CLI flags (camelCase) and resolves the config
 * exactly the way the CLI does, so a script and the command line behave identically.
 */
import { loadConfig } from './config.mjs';
import { listRemote as listOnServer, prune as pruneRemote, reconcile } from './engine.mjs';
import { createLogger, silentLogger } from './logger.mjs';
import { openSession } from './session.mjs';
import { runWatch } from './watch.mjs';

export { loadConfig, findConfigFile, DEFAULTS, PROTOCOLS, STRATEGIES } from './config.mjs';
export { diff, listRemote, reconcile, reconcilePaths, scanRemote } from './engine.mjs';
export { scanLocal } from './scan.mjs';
export { openSession } from './session.mjs';
export { SftpSession } from './sftp.mjs';
export { FtpSession } from './ftp.mjs';
export { matcher } from './match.mjs';
export { UserError } from './util.mjs';

async function withSession(options, fn) {
	const logger = options.logger ?? (options.silent ? silentLogger() : createLogger(options));
	const config = options.config?.root ? options.config : await loadConfig(options);
	const session = await openSession(config, logger);
	try {
		return await fn(session, config, logger);
	} finally {
		session.end();
	}
}

export const sync = (options = {}) =>
	withSession(options, (session, config, logger) => reconcile(session, config, logger, options));

export const watch = (options = {}) =>
	withSession(options, (session, config, logger) =>
		runWatch(session, config, logger, { ...options, useWatcher: options.useWatcher ?? true }),
	);

export const patrol = (options = {}) =>
	withSession(options, (session, config, logger) => runWatch(session, config, logger, { ...options, useWatcher: false }));

export const prune = (options = {}) =>
	withSession(options, (session, config, logger) => pruneRemote(session, config, logger, options));

export const list = (options = {}) =>
	withSession(options, (session, config, logger) => listOnServer(session, config, logger, options));
