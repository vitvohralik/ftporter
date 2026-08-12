/**
 * What the engine talks to, whichever protocol is in play.
 *
 * A session — `SftpSession` or `FtpSession` — exposes the same handful of operations (`readdir`,
 * `put`, `mkdir`, `unlink`, `rmdir`, `stat`, `chmod`, `utimes`, `end`) over the same shapes, so
 * nothing above this line knows or cares how the bytes travel.
 *
 * Three things had to be agreed on for that to hold:
 *   - a listing entry is `{name, dir, link, size, mtime}`, with the mtime in milliseconds;
 *   - `stat` answers in the same shape, `{size, mtime}`, in milliseconds as well — SFTP and FTP
 *     both count in seconds on the wire, in different ways, and neither unit escapes this line;
 *   - "no such file" is reported as an error carrying `code === NO_SUCH_FILE`, whatever the wire
 *     called it (SFTP status 2, FTP reply 550).
 */

/** SFTP status codes, reused by the FTP session so the engine has one thing to check. */
export const NO_SUCH_FILE = 2;
export const PERMISSION_DENIED = 3;

/**
 * A sibling of the target, so the rename stays within one filesystem and cannot degrade into a
 * copy. The pid and a random suffix keep concurrent instances — and repeated runs — apart.
 */
export const TEMP_PREFIX = '.ftporter-tmp.';

export function tempPath(target) {
	const slash = target.lastIndexOf('/');
	const dir = slash === -1 ? '' : target.slice(0, slash + 1);
	const base = target.slice(slash + 1);
	const suffix = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	return `${dir}${TEMP_PREFIX}${base}.${suffix}`;
}

/**
 * Opens the session the configured protocol asks for.
 *
 * The clients are imported on demand: a plain FTP run has no reason to pull in ssh2 (and its
 * optional native bits), and an SFTP run none to load the FTP client.
 */
export async function openSession(config, logger) {
	if (config.protocol === 'sftp') {
		const { SftpSession } = await import('./sftp.mjs');
		return SftpSession.open(config, logger);
	}
	const { FtpSession } = await import('./ftp.mjs');
	return FtpSession.open(config, logger);
}
