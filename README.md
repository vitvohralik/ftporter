# FTPorter

**Your files' porter — SFTP deploy, watcher and interval patrol.**

A porter carries the load *and* keeps an eye on the place. This one carries your project onto the
server, watches it while you work, and does its rounds on a timer to make sure nothing was missed.
Install it once, drop a config file into any project, and run it from that directory.

```bash
git clone https://github.com/vitvohralik/ftporter && cd ftporter && npm install && npm link

cd ~/projects/my-site
ftporter init      # write a config
ftporter test      # check the connection
ftporter watch     # upload on every save
```

## Why ftporter?

- **VS Code has no real deployment** — the extensions out there either upload everything or make you
  pick files by hand. None of them diff against the server. ftporter uploads only what actually
  changed, automatically.
- **Faster than PhpStorm's native deployment.** Parallel SFTP, directory-level scanning and
  mtime-based diffing make it noticeably quicker, even on large projects with thousands of files.
- **Dead simple to use.** One config file, one command. `ftporter watch` uploads on every save;
  `ftporter` does a one-shot sync. No plugins, no GUI, no surprises.
- **Editor-agnostic.** Works the same whether you use VS Code, PhpStorm, Neovim, Zed or anything
  else — it is a standalone tool, not tied to any editor's lifecycle.

## How it works

Editor deployment (PhpStorm and friends) keeps a local log of what it uploaded and drifts the moment
anything happens outside the editor. `rsync` is not an option on a host that only speaks SFTP.
Everything else either uploads the whole tree every time or needs the file list maintained by hand.

- **It decides what to upload from the live server state**, never from a local log. Size plus mtime,
  compared against the server on every run — so a run after a crash, a reboot or a week away closes
  the gap in one pass. After each upload the remote mtime is stamped from the local file, which is
  what keeps the two sides from drifting apart at all.
- **It only deletes what it uploaded itself.** A server holds symlinks into data stores, uploads,
  caches, `.env` files and deploy scripts that never existed locally. A naive "delete everything
  that is not local" would wreck it; a manifest of files this tool put there bounds deletion to
  exactly those, and anything changed on the server since is skipped.
- **The file list comes from git by default**, so `.gitignore` already protects the server's own
  copies of `vendor/`, `node_modules/`, build output and configuration. A whitelist and a blacklist
  are one config key away when git is not the right answer.
- **It is fast.** One `readdir` per directory instead of one `stat` per file, 64 of them in flight
  at once. A no-op run over a few thousand files takes about a second, so you can run it as often
  as you like.

## Install

Distributed from GitHub — there is no npm package yet.

```bash
git clone https://github.com/vitvohralik/ftporter
cd ftporter
npm install
npm link            # puts `ftporter` on your PATH
```

Or without cloning, straight from the repository:

```bash
npm install -g github:vitvohralik/ftporter
```

To update a cloned copy: `git pull && npm install`. To remove it: `npm unlink -g ftporter`.

Requires Node 18.17+. Nothing needs to live inside your project except the config file — the tool
looks for one in the working directory and every directory above it, so it works from a subdirectory
of a monorepo too.

## Quick start

```bash
cd ~/projects/my-site
ftporter init
```

That writes `ftporter.config.jsonc`. Fill in the connection:

```jsonc
{
  "root": ".",
  "sftp": {
    "host": "example.com",
    "username": "deploy",
    "remoteRoot": "/var/www/example",
    "privateKey": "~/.ssh/id_rsa"
  },
  "strategy": "git",
  "exclude": [".env", "*.log"]
}
```

Then:

```bash
ftporter test      # can I log in, does the remote root exist, may I write there?
ftporter -n        # what would a sync do?
ftporter           # do it
```

Output looks like this:

```
ftporter files → deploy@example.com:/var/www/example
  ↑ app/views/product/detail.twig
  ✗ app/views/product/old.twig
✓ files: 1 uploaded · 1 deleted · 1.2s
```

While it works, a status line shows progress (`server 128/458 dirs`, `upload 240/305`) and then
disappears. Piped into a file or CI, the status line is not printed at all.

## Commands

| Command | What it does |
| --- | --- |
| `ftporter` | One pass: upload what changed, delete what is gone. |
| `ftporter watch` | Stay running, upload on every save. |
| `ftporter patrol` | Stay running, full pass on a timer (`--interval 5m`). |
| `ftporter status` | What a sync would do. Changes nothing. |
| `ftporter prune` | List server files nobody knows about; `--force` removes them. |
| `ftporter test` | Connection, remote root and write access. Uploads nothing. |
| `ftporter init` | Write a commented config into the current directory. |
| `ftporter config` | Print the fully resolved configuration, secrets redacted. |

