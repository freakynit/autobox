# @freakynit/autobox

An MCP server that allows AI agents to sandbox themselves, and gives them a fast, sandboxed place to run code and shell commands. This is for M-series Macs only.

## Autobox was built around two observations:

1. Sandboxes already exist and work well. But almost nobody uses them. The blocker isn't the technology, it's the setup friction — however small it looks on paper, it's enough that people skip it entirely.

2. LLMs mostly don't write harmful code or take destructive steps. They're not adversarial by default.

Autobox bets on the second observation to remove the first. Instead of asking you to configure a sandbox, it's just there: every tool call carries its own permissions, and anything you don't explicitly allow is denied.

- Is it perfect? Of course not — seatbelt filesystem rules are best-effort, and the strong isolation is the V8 path. 
- Is it better than not usign sandboxes at all? A 100% yes.

**Autobox reduces the probability of things going wrong for people who don't use sandboxes, without requiring any effor on their part.**

If you are from one of those handful few who already uses sandbox, then this is not for you.

It exposes three tools:

- `execute_js` — runs JavaScript inside a fresh V8 isolate (p50 ~1ms on Apple Silicon).
- `exec_command` — runs a shell command under the macOS seatbelt sandbox (~3–10ms).
- `copy_then_sync` — creates a persistent writable copy, previews changes, explicitly
  syncs changes to the host, or discards the copy.

Every call carries its own permissions: networking, CPU timeout, memory limit, disk
quotas, and an explicit list of host directories mounted read-only or read-write.
Anything not explicitly allowed is denied.

## Contents

