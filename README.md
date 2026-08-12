# FTPorter

[![npm](https://img.shields.io/npm/v/ftporter?logo=npm&color=cb3837)](https://www.npmjs.com/package/ftporter)
[![test](https://github.com/vitvohralik/ftporter/actions/workflows/test.yml/badge.svg)](https://github.com/vitvohralik/ftporter/actions/workflows/test.yml)
[![node](https://img.shields.io/node/v/ftporter?logo=node.js&logoColor=white&color=5fa04e)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/ftporter?color=blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/vitvohralik/ftporter?logo=github&color=f5c518)](https://github.com/vitvohralik/ftporter/stargazers)

**Your files' porter — an interactive SFTP deploy session, watcher and patrol.**

A porter carries the load *and* keeps an eye on the place. This one carries your project onto the
server, watches it while you work, and does its rounds on a timer to make sure nothing was missed.
It speaks SFTP, FTPS and FTP, and behaves the same over all three. Install it once, drop a config
file into any project, and run it from that directory.

```bash
npm install -g ftporter

cd ~/projects/my-site
ftporter init      # write a config
ftporter test      # check the connection
ftporter           # open the session: press S to upload
```

## Contents

[Why ftporter?](#why-ftporter) · [Design principles](#design-principles) · [Install](#install) ·
[Quick start](#quick-start) · [Commands](#commands) · [Interactive session](#interactive-session) ·
[Configuration](#configuration) ·
[How it works](#how-it-works) · [Programmatic use](#programmatic-use) ·
[Troubleshooting](#troubleshooting) · [Development](#development) · [Changelog](#changelog) ·
[License](#license)

## Why ftporter?

- **VS Code has no real deployment** — the extensions out there either upload everything or make you
  pick files by hand. None of them diff against the server. ftporter uploads only what actually
  changed, automatically.
- **Faster than PhpStorm's native deployment.** Parallel transfers, directory-level scanning and
  mtime-based diffing make it noticeably quicker, even on large projects with thousands of files.
- **SFTP, FTPS or FTP, same tool.** Shared hosting rarely offers SSH. One `"protocol"` key switches
  the wire format and nothing else changes — the same diff, the same safe deletion, the same
  `watch`, the same `prune`.
- **Dead simple to use.** One config file, one command. `ftporter` opens a session that uploads
  when you press `S`; `ftporter watch` uploads on every save; `ftporter sync` does one pass and
  exits. No plugins, no GUI, no surprises.
- **It uploads when you say so.** The session holds the connection open and does nothing until
  asked — which matters when a save is the middle of an edit, or when an agent is the one saving.
- **Editor-agnostic.** Works the same whether you use VS Code, PhpStorm, Neovim, Zed or anything
  else — it is a standalone tool, not tied to any editor's lifecycle.
- **It never serves half a file.** Uploads land under a temporary name and are renamed into place,
  so a dropped connection or a Ctrl-C cannot leave a truncated bundle live on the site — and several
  instances can run side by side without fighting over the same file.

## Design principles

Editor deployment (PhpStorm and friends) keeps a local log of what it uploaded and drifts the moment
anything happens outside the editor. `rsync` is not an option on a host that only speaks SFTP or
FTP. Everything else either uploads the whole tree every time or needs the file list maintained by
hand.

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

Requires Node 20+. Install it once, globally — nothing needs to live inside your project except the
config file.

### From npm — to use it

```bash
npm install -g ftporter      # puts `ftporter` on your PATH
```

Update with `npm update -g ftporter`, remove with `npm uninstall -g ftporter`.

Or skip the install altogether and let npx fetch it per run:

```bash
npx ftporter watch
```

### From git — to work on it

```bash
git clone https://github.com/vitvohralik/ftporter
cd ftporter
npm install
npm link            # puts your working copy on your PATH
```

`ftporter` now runs your checkout, edits included. Update with `git pull && npm install`, unhook it
with `npm unlink -g ftporter`.

### If npm warns about install scripts

npm 11 holds back dependencies' install scripts until you approve them, so you may see this:

```
npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   ssh2@1.17.0 (install: node install.js)
npm warn allow-scripts   cpu-features@0.0.10 (install: ...node-gyp rebuild)
```

**Ignore it — ftporter works fine.** That script builds `cpu-features`, an *optional* dependency of
ssh2 that picks natively accelerated ciphers for your CPU. Without it ssh2 falls back to the pure JS
crypto in Node, which costs some throughput on large transfers and nothing else; over SFTP the
network is the bottleneck anyway.

If you do want the acceleration, `npm approve-scripts ssh2 cpu-features` and reinstall. It needs a
working `node-gyp` toolchain, and if the build fails ssh2 quietly falls back again. An FTP or FTPS
target never loads ssh2 at all.

## Quick start

```bash
cd ~/projects/my-site
ftporter init
```

That writes `ftporter.config.jsonc`. Fill in the connection:

```jsonc
{
  "root": ".",
  "server": {
    "protocol": "sftp",
    "host": "example.com",
    "username": "deploy",
    "remoteRoot": "/var/www/example",
    "privateKey": "~/.ssh/id_rsa"
  },
  "strategy": "git",
  "exclude": [".env", "*.log"]
}
```

On shared hosting, where there is no SSH, the only difference is the protocol and a password:

```jsonc
"server": {
  "protocol": "ftps",
  "host": "ftp.example.com",
  "username": "web123",
  "password": "${FTP_PASSWORD}",
  "remoteRoot": "/www"
}
```

Then:

```bash
ftporter test      # can I log in, does the remote root exist, may I write there?
ftporter status    # what would a sync do?
ftporter sync      # do it
ftporter           # or open the session and decide as you go
```

You do not have to run these from the project root: ftporter looks for the config in the working
directory and every directory above it, so it works just as well from a subdirectory, or from a
single package inside a monorepo.

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
| `ftporter` | Open the [interactive session](#interactive-session) — one connection, held open, uploading only when asked. Without a terminal (a pipe, cron, CI) this runs `sync` instead. |
| `ftporter ui` | The session, explicitly. Fails where there is no terminal. |
| `ftporter sync` | One pass: upload what changed, delete what is gone. |
| `ftporter watch` | Stay running, upload on every save. |
| `ftporter patrol` | Stay running, full pass on a timer (`--interval 5m`). |
| `ftporter status` | What a sync would do. Changes nothing. |
| `ftporter list [path]` | Show a directory on the server as it actually is. Changes nothing. |
| `ftporter prune` | List server files nobody knows about; `--force` removes them. |
| `ftporter prune --temp` | List only leftovers from interrupted uploads, anywhere on the server. |
| `ftporter test` | Connection, remote root and write access. Uploads nothing. |
| `ftporter init` | Write a commented config into the current directory. |
| `ftporter config` | Print the fully resolved configuration, secrets redacted, in the shape a config file is written in. |
| `ftporter forget` | Throw the local manifest away, so the next run starts from the server. |

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
| `--protocol <name>` | `sftp`, `ftps`, `ftp` or `ftps-implicit`, for one run |
| `--include <glob>` | Extra path to upload (repeatable, added to the config) |
| `--exclude <glob>` | Extra path to skip (repeatable, wins over include) |
| `--no-delete` | Upload only, never delete |
| `--no-atomic` | Write straight onto the target instead of renaming a temp file into place |
| `--temp` | With `prune`: only `.ftporter-tmp.*` leftovers, ignoring `pruneSkip` and .gitignore |
| `--all` | With `forget`: every target and profile of the project, not just this run's |
| `--everything` | With `forget`: the config file too (needs `-f`) |
| `-f, --force` | Allow a delete count over the cap; confirm `prune` |
| `--host` `--user` `--port` `--remote-root` `--key` `--password` | Override the connection for one run |
| `-v, --verbose` / `-q, --quiet` / `--json` | Output control |

Every option that takes a value accepts either spelling: `-t prod`, `--target prod`,
`--target=prod`. Giving the same one twice is an error rather than a silent last-one-wins —
`--include` and `--exclude` are the two meant to repeat.

`--json` prints a machine-readable result and suppresses everything else — handy in CI. For a sync
that is `{ ok, target, profile, files, uploaded, deleted, failed, uploads, deletes, ms }`; for
`list` it is `{ ok, path, entries }`.

> **Changed in 2.0:** a bare `ftporter` **in a terminal** opens the session rather than running a
> single pass — typing the program's name opens the program, as terminal UIs do. Where there is no
> terminal (a pipe, cron, CI) it still does the single pass it did in 1.x, so scripts keep working.
> `ftporter sync` is explicit either way.

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

### Looking at the server

Every other command answers "what is different?". `list` answers "what is up there?" — for when a
path looks wrong or an upload went somewhere unexpected. No diff, no manifest, nothing changed.

```bash
ftporter list                  # the remote root
ftporter list public/build     # a directory under it
ftporter list /var/log         # a leading / addresses the server absolutely
```

```
/var/www/example
        2026-08-12 14:02  app/
        2026-08-11 09:31  public/
  1.4 KB  2026-08-12 16:57  composer.json
   184 B  2026-08-09 22:10  index.php
  2 directories · 2 files · 1.6 KB
```

Directories first, then files, each alphabetically. Symlinks are marked with `→`, and `--json`
prints the entries instead, with sizes in bytes and mtimes in milliseconds.

## Interactive session

```bash
ftporter        # in a terminal
ftporter ui     # explicitly, anywhere
```

One connection, opened once and held open, and a key bar to use it:

```
───────────────────────────────────────────────────────────────────────────────
S sync  n dry-run │ W watch:off  I patrol:off │ l list  p prune │ T target  P profile │ q quit  → prod/assets
```

Work is finished at irregular moments and wants to go up *then* — not on every save, which is
often the middle of an edit, and not on a timer that knows nothing about when you are done. One-off
syncs would do it, at the price of a connection, a handshake and a cold scan each time.

So the connection stays open and **nothing** goes up until asked. Above the bar it stays an ordinary
scrollable log — the same lines `ftporter sync` prints — not a redrawn screen.

| Key | |
| --- | --- |
| `S` | Sync: one full pass, exactly what `ftporter sync` does. |
| `n` | Dry run: what a sync would do, changing nothing. |
| `W` | Watch on/off. On, every save goes up. Green in the bar while it is on. |
| `I` | Patrol on/off. Asks how often, starting from `watch.interval`. Green while on. |
| `l` | List a directory on the server, starting from wherever it looked last. |
| `p` | Prune: list the files nobody knows about. |
| `T` `P` | Pick a target or a profile from a list. Shown only when there is more than one. |
| `F` | Answer the pending question — the one thing that just asked. |
| `q` | Quit. Ctrl-C does the same. |

**Capital letters change something, small letters only look**, so a key hit by accident reads
rather than uploads. `W` and `I` — the two that act on their own — turn green while they are on,
key included, so it survives a bar too narrow for labels.

**The cap and `prune` become questions instead of failures.** Where `ftporter sync` stops with
`51 files would be deleted (cap 50)` and wants `--force`, the session prints the same list and waits
for `F`. Any other key answers "no", and a confirmation never outlives the question it belongs to.

**Switching target or profile reopens the connection**, since a session belongs to one server. If
the new one refuses, you keep the one you had. A running watcher is reattached to whatever the new
profile uploads.

`q` mid-upload finishes the current action first: abandoning a transfer is what leaves temporary
files on the server, and waiting costs a few seconds.

## Configuration

The config file may be `ftporter.config.jsonc`, `.json`, or `.js`/`.mjs` (exporting an object or a
function). JSON files accept `//` comments and trailing commas. Point at a specific one with
`--config`. See [`ftporter.config.example.jsonc`](ftporter.config.example.jsonc) for every key at
once, and [`schema/ftporter.schema.json`](schema/ftporter.schema.json) for editor autocompletion.

### Connection

Everything about where the files go lives in one block, `"server"`, at every level of the config —
the file, a target, a profile. `"protocol"` inside it picks the wire format:

```jsonc
"server": {
  "protocol": "sftp",                     // sftp | ftps | ftp | ftps-implicit
  "host": "example.com",
  "port": 22,                             // optional: the protocol's own port is the default
  "username": "deploy",
  "remoteRoot": "/var/www/example",

  // SFTP authentication
  "privateKey": "~/.ssh/id_rsa",          // passphrase-free, or set "passphrase"
  "passphrase": "${SSH_KEY_PASSPHRASE}",
  "password": "${DEPLOY_PASSWORD}",       // password auth instead — and what FTP/FTPS use
  "agent": "${SSH_AUTH_SOCK}",            // or let a running ssh-agent answer

  // FTP and FTPS only
  "rejectUnauthorized": true,             // false accepts a self-signed server certificate
  "connections": 4                        // parallel control connections
}
```

> **Upgrading from 1.x:** the block used to be named after the protocol (`"sftp"`, `"ftps"`,
> `"ftp"`). Those names are refused now — rename the block to `"server"` and move the protocol
> inside it. ftporter says exactly that, naming the level it found the old block on.

### Protocols

| | |
| --- | --- |
| `"sftp"` *(default)* | File transfer over SSH, port 22. Key, password or ssh-agent authentication. |
| `"ftps"` | FTP with explicit TLS, **required**: a server that will not do `AUTH TLS` is an error rather than a silent downgrade. Port 21. |
| `"ftp"` | Plain FTP that still upgrades to TLS whenever the server offers it, and warns once when it cannot. Port 21. |
| `"ftps-implicit"` | Legacy FTPS, encrypted from the first byte. Port 990. |

Either way the TLS upgrade happens *before* the password goes over the wire. `"ftpes"`, `"ftp-tls"`
and `"ftps-explicit"` are accepted as spellings of `"ftps"`.

**A target may use a different protocol than the base** — keyed SFTP for staging, FTPS on shared
hosting is the common pair. What belonged to the protocol it left behind is not carried over: the
port falls back to the new one's, and `privateKey`, `passphrase` and `agent` are dropped. Host,
username, remote root and password always carry. Naming an SSH key *and* an FTP protocol in the
same block stays an error — there the key really was meant for that connection.

Everything else works the same over all four: the strategies, the diff against live server state,
atomic uploads, manifest-bounded deletion, `prune`, `watch` and `patrol`. What FTP cannot do, it
says once and works around:

- **Timestamps** need `MFMT` to set and `MLSD` to read back. A server missing either is announced
  when it connects, and the comparison falls back to the manifest — exact from the second run on.
- **`chmod`** needs `SITE CHMOD`, which many servers do not have. The first refusal is reported and
  `"chmod"` is ignored from then on.
- **Renaming over an existing file** is not defined by FTP, so an atomic upload deletes the target
  first — the same brief window SFTP has on servers without `posix-rename`.
- FTP carries **one command per connection**, so the session opens a small pool of them
  (`"connections"`, 4 by default). Servers commonly cap how many an account may open.

Any string in the config can read the environment: `${VAR}`, or `${VAR:-fallback}`. Keep secrets
out of the file that way and the config is safe to commit. (`ftporter` never uploads its own config
file, whatever the strategy says.)

Environment overrides for a one-off run, no editing required: `FTPORTER_HOST`, `FTPORTER_USER`,
`FTPORTER_PORT`, `FTPORTER_REMOTE_ROOT`, `FTPORTER_KEY`, `FTPORTER_PASSWORD`,
`FTPORTER_PASSPHRASE`, `FTPORTER_AGENT`, `FTPORTER_ROOT`, `FTPORTER_STRATEGY`,
`FTPORTER_PROTOCOL`, `FTPORTER_TARGET`, `FTPORTER_CONFIG`.

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
| `/node_modules` | a leading `/` pins it to the project root only |
| `!keep.log` | a leading `!` carves out an exception |

A pattern **containing a slash is anchored** at the project root; a pattern **without one floats**,
the way `.gitignore` behaves — `node_modules` matches at any depth, `*.log` matches a log file
anywhere. A leading `/` anchors, a leading `**/` floats, so the spellings you already have in
`.gitignore` can be pasted straight in.

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

### Starting over

```bash
ftporter forget                       # this target and profile
ftporter forget --all                 # every target and profile of this project
ftporter forget --everything --force  # and the config file with them
```

Nothing on the server changes, whichever you pick: the next pass reads the live server state and
writes the manifest again. Until it does, nothing is deleted — which is the only thing a manifest
decides. `-n` shows what would go.

The config file is the exception, and the reason `--everything` waits for `--force`: it is written
by hand, it may hold the only copy of a password, and nothing rebuilds it. Without `--force` it is
listed and left alone, the same bargain `prune` makes.

### Profiles and targets

`profiles` are named variants of the whole config, `targets` are named servers. Both override the
settings above, and a target can define its own profiles.

```jsonc
"profiles": {
  "assets": { "strategy": "whitelist", "include": ["public/build", "public/css"], "deleteCap": 500 }
},
"targets": {
  "staging": { "server": { "host": "staging.example.com", "remoteRoot": "/var/www/staging" } },
  "prod":    { "server": { "host": "prod.example.com",    "remoteRoot": "/var/www/prod" }, "delete": false },
  // A target may use a different protocol than the base — shared hosting rarely offers SSH.
  "shared":  { "server": { "protocol": "ftps", "host": "ftp.example.com", "username": "web123",
                           "password": "${FTP_PASSWORD}", "remoteRoot": "/www" } }
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
root with the run and its outcome in the environment (`FTPORTER_TARGET`, `FTPORTER_PROTOCOL`,
`FTPORTER_PROFILE`, `FTPORTER_ROOT`, `FTPORTER_UPLOADED`, `FTPORTER_DELETED`, `FTPORTER_ERROR`).
A failing `beforeSync` aborts the run; the others only warn.

### Everything else

| Key | Default | |
| --- | --- | --- |
| `root` | `"."` | Project directory to upload, relative to the config file |
| `preserveTimestamps` | `true` | Stamp the local mtime onto the uploaded file |
| `atomicUpload` | `true` | Upload to a temporary name and rename it over the target — see below |
| `chmod` | `null` | e.g. `"644"` to set a mode on every uploaded file |
| `followSymlinks` | `false` | Upload the target of a symlink instead of skipping it |
| `concurrency.scan` | `64` | Parallel `readdir` calls |
| `concurrency.io` | `8` | Parallel uploads/deletes |
| `watch.debounce` | `300` | Collect rapid saves into one batch (ms) |
| `watch.interval` | `null` | Full pass on a timer — `"5m"` |
| `watch.ignored` | `["node_modules", "vendor", ".git"]` | Directories the watcher never looks into |
| `watch.usePolling` | `false` | For network drives and containers where events do not arrive |
| `mtimeToleranceMs` | `2000` | How far apart two timestamps may be and still count as equal |
| `pruneSkip` | `.git`, editor dirs, config files | Extra directories `prune` never walks into |
| `stateFile` | `null` | Where the manifest lives |

### Atomic uploads

By default the bytes do not go to the file you are replacing. They go to a temporary name next to
it, get their mode and mtime, and are renamed over the target only once complete — the same thing
rsync does by default, and the reason it has an `--inplace` flag to turn it off.

> **This is what makes several instances safe to run at once.** A `watch` on one profile and a
> manual run on another cannot interleave their writes, even where both cover the same file. With
> `"atomicUpload": false` they can, and an interrupted upload leaves a truncated file live on the
> server.

Reasons to turn it off anyway:

- **Nothing reads the server while you upload** — a personal staging box, a bulk import. Then the
  protection buys nothing and costs a round trip per file. Prefer `--no-atomic` on the one run.
- **The rename replaces the file**, so ACLs, owner or group set on the old file are lost.
- **It needs room for both copies**, and write permission on the directory rather than the file.

`ftporter init` writes `"atomicUpload": true` into the generated config rather than leaving it to
the default — worth knowing you have it before you decide to turn it off.

[How it is done, and what it costs](#atomic-uploads-in-detail) has the mechanics and the numbers.

## How it works

1. **Local list.** git, whitelist or blacklist → `lstat` for size and mtime. Paths that no longer
   exist drop out and become deletion candidates.
2. **Remote list.** One `readdir` per directory the local files live in (plus the directories the
   manifest knows), 64 in flight.
3. **Compare.** A file is uploaded when it is missing on the server, differs in size, differs in
   mtime by more than the tolerance — or when the manifest's millisecond timestamp says it changed
   locally since the last upload. That last check catches the case a second-resolution server clock
   cannot: an edit that keeps the file size and lands inside the same second.
4. **Upload, then stamp** the remote mtime from the local one (`utimes` over SFTP, `MFMT` over
   FTP). This is what makes the steady state exact and recoverable.
5. **Delete** what the manifest owns and the local side no longer has, then remove empty directories.
6. **Write the manifest** — failed uploads excluded, since they are not on the server in a shape we
   know and must not become deletable.

**Files owned by another user.** Some servers hold files a different uid owns. Writing to them can
still work, but the kernel refuses `utimes`, so their remote mtime stays at upload time and would
make them look changed forever. Those are recorded as `unstamped` and compared against the manifest
instead — reported as `13x could not set mtime (file owned by another user)`.

**Servers that keep no timestamps at all.** An FTP server without `MFMT` or `MLSD` says so when it
connects, and everything is compared against the manifest instead. Step 3 has nothing to work with
on the first run there, so that one pass uploads everything; from the second on it is exact again.

### Atomic uploads in detail

Where the server offers OpenSSH's `posix-rename@openssh.com` extension, replacing the file is a
single atomic operation. Everywhere else — every FTP server, and any SFTP server without the
extension — the fallback is unlink-then-rename, which leaves a millisecond-wide window where the
file is missing rather than incomplete: still far better than writing over a live one. A file the
scan did not find on the server skips the unlink entirely, which is the bulk-import case.

The temporary file is per file, not per tree: it lives for the length of one transfer and is renamed
the moment that file is complete. A whole `vendor/` is never duplicated — the extra space at any
instant is one temp file per parallel upload, eight by default.

The cost is one round trip per uploaded file, which only shows up on a link with latency. Measured
over 800 small files at 20 ms RTT with the default concurrency of 8:

| | direct | atomic |
| --- | --- | --- |
| first upload (files not on the server yet) | 5.7 s | 8.2 s |
| replacing existing files, with `posix-rename` | 6.2 s | 9.0 s |
| replacing existing files, without it | 6.2 s | 11.4 s |

Roughly 1.4× on a normal OpenSSH server, 1.8× on one without the extension when overwriting. A run
that uploads nothing costs nothing extra: the price is per uploaded file, not per scanned one.

**Turning it off for `vendor` or `node_modules`.** Sensible when those trees only ever go to a box
nobody is browsing while you upload — the guarantee protects against something that cannot happen
there, and you keep the 40%. On a server other people or cron jobs use, keep it on: those trees are
read by the application at runtime, so a truncated file is a fatal error rather than a broken asset.

Either way an interrupted upload is not permanent. The next run compares sizes against the server,
finds the short file and replaces it — a fresh mtime on the truncated file does not fool it.

A hard kill can leave temporary files (`.ftporter-tmp.*`) behind:

```bash
ftporter prune --temp            # what is left over
ftporter prune --temp --force    # remove it
```

This is a different question from the orphan hunt, and a safer one: the name proves the file is
ftporter's own and that no finished upload is using it. So the walk covers the whole server — past
`exclude` and .gitignore, which is where a `vendor` or `node_modules` profile puts its files — while
never touching anything without that prefix. It needs no matching profile and cannot take a real
file with it.

### `prune` — files from before

Files removed locally *before* this tool was in place stayed on the server, and the manifest knows
nothing about them, so ordinary deletion never finds them:

```bash
ftporter prune            # list only
ftporter prune --force    # and remove them
```

Prune never deletes without `--force`, so `-n` adds nothing here — unlike a normal run, where it is
what holds the upload back.

Unlike a normal run, this walks the server itself instead of starting from the local file list —
otherwise a directory deleted locally along with its contents could never be found, which is the
whole point. Symlinks are never followed or offered, `exclude` is honoured, and under the git
strategy anything `.gitignore` would hide is skipped, which is what protects the server's build
output and `.env`.

**Prune looks exactly where the current run uploads, and nowhere else.** Whatever the strategy,
`include` and `exclude` decide to upload is what it walks — so a `git` run ignores what `.gitignore`
ignores, and a whitelist profile that names directories is walked inside those:

```bash
ftporter prune               # the site: strays like vendor-bin/ or an old vendor.bak/
ftporter prune -p vendor     # inside vendor/ only: packages the project has dropped
ftporter prune -p assets     # inside the asset dirs only
```

Passing two profiles (`-p a -p b`) is refused rather than silently using the last one.

Nothing outside that scope is ever called junk, and nothing needs a second list to protect it: if
`.gitignore` or `exclude` keeps `node_modules` out of your uploads, prune does not look there either,
and if a profile does upload it, prune audits it like anything else. `pruneSkip` exists only to skip
*more* on top — a tree too large to be worth walking — and defaults to the handful of paths no
strategy ever uploads (`.git`, editor directories, the config file).

One thing to watch: a directory is only out of scope under the exact name that excludes it. `vendor`
is left alone, while `vendor.bak` is a stranger like any other and will be offered for deletion.

## Programmatic use

```js
import { sync, watch, loadConfig } from 'ftporter';

const result = await sync({ target: 'prod', dryRun: true });
console.log(result.uploads);
```

Every entry point takes the same options as the CLI flags in camelCase and resolves the config the
same way — `sync`, `watch`, `patrol` and `prune`.

The pieces underneath are exported too: `loadConfig`, `findConfigFile`, `scanLocal`, `scanRemote`,
`diff`, `reconcile`, `reconcilePaths`, `matcher`, `UserError`, and the sessions — `openSession`,
plus `SftpSession` and `FtpSession`. Both sessions expose the same operations over the same shapes,
so code written against one works against the other; `src/session.mjs` states the contract.

## Troubleshooting

| | |
| --- | --- |
| `All configured authentication methods failed` | The key was rejected, or it has a passphrase and `passphrase` is not set. Check the public half is in the server's `authorized_keys`. |
| `Encrypted private key detected` | Set `"passphrase"`, or use `"agent": "${SSH_AUTH_SOCK}"`. |
| Everything uploads on every run | The server refuses `utimes` — look for the `could not set mtime` warning. It settles after one run; the manifest takes over. |
| Nothing is detected in watch mode | Filesystem events are not arriving (network share, container). Set `"watch": { "usePolling": true }`, or use `patrol`. |
| `N files would be deleted (cap 50)` | Check the printed list. Wrong directory or a broken git state is the usual cause; `--force` if it is right. |
| Deleted the state file | Nothing breaks. The next run rebuilds it; deletion is unavailable until then. |
| `uses the 1.x connection block "sftp"` | The connection block is called `"server"` since 2.0, with `"protocol"` inside it. The message names the level the old block sits on. |
| `The server did not accept AUTH TLS` | It cannot do explicit FTPS. Use `"protocol": "ftp"` to allow an unencrypted session, or `"ftps-implicit"` for a legacy TLS-only server on port 990. |
| The TLS certificate was rejected | Self-signed certificates are common on small hosts: `"rejectUnauthorized": false`. |
| `server does not offer TLS — this connection is unencrypted` | Under `"protocol": "ftp"`, said once per session. `"protocol": "ftps"` refuses to run at all rather than sending the password in the clear. |
| `server cannot set modification times` | The FTP server has no `MFMT`, or no `MLSD` to read them back. Nothing to fix — the manifest takes over after the first pass. |
| `uploading all N files: this server reports no modification times` | The same server on its first pass, with an empty manifest: nothing to compare against, so everything looks changed. It happens once. |
| `server rejected SITE CHMOD` | That server has no `chmod`. The setting is ignored from then on. |

## Development

```bash
npm install
npm test
```

The test suite runs against real in-process servers backed by a temporary directory — SFTP
(`test/sftp-server.mjs`) and FTP/FTPS (`test/ftp-server.mjs`, with a self-signed localhost
certificate) — so the actual transports, concurrency, timestamps and error codes are exercised end
to end without anyone owning a server. The FTP server can be started without `MFMT` or without
`MLSD`, which is how the fallback to the manifest is tested.

---

## Changelog

Every release, with what changed and why: [CHANGELOG.md](CHANGELOG.md).

---
## License

MIT