### Options

| | |
| --- | --- |
| `-c, --config <file>` | Config file to use (default: nearest one, searching upwards) |
| `-t, --target <name>` | Named server from `targets` |
| `-p, --profile <name>` | Named variant from `profiles` |
| `--root <dir>` | Project root to upload |
| `-n, --dry-run` | Print what would happen, change nothing |
| `-w, --watch` | Same as the `watch` command |
| `-i, --interval <time>` | Full pass every `30s` / `5m` / `1h` |
| `--strategy <name>` | `git`, `whitelist` or `blacklist` |
| `--include <glob>` | Extra path to upload (repeatable, added to the config) |
| `--exclude <glob>` | Extra path to skip (repeatable, wins over include) |
| `--no-delete` | Upload only, never delete |
| `-f, --force` | Allow a delete count over the cap; confirm `prune` |
| `--host` `--user` `--port` `--remote-root` `--key` | Override the connection for one run |
| `-v, --verbose` / `-q, --quiet` / `--json` | Output control |

`--json` prints a machine-readable summary (`{ ok, uploaded, deleted, uploads, deletes, ms }`) and
suppresses everything else — handy in CI.

### Watch and patrol

```bash
ftporter watch                 # filesystem events
ftporter watch --interval 10m  # events, plus a full pass every ten minutes
ftporter patrol --interval 5m  # timer only, no watcher
```

`watch` attaches the watcher and immediately runs a full pass, so nothing that changes while it
starts up is missed. From then on it batches filesystem events (`watch.debounce`, 300 ms) and runs
the same comparison over just the touched paths — the scope differs, not the rules.

`patrol` is the same loop with the watcher turned off. Use it where filesystem events are
unreliable or absent: network shares, containers with a bind mount, a build that runs elsewhere, a
machine that suspends. Adding `--interval` to `watch` gives you both — instant on save, with a
periodic sweep as the safety net.

Both hold one connection open and reconnect by themselves if it drops.

## Configuration

The config file may be `ftporter.config.jsonc`, `.json`, or `.js`/`.mjs` (exporting an object or a
function). JSON files accept `//` comments and trailing commas. Point at a specific one with
`--config`. See [`ftporter.config.example.jsonc`](ftporter.config.example.jsonc) for every key at
once, and [`schema/ftporter.schema.json`](schema/ftporter.schema.json) for editor autocompletion.

### Connection

```jsonc
"sftp": {
  "host": "example.com",
  "port": 22,
  "username": "deploy",
  "remoteRoot": "/var/www/example",

  "privateKey": "~/.ssh/id_rsa",          // passphrase-free, or set "passphrase"
  "passphrase": "${SSH_KEY_PASSPHRASE}",
  "password": "${DEPLOY_PASSWORD}",       // password auth instead
  "agent": "${SSH_AUTH_SOCK}"             // or let a running ssh-agent answer
}
```

Any string in the config can read the environment: `${VAR}`, or `${VAR:-fallback}`. Keep secrets
out of the file that way and the config is safe to commit. (`ftporter` never uploads its own config
file, whatever the strategy says.)

Environment overrides for a one-off run, no editing required: `FTPORTER_HOST`, `FTPORTER_USER`,
`FTPORTER_PORT`, `FTPORTER_REMOTE_ROOT`, `FTPORTER_KEY`, `FTPORTER_PASSWORD`,
`FTPORTER_PASSPHRASE`, `FTPORTER_AGENT`, `FTPORTER_ROOT`, `FTPORTER_STRATEGY`,
`FTPORTER_TARGET`, `FTPORTER_CONFIG`.

### What gets uploaded

`"strategy"` picks the rule:

| | |
| --- | --- |
| `"git"` *(default)* | `git ls-files --cached --others --exclude-standard` — everything git tracks or would track. `.gitignore` decides, uncommitted files are picked up without a commit, deleted ones drop out. Falls back to `blacklist` outside a git repository. |
| `"whitelist"` | Only what `include` lists. Nothing else is ever looked at. |
| `"blacklist"` | Everything under `root` except `exclude`. |

`include` and `exclude` are applied on top of all three, and **exclude always wins** — the more
restrictive rule takes precedence, so nothing explicitly forbidden can be uploaded by accident.
`include` reaches paths the strategy cannot see (gitignored build output, for instance); a directory
is walked recursively.

Pattern syntax:

| | |
| --- | --- |
| `app/config.php` | exact path |
| `tests` or `tests/` | that directory and everything under it |
| `*.log` | `*` matches anything except `/` |
| `src/**/*.map` | `**` crosses directories |
| `!keep.log` | a leading `!` carves out an exception |

