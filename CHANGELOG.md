# Changelog

### 2.0.0

**Breaking:** the connection block is now called `"server"` at every level of the config, and the
protocol is a key inside it. The 1.x blocks — `"sftp"`, `"ftps"`, `"ftp"`, `"connection"` — are
refused on load with a message naming the level they sit on, rather than ignored: a block that
silently did nothing would take the host, the credentials and the remote root with it.

```jsonc
// 1.x                             // 2.0
"sftp": { "host": "example.com" }  "server": { "protocol": "sftp", "host": "example.com" }
```

The name used to be the whole interface for picking a protocol, which left implicit FTPS unnameable
and a target unable to switch protocol without being rewritten. As a value, `"protocol"` merges like
everything else: a target overrides the file, a profile overrides the target, `FTPORTER_PROTOCOL`
and `--protocol` override both. It defaults to `"sftp"`, which is what every 1.x config meant.

- **Pick your protocol: SFTP, FTPS or FTP.** `"protocol": "ftps"` requires TLS and fails rather than
  downgrading; `"ftp"` upgrades to TLS whenever the server offers it and warns when it cannot.
  `"protocol": "ftps-implicit"` covers legacy TLS-only servers on port 990. The port follows the
  protocol unless you set one: 22, 21, 21, 990.
- **Everything else works the same over FTP**: the strategies, the diff against live server state,
  atomic uploads, manifest-bounded deletion, `prune`, `watch` and `patrol`. Where FTP cannot do
  something — no `MFMT`/`MLSD` for timestamps, no `SITE CHMOD` for the mode — it says so once and
  falls back to comparing against the manifest.
- **`rejectUnauthorized`** accepts a self-signed certificate, and **`connections`** caps how many
  control connections an FTP session opens (4 by default). FTP carries one command per connection,
  so the pool is what makes scanning and uploading parallel — and servers commonly cap it.
- **A target may switch protocol on its own.** When it does, what belonged to the protocol it left
  behind stays behind: the port falls back to the new protocol's own, and `privateKey`, `passphrase`
  and `agent` are dropped instead of merging down from a block written for a different server. A
  keyed SFTP base on port 22 plus one FTPS target needs nothing nulled out. Naming an SSH key and an
  FTP protocol in the *same* block is still refused — there the key really was meant for that
  connection, and it cannot work.
- **`--password`** joins the per-run connection overrides, and hooks now see `FTPORTER_PROTOCOL`.
- For anyone building on the exported session objects: `readdir` now returns
  `{name, dir, link, size, mtime}` (mtime in milliseconds) instead of ssh2's raw entries, and
  `stat` returns `{size, mtime}` in milliseconds instead of ssh2's `Stats`.

Upgrading from 1.x: rename the connection block to `"server"` and put `"protocol"` inside it. That
is the whole migration — `ftporter` says so by name if a block is missed.

**Breaking:** `ftporter` with no arguments now opens the interactive session instead of running a
single pass. Typing the program's name opens the program, as terminal UIs do; one-off work says
which one it wants. **Where there is no terminal — a pipe, cron, CI — a bare
`ftporter` still does the single pass it did in 1.x**, so scripts and scheduled jobs keep working
untouched. To be explicit either way: `ftporter sync` is the one pass, `ftporter ui` is the session.

- **Interactive session.** One connection, opened once and held open, and a key bar to use it:
  `S` sync, `n` dry run, `W` watch on/off, `I` patrol on a timer it asks you for, `p` prune,
  `F` confirm, `T`/`P` pick a target or profile from a list, `q` quit. Capital letters change
  something, small ones only look, so a key hit by accident reads rather than uploads.
- It uploads **nothing** until asked, which is the point when a project is deployed rather than run
  locally, or when an agent is editing files and half-written states must not go up. Above the bar
  it stays an ordinary scrollable log, not a redrawn screen.
- The cap and `prune` become questions instead of failures: they print what they would remove and
  wait for `F`. Any other key answers "no", and a confirmation never outlives the question.
- `I` starts a patrol from inside the session, asking how often on a typed line that starts from
  whatever `watch.interval` already says.
- `q` mid-upload finishes the action first rather than abandoning a transfer.
- Switching target or profile reopens the connection and keeps the old one if the new one refuses.
- For anyone building on this: `createWatcher` is exported from `src/watch.mjs`, and a resolved
  config now carries `knownTargets` and `knownProfiles` — the names `T` and `P` offer, which are
  otherwise stripped out of every resolved layer.

### 1.2.0

- **Atomic uploads**, on by default. A file is uploaded to a temporary name next to the target,
  given its mode and mtime, and renamed into place — using OpenSSH's `posix-rename@openssh.com`
  where the server has it, unlink-then-rename everywhere else. An interrupted run can no longer
  leave a truncated file live on the server, and several instances may now run side by side even
  when they cover the same files. Set `"atomicUpload": false` for the old behaviour.
- **The state file is written atomically and under a lock**, so instances sharing a project no
  longer risk losing each other's manifest section or reading a half-written file.
- **`--no-atomic`** turns the temporary file off for a single run, for bulk imports where nothing is
  reading the server yet.
- **`ftporter prune --temp`** clears leftovers from interrupted uploads. It walks past `pruneSkip`
  and .gitignore — so it also reaches inside `vendor` and `node_modules` — and removes nothing but
  ftporter's own `.ftporter-tmp.*` files.
- **`prune` now looks exactly where the strategy uploads, and nowhere else.** It used to walk the
  whole server whatever profile was running, so `-p vendor` reported the entire rest of the site as
  orphaned — one `--force` away from deleting it. A whitelist profile is now walked inside its own
  directories, and `pruneSkip` no longer hides `node_modules` and `vendor` from a run that uploads
  them: what `.gitignore` and `exclude` already keep out of scope was doing that job anyway.
- **A repeated `-p`/`-t`/`--root` is now an error** instead of quietly keeping the last one.
- **Fixed `/node_modules` and `**/node_modules` matching nothing** in `include`, `exclude` and
  `watch.ignored`. Both are everyday .gitignore spellings, and a pattern that silently matches
  nothing is the worst way for an exclude to be wrong.

### 1.1.0

First release published to npm — `npm install -g ftporter`, or `npx ftporter` without installing.

- `engines.node` raised to `>=20`, matching what CI actually tests since 1.0.1. Node 18 has been
  end of life since April 2025. npm only warns (`EBADENGINE`) rather than refusing to install, so
  an existing Node 18 setup will most likely keep working — it is simply no longer tested.

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
