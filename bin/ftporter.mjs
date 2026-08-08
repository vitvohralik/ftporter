#!/usr/bin/env node
import { run } from '../src/cli.mjs';
import { color } from '../src/logger.mjs';

try {
	process.exitCode = await run(process.argv.slice(2));
} catch (err) {
	if (err?.name === 'UserError') {
		console.error(`${color.red}ftporter: ${err.message}${color.reset}`);
		if (err.hint) console.error(`${color.dim}  ${err.hint}${color.reset}`);
	} else {
		console.error(`${color.red}ftporter: ${err?.stack ?? err}${color.reset}`);
	}
	process.exitCode = 1;
}