A pattern **containing a slash is anchored** at the project root; a pattern **without one floats**,
the way `.gitignore` behaves — `node_modules` matches at any depth, `*.log` matches a log file
anywhere.

`"roots": ["public/build"]` narrows everything to a subtree, whatever the strategy says.

### Deletion

When a file disappears locally it disappears on the server too, and directories left empty are
cleaned up. Three guards, all on by default:

- Only files recorded in this tool's manifest are ever deletable. Anything else on the server —
  symlinks, uploads, `.env`, deploy scripts — is invisible to deletion.
- Before deleting, the remote file must still match what was last uploaded. If somebody changed it
  on the server, it is skipped with `changed on the server, not deleting`.
- Over `deleteCap` (default 50) the run stops and prints the first ten instead — the safety net for
  a broken git state or a run in the wrong directory. Rerun with `--force` if the list is right.

`"delete": false` turns deletion off entirely, `"deleteCap": null` removes the cap.

The manifest lives outside your project by default
(`~/.local/state/ftporter/<project>-<hash>.json`, override with `"stateFile"`). Deleting it is
safe: nothing breaks, the next run rebuilds it, and only deletion is unavailable until it does.

### Profiles and targets

`profiles` are named variants of the whole config, `targets` are named servers. Both override the
settings above, and a target can define its own profiles.

```jsonc
"profiles": {
  "assets": { "strategy": "whitelist", "include": ["public/build", "public/css"], "deleteCap": 500 }
},
"targets": {
  "staging": { "sftp": { "host": "staging.example.com", "remoteRoot": "/var/www/staging" } },
  "prod":    { "sftp": { "host": "prod.example.com",    "remoteRoot": "/var/www/prod" }, "delete": false }
}
```

```bash
ftporter -p assets              # only the build output
ftporter -t prod -n             # what would go to production?
ftporter -t staging -p assets   # both
```

Each target/profile pair keeps its **own manifest**, so an `assets` run never treats source files as
deleted, and a run against a scratch directory cannot corrupt the real target's state.

Precedence, lowest first: **defaults → config file → target → profile → environment → CLI flags.**
`--include` and `--exclude` are added to the config's lists rather than replacing them.

### Hooks

```jsonc
"hooks": {
  "beforeSync": "npm run build",
  "afterSync": "curl -fsS https://example.com/clear-cache",
  "onError": "say 'deploy failed'"
}
```

A hook is a command, an array of commands, or a function in a `.js` config. They run in the project
root with the outcome in the environment (`FTPORTER_UPLOADED`, `FTPORTER_DELETED`,
`FTPORTER_TARGET`, `FTPORTER_PROFILE`, `FTPORTER_ROOT`). A failing `beforeSync` aborts the run;
the others only warn.

### Everything else

| Key | Default | |
| --- | --- | --- |
| `root` | `"."` | Project directory to upload, relative to the config file |
| `preserveTimestamps` | `true` | Stamp the local mtime onto the uploaded file |
| `chmod` | `null` | e.g. `"644"` to set a mode on every uploaded file |
| `followSymlinks` | `false` | Upload the target of a symlink instead of skipping it |
| `concurrency.scan` | `64` | Parallel `readdir` calls |
| `concurrency.io` | `8` | Parallel uploads/deletes |
| `watch.debounce` | `300` | Collect rapid saves into one batch (ms) |
| `watch.interval` | `null` | Full pass on a timer — `"5m"` |
| `watch.ignored` | `["node_modules", "vendor", ".git"]` | Directories the watcher never looks into |
| `watch.usePolling` | `false` | For network drives and containers where events do not arrive |
| `mtimeToleranceMs` | `2000` | How far apart two timestamps may be and still count as equal |
| `stateFile` | `null` | Where the manifest lives |

## How it works

1. **Local list.** git, whitelist or blacklist → `lstat` for size and mtime. Paths that no longer
   exist drop out and become deletion candidates.
2. **Remote list.** One `readdir` per directory the local files live in (plus the directories the
   manifest knows), 64 in flight.
3. **Compare.** A file is uploaded when it is missing on the server, differs in size, differs in
   mtime by more than the tolerance — or when the manifest's millisecond timestamp says it changed
   locally since the last upload. That last check catches the case a second-resolution server clock
   cannot: an edit that keeps the file size and lands inside the same second.
4. **Upload, then stamp** the remote mtime from the local one (`utimes`). This is what makes the
   steady state exact and recoverable.