- [For coding agents (AGENTS.md)](#for-coding-agents-agentsmd)

- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Tools](#tools)
  - [`execute_js`](#execute_js)
  - [`exec_command`](#exec_command)
  - [`copy_then_sync`](#copy_then_sync)
- [Examples](#examples)
- [Design](#design)
- [Performance](#performance)
- [Limitations](#limitations)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## For coding agents (AGENTS.md)

Paste these 3 lines into your project's `AGENTS.md`:

```md
- Use `execute_js` for untrusted JS (no network/fs by default; pass minimal `mounts`, `timeoutMs`/`memoryMb` budgets) and `exec_command` only for trusted-ish lint/build tooling with `allowNetwork: false`.
- To edit a host directory, run `copy_then_sync create` → edit via `{ workspaceId }` mounts → `status` → `sync`; never edit the source directly — `sync` is explicit and conflicts abort with nothing applied.
- Keep mounts least-privilege (`ro` unless writes needed), pause external writers during `create`/`sync`, and use `copyMode: "auto"` only for cross-volume / non-APFS sources.
```

## Requirements

- Apple Silicon Mac (`darwin/arm64`). Intel, Windows, and Linux are not supported.
- Node.js 20 or newer.

## Install

```bash
npx -y @freakynit/autobox
```

Or from source:

```bash
npm install
npm run build
node dist/index.js
```

Building from source also compiles the macOS clone helper using Apple's Command
Line Tools (`xcode-select --install`). The published package includes the helper.

The server speaks MCP on stdin/stdout. Diagnostic logs go to stderr so they never
interfere with the protocol.

## Configuration

Works with any MCP client. No authentication required. No environment variables
are required; one optional variable is supported:

| Variable | Default | Description |
|---|---|---|
| `AUTOBOX_STATE_DIR` | `~/Library/Application Support/autobox` | Record/lock directory for workspace IDs. Keep the same setting across restarts to reopen existing IDs. |

Do not confuse the two on-disk locations:

| What | Default | Overridden by |
|---|---|---|
| Workspace records + cross-process lock (`*.json`, `operation.lock`) | `~/Library/Application Support/autobox` (`AUTOBOX_STATE_DIR`) | `AUTOBOX_STATE_DIR` |
| Workspace file storage (working trees + private baselines) | `~/Library/Application Support/autobox-workspaces` | `storagePath` per `create` call |

opencode (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "autobox": {
      "type": "local",
      "command": ["npx", "-y", "@freakynit/autobox"],
      "enabled": true
    }
  }
}
```

Codex:

```sh
codex mcp add autobox -- npx -y @freakynit/autobox
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`),
Cursor (`~/.cursor/mcp.json`), Windsurf, Cline:

```json
{
  "mcpServers": {
    "autobox": {
      "command": "npx",
      "args": ["-y", "@freakynit/autobox"]
    }
  }
}
```

To run from a local checkout instead of npm:

```json
{
  "mcpServers": {
    "autobox": {
      "command": "node",
      "args": ["/path/to/autobox/dist/index.js"]
    }
  }
}
```

For reproducible behavior, pin a version in production
(`@freakynit/autobox@^0.1.0`) rather than floating on `latest`. Bump the pin when you
upgrade.

## Tools

### `execute_js`

Runs JavaScript in a brand-new V8 isolate (`isolated-vm`, the same primitive behind
Cloudflare Workers). The isolate contains standard JavaScript only — no `process`,
`require`, or other Node APIs. `fetch`/`net` exist only when `allowNetwork: true`
(host-mediated, http(s) only, bounded). Host filesystem access is limited to an
explicit bridge described below.

| Parameter | Default | Description |
|---|---|---|
| `code` | (required) | JS to run. A bare expression (`2+2`, trailing `;` ok) or statements with `return`. `await` is allowed. |
| `timeoutMs` | `800` | CPU wall-clock limit in ms (max 10000). Infinite loops are terminated. |
| `memoryMb` | `32` | Isolate heap limit in MB (8–512). Over-allocation terminates the isolate without affecting the server. |
| `allowNetwork` | `false` | Exposes host-mediated `fetch(url, opts)`, `net.fetch(url, opts)`, `net.fetchJson(url, opts)` for http(s). No network surface exists otherwise. |
| `mounts` | `[]` | Host directories `{ hostPath, sandboxPath, mode }` (`"ro"` or `"rw"`), or writable workspace references `{ workspaceId }`. Multiple mounts allowed. |
| `maxReadBytes` | `1000000` | Per-call cap on bytes readable through the file bridge (max 50000000). |
| `maxWriteBytes` | `1000000` | Per-call cap on bytes writable through the file bridge (max 50000000). |

Inside the sandbox:

- `console.log` / `console.error` are captured and returned as `logs`.
- `host.readFile(path)`, `host.writeFile(path, content)`, `host.listDir(path)` operate
  on sandbox paths (e.g. `/mnt/data/input.txt`). Paths outside the declared mounts,
  writes to `ro` mounts, `..` escapes, and symlinks resolving outside the mount
  root are rejected. Symlinks staying inside the mount are allowed.

Returns `{ ok, result, error, logs, durationMs, readBytes, writeBytes }`.

Error shapes:

- Timeout: `{ ok: false, error: "TimeoutError: execution exceeded <timeoutMs>ms" }`.
- Heap exhaustion: isolate is terminated; the error surfaces as a memory-limit
  failure and the server is unaffected.
- Mount/bridge misuse (unknown mount, `ro` write, symlink escape, quota
  exceeded): `{ ok: false, error: "..." }` with no partial write for the
  rejected operation.

### `exec_command`

Runs a host command (`argv` array) for anything that is not JavaScript — linters,
interpreters, file utilities. Always (on supported macOS) runs under `sandbox-exec`
(filesystem rules apply with or without network); `allowNetwork: false` (the default)
additionally denies network. On unsupported platforms the server falls back to plain
`bash` without seatbelt enforcement — Apple Silicon Mac is the only supported target.
The process group is killed after `timeoutMs`; memory is enforced via
an RSS watchdog (see Limitations — macOS cannot enforce `RLIMIT_AS`/`ulimit -v`).

Sandbox paths (`/mnt/...`) do not exist in the child FS — they are rewritten to host
paths in-process before spawn (including inside `bash -c` script text and
`--flag=/mnt/...` values), then enforced by seatbelt. `ro` mounts are explicitly
denied for writes even under `/tmp` (previous bypass fixed). Reads outside mounts are
denied for user-data prefixes (`/Users`, `/tmp`, `/var/folders`, `/etc`, …); writes are
allowed to `rw` mounts, the per-call scratch dir (`$TMPDIR`/`$HOME`), and `/tmp`
cache locations for tool compat. Shell startup files are never sourced
(`--noprofile --norc`, scrubbed env), so no `~/.bashrc` noise.

Child environment is minimal by design: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
`TMPDIR`/`HOME` point at the per-call scratch dir (deleted afterwards),
`BASH_ENV=/dev/null` and `ENV=/dev/null`, plus canonical TLS pins
(`OPENSSL_CONF`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE` →
`/private/etc/ssl/...`) so sandboxed TLS clients start under seatbelt.

| Parameter | Default | Description |
|---|---|---|
| `command` | (required) | Argument vector, e.g. `["ls", "-la", "/mnt/data"]`. Sandbox paths rewritten to host mounts. |
| `timeoutMs` | `1500` | Wall-clock limit in ms (max 30000). Kills the process group. |
| `memoryMb` | `256` | RSS watchdog cap in MB (16–2048; best effort; `ulimit -v` stays `unlimited` on macOS by design). |
| `allowNetwork` | `false` | `false` adds network deny to the seatbelt profile. Filesystem rules apply either way. |
| `mounts` | `[]` | Same shape as `execute_js`. Sandbox-path args rewritten; `ro` enforced, `rw` writable. |
| `cwd` | per-call scratch | Working directory (sandbox or host path, e.g. `/mnt/project`). Must already exist and be inside a declared mount or `/tmp`; sandbox paths are rewritten to host paths. |

Returns `{ stdout, stderr, exitCode, killed, durationMs }` (`stdout` truncated at
256KB, `stderr` at 64KB; `killed: true` on timeout or RSS-breach kill; `exitCode`
is `null` on spawn failure). `stderr` is prefixed with
`memory limit exceeded (… RSS watchdog)` when the watchdog fires.

### `copy_then_sync`

Copies a host directory into a persistent, writable workspace, then syncs edits
back to the host on demand. The phases are deliberately separate calls:

1. `create` — copy the source into a workspace (does **not** run code or sync).
2. Edit — mount the workspace in `execute_js` or `exec_command`.
3. `status` — preview exactly what would change on the host.
4. `sync` — apply the changes to the host.
5. `discard` — delete the workspace and abandon unsynced edits.

The host source stays unchanged until an explicit `sync`.

`hostPath`, `sandboxPath`, `storagePath`, `copyMode`, and `excludes` are fixed at
`create` time and cannot be changed by `status` / `sync` / `discard` — those calls
accept only `workspaceId` (passing creation fields is rejected).

| Parameter | Default | Description |
|---|---|---|
| `action` | required | `create`, `status`, `sync`, or `discard`. |
| `hostPath` | — | `create`: absolute existing source directory (symlinks resolved via `realpath`). |
| `sandboxPath` | — | `create`: absolute sandbox path, e.g. `/mnt/project`; cannot be `/`. Normalized with `posix.normalize`. |
| `workspaceId` | — | `status`, `sync`, `discard`: UUIDv4 ID returned by `create`. |
| `storagePath` | `~/Library/Application Support/autobox-workspaces` | `create`: absolute storage directory outside the source. Prefer an existing directory; if it does not exist its parent must already exist and not overlap the source (avoids parent-resolution ambiguity). For sources on external disks, place storage on the same volume or use `copyMode: "auto"`. Sync staging itself always happens on the host volume (`.autobox-sync-*` inside the source), so cross-volume storage only affects creation/cloning, not sync atomicity. |
| `copyMode` | `clone` | `clone` requires APFS copy-on-write (`clonefile`); fails with `EXDEV`/`ENOTSUP` cross-volume or off-APFS instead of silently copying. `auto` explicitly permits ordinary-copy fallback (`copyfile COPYFILE_ALL`) in those cases. |
| `excludes` | `[]` | `create`: exact normalized relative paths/subtrees, such as `node_modules` or `build`. No glob expansion, no `..`, no absolute paths, no implicit exclusions. |

#### Example workflow

**Create** the workspace. The response is
`{ ok, workspaceId, mount: { workspaceId }, sandboxPath, clonedFiles, copiedFiles }`:

```json
{
  "action": "create",
  "hostPath": "/Users/me/project",
  "sandboxPath": "/mnt/project",
  "excludes": ["node_modules", "dist"]
}
```

**Edit** it by passing the returned `workspaceId` as a mount reference — either
from JavaScript:

```json
{
  "code": "await host.writeFile('/mnt/project/hello.txt', 'hello from the workspace'); return host.listDir('/mnt/project');",
  "mounts": [{ "workspaceId": "<workspaceId from create>" }]
}
```

or from a shell command:

```json
{
  "command": ["/bin/bash", "--noprofile", "--norc", "-c", "printf 'updated\\n' > hello.txt"],
  "cwd": "/mnt/project",
  "mounts": [{ "workspaceId": "<workspaceId from create>" }]
}
```

Use relative paths with `cwd`, or quote sandbox paths inside shell scripts, since
the backing directory may contain spaces.

**Preview**, then **sync**, with two separate `copy_then_sync` calls:

```json
{ "action": "status", "workspaceId": "<workspaceId from create>" }
```

`status` returns `{ ok, workspaceId, sandboxPath, changes, conflicts }`, where
`changes` is `[{ path, action: "add" | "modify" | "replace" | "delete" }]`
(directory removals collapse descendants):

```json
{
  "ok": true,
  "changes": [{ "path": "hello.txt", "action": "modify" }],
  "conflicts": []
}
```

```json
{ "action": "sync", "workspaceId": "<workspaceId from create>" }
```

Successful `sync` returns
`{ ok, workspaceId, changes, applied, clonedFiles, copiedFiles }`.
Conflicted `sync` returns `{ ok: false, workspaceId, changes, conflicts, applied: [] }`
with nothing applied. Interrupted `sync` returns
`{ ok: false, error, applied, recovery }` — `applied` lists per-file successes
so you can inspect `status` and retry.

**Discard** to abandon the workspace:

```json
{ "action": "discard", "workspaceId": "<workspaceId from create>" }
```

Discard permanently deletes the workspace and its unsynced changes. It never
deletes or reverts the source, including changes from earlier successful syncs.

#### Sync semantics

- `status` returns a change list (`add`, `modify`, `replace`, `delete`) plus any
  conflicting paths.
- `sync` applies workspace additions, edits, permission changes, and deletions,
  preserving unrelated host edits. Renames are represented as deletion plus
  addition.
- **Conflicts return `ok: false` with no changes applied.** Restore the affected
  host path to the baseline, or make the workspace match the host, then retry.
- The workspace remains available after sync; only synchronized baseline paths
  are updated, so you can keep editing and sync again.
- Sync is atomic per replacement file, **not** a transaction across the whole tree.
  Metadata is rechecked before apply, and an I/O failure during apply can leave
  some changes synchronized. The response includes `applied` paths and retains
  the workspace for inspection/retry.
- Pause external writers to both the host and workspace during creation/sync. A
  directory copy is not a filesystem snapshot.

#### Storage and copies

- APFS clones share data blocks until either copy is modified. Creation clones the
  source into a private baseline and a writable working tree; it never hard-links
  to the source. File data initially needs no second full copy, but directory
  entries and metadata do consume space, and creation still visits every included
  file.
- Sync scans metadata, hashes candidate changes/conflicts as needed, and stages
  only changed files. Exclusions reduce traversal and metadata costs.
- Counts report source-to-baseline files at creation and staged host replacement
  files at sync — not physical disk usage or additional private baseline clones.
- Workspace records survive server restarts in the record directory
  (`~/Library/Application Support/autobox` by default; `AUTOBOX_STATE_DIR`
  overrides it — see Configuration). Keep the same setting to reopen existing IDs.
  This is separate from workspace file storage (`storagePath`, default
  `~/Library/Application Support/autobox-workspaces`).
- Storage, private baselines, and the record directory cannot be mounted through
  raw `hostPath` entries (rejected as overlapping management storage — use a
  `{ workspaceId }` mount instead).
- Workspace operations and execution calls are serialized via a cross-process OS
  lock. Another autobox process using the same record directory gets a busy error
  (`workspace lock: ... Another autobox operation may be busy; retry when it finishes.`)
  while an operation is running.
  The source directories of mounted workspaces are explicitly denied shell writes
  (added to the seatbelt `ro` deny list), including sources in `/tmp` — edit via
  the `{ workspaceId }` mount instead.
- A crash may leave private staging data (and a `.autobox-sync-*` host staging
  directory). Do not use these staging directories as project files. The native OS
  file lock is released automatically when the operation ends or the server
  crashes; a lock file remaining on disk does not mean a lock is still held.

#### Filesystem rules

- Symlinks are copied without following them. The JS bridge rejects escaping
  links; shell access uses seatbelt.
- New or modified links synced to the host must be relative, acyclic, and stay
  inside the workspace, including through other links. Their targets are also
  checked against the proposed host tree; targets through excluded paths are
  rejected because those paths are outside the tracked baseline.
- Removing or replacing a directory that contains excluded paths is rejected to
  protect excluded host data.
- Regular files, directories, and symlinks are supported; sockets, devices, and
  FIFOs are rejected.
- File clones preserve extended attributes and ACLs; directory handling preserves
  ordinary permission bits. Ownership, special permission bits, hard-link
  relationships, and directory extended attributes are not synchronized.

## Examples

Evaluate untrusted code with no filesystem and no network:

```json
{ "code": "JSON.parse('{\"a\":1}').a + 41" }
```

```json
{ "ok": true, "result": 42, "error": null, "logs": [], "durationMs": 0.91 }
```

Transform files using mounts — read-only input, read-write scratch:

```json
{
  "code": "const raw = await host.readFile(\"/mnt/in/data.json\");\nconst n = JSON.parse(raw).items.length;\nawait host.writeFile(\"/mnt/out/count.txt\", String(n));\nreturn n;",
  "mounts": [
    { "hostPath": "/tmp/job-input", "sandboxPath": "/mnt/in", "mode": "ro" },
    { "hostPath": "/tmp/job-output", "sandboxPath": "/mnt/out", "mode": "rw" }
  ]
}
```

Contain a runaway with explicit CPU and memory budgets:

```json
{ "code": "while (true) {}", "timeoutMs": 60, "memoryMb": 16 }
```

```json
{ "ok": false, "result": null, "error": "Error: Script execution timed out." }
```

List a mounted directory from a sandboxed shell:

```json
{
  "command": ["ls", "/mnt/data"],
  "allowNetwork": false,
  "mounts": [{ "hostPath": "/tmp/agent-data", "sandboxPath": "/mnt/data", "mode": "ro" }]
}
```

## Design

Firecracker microVMs require Linux KVM, which does not exist on macOS, so on Apple
Silicon the equivalent isolation is built from two OS-native primitives instead of
virtualization:

1. **V8 isolates** for code. Each `execute_js` call gets a fresh isolate with its own
   heap and no host references except the declared `host.*` bridge (canonicalized
   via `realpath`; symlink escapes rejected). There is nothing to escape to — Node
   APIs simply do not exist inside.
2. **Seatbelt (`sandbox-exec`)** for shell commands, denying network by default,
   denying reads outside mounts for user-data prefixes and writes outside `rw`
   mounts/scratch (with explicit `ro` deny last), plus process-group timeout kills
   and an RSS watchdog for memory.

The file bridge is synchronous by design: `isolated-vm` transfers values across the
isolate boundary by copy, so file contents (within quota) are copied rather than
shared. The optional network bridge shells to `curl --max-time` so the sandbox never
holds a socket.

## Performance

Measured on Apple Silicon (arm64, Darwin) over MCP stdio:

| Case | Result |
|---|---|
| `execute_js`, trivial expression (server-side) | p50 ~1ms, max ~1.4ms |
| `execute_js`, wall time incl. MCP framing | ~1.3ms |
| `while (true) {}` with 60ms budget | terminated on schedule |
| Heap bomb with 16MB budget | isolate terminated, server unaffected |
| `process` / `require` inside isolate | `undefined` (`fetch`/`net` only with `allowNetwork:true`) |
| `exec_command` (`echo` under seatbelt) | ~10ms, clean `stderr` |
| `exec_command` (`curl` with network denied) | blocked (DNS resolution fails) |

## Limitations

- The sub-5ms path is JavaScript only. Other languages go through `exec_command`
  and need their interpreter installed on the host.
- Seatbelt filesystem rules for shell commands are best effort on macOS; the V8
  isolate path is the strongly isolated one. There is no mount namespace on macOS:
  `/mnt/...` is rewritten to host paths in-process, then enforced by seatbelt.
  Read denial covers user-data prefixes (`/Users`, `/tmp`, `/var/folders`, `/etc`,
  …), not every host path (e.g. `/opt`, `/Volumes` remain readable). Writes are
  allowed to `rw` mounts, the per-call scratch dir, and `/tmp` cache locations for
  tool compat; `ro` mounts are explicitly denied last. One intentional carve-out:
  the public TLS store (`/etc/ssl`, `/private/etc/ssl` — same bytes on every Mac)
  is readable so sandboxed `curl`/TLS clients can start; child env pins
  `OPENSSL_CONF`/`SSL_CERT_FILE`/`CURL_CA_BUNDLE` to the canonical
  `/private/etc/ssl/...` spellings (seatbelt matches canonical paths, while
  libressl defaults use lexical `/etc/ssl/...`). Everything else under `/etc`
  (`passwd`, etc.) stays denied. Use `execute_js` for
  untrusted code; use `exec_command` for trusted-ish tooling.
- Memory for `exec_command` cannot use `ulimit -v`/`RLIMIT_AS` on macOS
  (`setrlimit` returns `EINVAL`; `ulimit -v` stays `unlimited` by OS design).
  Enforcement is via an RSS watchdog that SIGKILLs the process group on breach
  (best effort, ~50ms poll). `ulimit -v` reporting `unlimited` is expected and not
  a bug.
- `fetch`/`net.fetch`/`net.fetchJson` support http(s) only, bounded in time
  and response size (curl-mediated, no sockets in-sandbox).

## Development

```bash
npm install
npm run build     # tsc (typecheck + emit) then compile the native clone helper
node dist/index.js
```

`src/index.ts` contains execution and MCP tool definitions. `src/workspaces.ts`
manages persistent writable workspaces and conflict-aware sync; `src/clonefile.c`
provides batched native macOS cloning without silent ordinary-copy fallback.

## Troubleshooting

- `Native clone helper unavailable; run npm run build` → the `dist/autobox-clone`
  binary is missing. Run `npm run build` (requires Apple Command Line Tools:
  `xcode-select --install`). The published npm package already includes it.
- `clone ...: Cross-device link` / `EXDEV` on `create` → source and `storagePath`
  are on different volumes (e.g. external disk) or the FS is not APFS. Either
  point `storagePath` at an existing directory on the source's volume, or pass
  `"copyMode": "auto"` to explicitly allow ordinary copying.
- `Source changed during creation` / `Host changed while staging sync` → pause
  external writers (editors, watchers, git) on both host and workspace during
  `create`/`sync`, then retry. A directory copy is not a snapshot.
- `workspace lock: ... Another autobox operation may be busy` → another autobox
  call (possibly another server process sharing `AUTOBOX_STATE_DIR`) holds the
  operation lock. Wait and retry with the same `AUTOBOX_STATE_DIR`.
- Sandboxed `curl` fails on `openssl.cnf` / CA bundle → you are likely running an
  old build. Current builds re-allow `/private/etc/ssl` + `/etc/ssl` and pin
  `OPENSSL_CONF`/`SSL_CERT_FILE`/`CURL_CA_BUNDLE` to canonical paths.
- `ulimit -v` reports `unlimited` inside `exec_command` → expected on macOS
  (`setrlimit` returns `EINVAL` by OS design). Memory is enforced by the RSS
  watchdog, not `ulimit`.
- Leftover `.autobox-sync-*` dirs in the source or `stage-*` dirs in workspace
  storage after a crash → safe to delete once no autobox operation is running;
  never use them as project files.
- `cwd must be inside a mount, /tmp, or the per-call scratch dir` → `cwd` must
  already exist and be inside a declared mount (sandbox paths like `/mnt/project`
  are allowed and rewritten) or `/tmp`; otherwise omit it to use scratch.

## AI assistance disclosure

AI-assisted, not vibe-coded.

## License

MIT — see [LICENSE](LICENSE).