5. **Delete** what the manifest owns and the local side no longer has, then remove empty directories.
6. **Write the manifest** — failed uploads excluded, since they are not on the server in a shape we
   know and must not become deletable.

**Files owned by another user.** Some servers hold files a different uid owns. Writing to them can
still work, but the kernel refuses `utimes`, so their remote mtime stays at upload time and would
make them look changed forever. Those are recorded as `unstamped` and compared against the manifest
instead — reported as `13x could not set mtime (file owned by another user)`.

### `prune` — files from before

Files removed locally *before* this tool was in place stayed on the server, and the manifest knows
nothing about them, so ordinary deletion never finds them:

```bash
ftporter prune            # list only
ftporter prune --force    # and remove them
```

Unlike a normal run this walks the entire server tree — otherwise a directory deleted locally along
with its contents could never be found, which is the whole point. Symlinks are never followed or
offered, `exclude` is honoured, and under the git strategy anything `.gitignore` would hide is
skipped, which is what protects the server's build output and `.env`. It deliberately does not
delete on its own: the list needs human eyes before `--force`.

## Programmatic use

```js
import { sync, watch, loadConfig } from 'ftporter';

const result = await sync({ target: 'prod', dryRun: true });
console.log(result.uploads);
```

Every entry point takes the same options as the CLI flags in camelCase and resolves the config the
same way. `loadConfig`, `scanLocal`, `diff`, `reconcile` and `SftpSession` are exported too, if you
want to build something else on top.

## Troubleshooting

| | |
| --- | --- |
| `All configured authentication methods failed` | The key was rejected, or it has a passphrase and `passphrase` is not set. Check the public half is in the server's `authorized_keys`. |
| `Encrypted private key detected` | Set `"passphrase"`, or use `"agent": "${SSH_AUTH_SOCK}"`. |
| Everything uploads on every run | The server refuses `utimes` — look for the `could not set mtime` warning. It settles after one run; the manifest takes over. |
| Nothing is detected in watch mode | Filesystem events are not arriving (network share, container). Set `"watch": { "usePolling": true }`, or use `patrol`. |
| `N files would be deleted (cap 50)` | Check the printed list. Wrong directory or a broken git state is the usual cause; `--force` if it is right. |
| Deleted the state file | Nothing breaks. The next run rebuilds it; deletion is unavailable until then. |

## Development

```bash
npm install
npm test
```

The test suite runs against a real in-process SFTP server backed by a temporary directory
(`test/sftp-server.mjs`), so the actual ssh2 transport, concurrency, timestamps and error codes are
exercised end to end without anyone owning a server.

---

## Changelog

### 1.0.2

- Fixed output printing on top of the live status line: the top-level error handler (for example
  `  connecting…ftporter: cannot connect to …` when the handshake times out), anything a function
  hook prints, and the `^C` the shell echoes when a watch is interrupted.

### 1.0.1

- Dropped Node 18 from CI (EOL since April 2025); matrix now tests 20, 22, 24.

### 1.0.0

First public release. Grew out of a personal script that replaced PhpStorm's SFTP deployment, now
generalised so nothing about it is project-specific.

- **Configuration file** — `ftporter.config.jsonc` / `.json` / `.js`, discovered from the working
  directory upwards, with `${ENV}` interpolation, a JSON schema and `ftporter init`.
- **Install once, run anywhere.** A global install plus a config file in the project; the tool takes
  its root from the config (default: the config file's directory), so it never has to live inside
  the project.
- **Three file-selection strategies** — `git` (default), `whitelist`, `blacklist` — with `include`
  and `exclude` overriding all three, exclude always winning. Gitignore-style pattern matching:
  anchored when a pattern has a slash, floating when it does not, `**`, and `!` exceptions.
- **Profiles and targets.** Named config variants and named servers, combinable, each pair with its
  own manifest.
- **`watch`** — filesystem events, debounced, comparing only the touched paths, opening with a full
  pass that the watcher already covers.
- **`patrol`** — a full pass on an interval, for anywhere filesystem events are unreliable.
  `watch --interval` combines the two.
- **Safe deletion** — manifest-bounded, remote-state verified, capped, with `--no-delete` and
  `prune` for the files that predate the tool.
- **Hooks** — `beforeSync`, `afterSync`, `onError`, with the outcome exposed as environment
  variables.
- **`test`, `status`, `config` commands**, `--json` output, `--dry-run`, per-run connection
  overrides, `chmod`, `preserveTimestamps`, configurable concurrency.
- **Automatic reconnection** — a dropped connection is re-established on the next operation, so
  long-running `watch` and `patrol` sessions survive idle timeouts and network blips.
- **57 tests** against a real in-process SFTP server.

## License

MIT
