#!/usr/bin/env node
/**
 * autobox — MCP (stdio only) execution sandbox.
 *
 * Target: M-series Mac (darwin arm64). No Intel/Windows/Linux support.
 * Strategy (honest): Firecracker needs Linux KVM and cannot run on macOS.
 * So this provides the Firecracker *intent* (strong, fast, per-call sandbox
 * with cpu/mem/net/disk + mounts) via:
 *   1. V8 isolates (isolated-vm) for code execution — true V8 isolate per call,
 *      <5ms typical on M-series. Network denied by default; fs only via
 *      scoped `host.*` bridge bound to explicit mounts (ro/rw).
 *   2. sandboxed shell via macOS `sandbox-exec` (seatbelt) for "other operations".
 *
 * MCP transport: stdio (stdin/stdout) ONLY. No SSE/HTTP/remote.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import ivm from "isolated-vm";
import { promises as fs, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, realpathSync, lstatSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { WorkspaceManager } from "./workspaces.js";

const workspaces = new WorkspaceManager();

const HostMountSchema = z.object({
  hostPath: z.string().describe("Absolute host directory to expose"),
  sandboxPath: z
    .string()
    .describe("Path seen inside sandbox, e.g. /mnt/data. Must start with /"),
  mode: z.enum(["ro", "rw"]).describe("ro = read-only, rw = read+write"),
});
const MountSchema = z.union([
  HostMountSchema,
  z.object({ workspaceId: z.string().uuid().describe("Writable workspace ID returned by copy_then_sync create") }).strict(),
]);

const CopyThenSyncSchema = {
  action: z.enum(["create", "status", "sync", "discard"]).describe("Separate operations: create a writable copy, preview changes, explicitly sync to host, or discard"),
  hostPath: z.string().optional().describe("create: absolute source directory; never edited until sync"),
  sandboxPath: z.string().optional().describe("create: sandbox mount path, e.g. /mnt/project"),
  workspaceId: z.string().uuid().optional().describe("status/sync/discard: ID returned by create"),
  storagePath: z.string().optional().describe("create: existing storage directory outside source, on the same volume for cloning"),
  copyMode: z.enum(["clone", "auto"]).default("clone").describe("clone requires APFS cloning; auto explicitly allows ordinary-copy fallback"),
  excludes: z.array(z.string()).default([]).describe("create: exact relative paths/subtrees to omit, e.g. node_modules. No glob patterns or implicit exclusions."),
};

const ExecuteJsSchema = {
  code: z.string().describe("JavaScript code to run. `return` a value or leave a bare expression like `2+2` (trailing `;` ok). `await` is allowed."),
  timeoutMs: z.number().int().min(1).max(10_000).default(800).describe("CPU wall-clock limit per call (ms)"),
  memoryMb: z.number().int().min(8).max(512).default(32).describe("V8 isolate memory limit (MB)"),
  allowNetwork: z.boolean().default(false).describe("If true, expose host-mediated fetch()/net.fetch()/net.fetchJson() for http(s). Default false (fetch/net undefined)."),
  mounts: z.array(MountSchema).default([]).describe("Host dirs to expose. Multiple allowed. Empty = no fs access. Symlinks escaping a mount are rejected."),
  maxReadBytes: z.number().int().min(0).max(50_000_000).default(1_000_000).describe("Max bytes readable via host.* per call"),
  maxWriteBytes: z.number().int().min(0).max(50_000_000).default(1_000_000).describe("Max bytes writable via host.* per call"),
};

const ExecSchema = {
  command: z.array(z.string()).min(1).describe("argv, e.g. [\"ls\",\"-la\",\"/mnt/data\"]. Sandbox paths (/mnt/...) are rewritten to host paths."),
  timeoutMs: z.number().int().min(1).max(30_000).default(1500).describe("Wall-clock limit (ms)"),
  memoryMb: z.number().int().min(16).max(2048).default(256).describe("RSS watchdog cap in MB (best effort; macOS cannot enforce RLIMIT_AS/RSS)"),
  allowNetwork: z.boolean().default(false).describe("If false (default), run under sandbox-exec with network denied. Filesystem rules apply either way."),
  mounts: z.array(MountSchema).default([]).describe("Mounts: sandboxPath args rewritten to hostPath; ro enforced, rw writable; reads outside mounts denied for user-data prefixes (best effort)"),
  cwd: z.string().optional().describe("Working directory: sandbox path (e.g. /mnt/project) or host path. Must already exist and be inside a declared mount or /tmp; sandbox paths are rewritten to host paths. Default: per-call scratch dir."),
};

type Mount = z.infer<typeof MountSchema>;
type HostMount = z.infer<typeof HostMountSchema>;

async function materializeMounts(mounts: Mount[]): Promise<HostMount[]> {
  const protections = await workspaces.protections();
  const sources = await Promise.all(mounts.filter((m) => "workspaceId" in m).map((m) => workspaces.source((m as { workspaceId: string }).workspaceId)));
  return Promise.all(mounts.map(async (m) => {
    if ("workspaceId" in m) return workspaces.mount(m.workspaceId);
    const real = await fs.realpath(m.hostPath);
    if (m.mode === "rw" && sources.some((p) => isInsideDir(real, p) || isInsideDir(p, real))) {
      throw new Error("A workspace and its original host directory cannot both be mounted writable in one call");
    }
    if (protections.some((p) => isInsideDir(real, p) || isInsideDir(p, real))) {
      throw new Error("Host mounts cannot overlap autobox management/workspace storage; use a workspaceId mount");
    }
    return m;
  }));
}

async function resolveMounts(mounts: HostMount[]) {
  const out: { hostReal: string; sandboxPath: string; mode: "ro" | "rw" }[] = [];
  for (const m of mounts) {
    if (!path.isAbsolute(m.hostPath)) throw new Error(`mount hostPath must be absolute: ${m.hostPath}`);
    if (!m.sandboxPath.startsWith("/")) throw new Error(`mount sandboxPath must start with /: ${m.sandboxPath}`);
    const st = await fs.stat(m.hostPath).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`mount hostPath not a directory: ${m.hostPath}`);
    const hostReal = await fs.realpath(m.hostPath);
    // normalize: strip trailing slash except root of sandbox path
    const sandboxPath = path.posix.normalize(m.sandboxPath);
    if (out.some((m) => m.sandboxPath === sandboxPath)) throw new Error(`duplicate mount sandboxPath: ${sandboxPath}`);
    out.push({ hostReal, sandboxPath, mode: m.mode });
  }
  // longest sandboxPath first so nested mounts match most-specific
  out.sort((a, b) => b.sandboxPath.length - a.sandboxPath.length);
  return out;
}

function mapSandboxToHost(
  sandboxFile: string,
  mounts: Awaited<ReturnType<typeof resolveMounts>>,
): { hostFile: string; hostReal: string; mode: "ro" | "rw" } {
  if (!sandboxFile.startsWith("/")) throw new Error(`sandbox path must be absolute: ${sandboxFile}`);
  const norm = path.posix.normalize(sandboxFile);
  for (const m of mounts) {
    if (norm === m.sandboxPath || norm.startsWith(m.sandboxPath + "/")) {
      const rel = path.posix.relative(m.sandboxPath, norm);
      // block .. escapes (relative normalizes them away, but double check)
      if (rel.startsWith("..")) continue;
      const hostFile = path.join(m.hostReal, rel);
      // containment: resolved join must stay inside hostReal
      const rel2 = path.relative(m.hostReal, hostFile);
      if (rel2.startsWith("..") || path.isAbsolute(rel2)) throw new Error("path escape blocked");
      return { hostFile, hostReal: m.hostReal, mode: m.mode };
    }
  }
  throw new Error(`path not inside any mount: ${sandboxFile} (mounts: ${mounts.map((m) => m.sandboxPath).join(", ") || "none"})`);
}

function assertInsideMount(hostReal: string, candidateReal: string): void {
  const rel = path.relative(hostReal, candidateReal);
  if (rel === "") return;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escape blocked (symlink)");
  }
}

/** Nearest lexically-existing ancestor (via lstat, does not follow final symlink target). */
function nearestExistingAncestorLex(p: string): string {
  let cur = p;
  for (;;) {
    try {
      lstatSync(cur);
      return cur;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

/** Resolve an existing sandbox-mapped path and require the canonical target to stay inside the mount. */
function resolveExistingInside(hostReal: string, hostFileLex: string, sandboxFile: string): string {
  let real: string;
  try {
    real = realpathSync(hostFileLex);
  } catch {
    throw new Error(`not found: ${sandboxFile}`);
  }
  assertInsideMount(hostReal, real);
  return real;
}

/** Compute the canonical parent dir for a (possibly non-existent) write target. Rejects parent-symlink escapes. */
function canonicalParentForWrite(hostReal: string, hostFileLex: string, sandboxFile: string): string {
  const dirLex = path.dirname(hostFileLex);
  const ancLex = nearestExistingAncestorLex(dirLex);
  let ancReal: string;
  try {
    ancReal = realpathSync(ancLex);
  } catch {
    throw new Error(`not found: ${sandboxFile}`);
  }
  assertInsideMount(hostReal, ancReal);
  const rel = path.relative(ancLex, dirLex);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escape blocked");
  const dirReal = rel === "" ? ancReal : path.join(ancReal, rel);
  // dirReal may not exist yet; lexical containment check against hostReal.
  const rel2 = path.relative(hostReal, dirReal);
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) throw new Error("path escape blocked");
  return dirReal;
}

// ---------------- V8 isolate execution ----------------
async function executeJs(opts: {
  code: string;
  timeoutMs: number;
  memoryMb: number;
  allowNetwork: boolean;
  mounts: Mount[];
  maxReadBytes: number;
  maxWriteBytes: number;
}) {
  const t0 = performance.now();
  const hostMounts = await materializeMounts(opts.mounts);
  const mounts = await resolveMounts(hostMounts);
  let readBytes = 0;
  let writeBytes = 0;

  const isolate = new ivm.Isolate({ memoryLimit: opts.memoryMb });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("global", jail.derefInto());

    const logs: string[] = [];
    // NOTE isolated-vm v6: host functions must be exposed via ivm.Callback
    // (Reference is opaque / not callable from inside). async:true => returns a promise.
    const logRef = new ivm.Callback((...args: unknown[]) => {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ");
      if (logs.join("\n").length + line.length < 64_000) logs.push(line);
    });
    await jail.set("__log", logRef);

    // ---- host.* fs bridge (scoped to mounts) ----
    // All SYNC callbacks: isolated-vm cannot transfer promises across the
    // boundary, so host I/O uses sync fs (fast for <=quota sizes) and errors
    // propagate synchronously into the isolate where user try/catch sees them.
    // Symlink policy: every access canonicalizes via realpath and requires the
    // final target to stay inside the mount root. Symlinks escaping the mount
    // (including via intermediate components) are rejected.
    const readRef = new ivm.Callback((sandboxFile: string) => {
      const sf = String(sandboxFile);
      const { hostFile, hostReal, mode } = mapSandboxToHost(sf, mounts);
      void mode;
      const real = resolveExistingInside(hostReal, hostFile, sf);
      let st: { size: number; isFile(): boolean };
      try {
        st = statSync(real);
      } catch {
        throw new Error(`not a file: ${sf}`);
      }
      if (!st.isFile()) throw new Error(`not a file: ${sf}`);
      if (st.size + readBytes > opts.maxReadBytes) throw new Error("read byte quota exceeded");
      const data = readFileSync(real, "utf8");
      readBytes += Buffer.byteLength(data);
      if (readBytes > opts.maxReadBytes) throw new Error("read byte quota exceeded");
      return data;
    });
    const writeRef = new ivm.Callback((sandboxFile: string, content: string) => {
      const sf = String(sandboxFile);
      const { hostFile, hostReal, mode } = mapSandboxToHost(sf, mounts);
      if (mode !== "rw") throw new Error(`write denied (ro mount): ${sf}`);
      const s = String(content);
      if (Buffer.byteLength(s) + writeBytes > opts.maxWriteBytes) throw new Error("write byte quota exceeded");
      // If the target already exists, it must canonicalize inside the mount
      // (rejects symlink-to-outside writes). If it does not exist, the parent
      // chain must canonicalize inside (rejects writes through escaping dirs).
      let targetReal: string;
      try {
        const lst = lstatSync(hostFile);
        if (lst.isSymbolicLink()) {
          targetReal = resolveExistingInside(hostReal, hostFile, sf);
          const tst = statSync(targetReal);
          if (tst.isDirectory()) throw new Error(`not a file: ${sf}`);
        } else if (lst.isDirectory()) {
          throw new Error(`not a file: ${sf}`);
        } else {
          // Regular existing file: still verify canonical location (defense in depth).
          targetReal = resolveExistingInside(hostReal, hostFile, sf);
        }
      } catch (e: unknown) {
        if (e instanceof Error && /path escape blocked/.test(e.message)) throw e;
        if (e instanceof Error && /^not a file/.test(e.message)) throw e;
        // ENOENT (or dangling symlink): resolve canonical parent instead.
        const dirReal = canonicalParentForWrite(hostReal, hostFile, sf);
        mkdirSync(dirReal, { recursive: true });
        // Re-check canonical parent after mkdir (mkdir is inside by construction).
        targetReal = path.join(dirReal, path.basename(hostFile));
        const rel3 = path.relative(hostReal, targetReal);
        if (rel3.startsWith("..") || path.isAbsolute(rel3)) throw new Error("path escape blocked (symlink)");
        writeFileSync(targetReal, s, "utf8");
        writeBytes += Buffer.byteLength(s);
        return writeBytes;
      }
      // Existing-file path: ensure parent is canonical-inside as well.
      const dirReal = canonicalParentForWrite(hostReal, hostFile, sf);
      void dirReal;
      writeFileSync(targetReal, s, "utf8");
      writeBytes += Buffer.byteLength(s);
      return writeBytes;
    });
    const listRef = new ivm.Callback((sandboxDir: string) => {
      const sd = String(sandboxDir);
      const { hostFile, hostReal } = mapSandboxToHost(sd, mounts);
      const real = resolveExistingInside(hostReal, hostFile, sd);
      let st: { isDirectory(): boolean };
      try {
        st = statSync(real);
      } catch {
        throw new Error(`not a directory: ${sd}`);
      }
      if (!st.isDirectory()) throw new Error(`not a directory: ${sd}`);
      return readdirSync(real);
    });
    await jail.set("__read", readRef);
    await jail.set("__write", writeRef);
    await jail.set("__list", listRef);

    // ---- optional network bridge (sync curl; bounded by --max-time) ----
    // Contract: when allowNetwork=true both `fetch` and `net.fetch`/`net.fetchJson`
    // exist (host-mediated, http(s) only, bounded). Otherwise none exist.
    if (opts.allowNetwork) {
      const fetchRef = new ivm.Callback((url: string, init?: { method?: string; body?: string }) => {
        const u = String(url);
        if (!/^https?:\/\//.test(u)) throw new Error("only http(s) allowed");
        const secs = Math.max(1, Math.min(8, Math.ceil(opts.timeoutMs / 1000)));
        const method = init?.method ? String(init.method).toUpperCase() : "GET";
        if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) throw new Error("unsupported method");
        const body = init?.body !== undefined ? String(init.body).slice(0, 200_000) : undefined;
        const args = ["-sS", "--max-time", String(secs), "-X", method, "-H", "Content-Type: application/json"];
        if (body !== undefined) {
          args.push("-d", body);
        }
        args.push(u);
        try {
          const out = execFileSync("curl", args, {
            timeout: opts.timeoutMs,
            maxBuffer: 1_000_000,
          });
          return JSON.stringify({ status: 200, body: out.toString("utf8").slice(0, 100_000) });
        } catch (e: unknown) {
          throw new Error(`fetch failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        }
      });
      await jail.set("__fetch", fetchRef);
    }

    // bootstrap: console + host object, no require/process unless bridged
    const bootstrap = `
      console = { log: (...a) => __log(...a.map(x => typeof x === 'string' ? x : JSON.stringify(x))), error: (...a) => __log(...a.map(x => typeof x === 'string' ? x : JSON.stringify(x))) };
      host = {
        readFile: (p) => __read(p),
        writeFile: (p, c) => __write(p, String(c)),
        listDir: (p) => __list(p),
      };
      ${
        opts.allowNetwork
          ? `__normInit = (o) => {
               if (!o) return undefined;
               let body = o.body;
               if (body !== undefined && typeof body !== 'string') { try { body = JSON.stringify(body); } catch (e) { body = String(body); } }
               return { method: o.method, body };
             };
             net = {
               fetch: async (u, o) => {
                 const r = JSON.parse(await __fetch(String(u), __normInit(o)));
                 const body = r.body;
                 return { ok: true, status: r.status ?? 200, text: async () => body, json: async () => JSON.parse(body) };
               },
               fetchJson: async (u, o) => JSON.parse(JSON.parse(await __fetch(String(u), __normInit(o))).body),
             };
             fetch = net.fetch;`
          : `net = null; fetch = undefined;`
      }
    `;
    await context.eval(bootstrap, { timeout: opts.timeoutMs });

    // run user code inside an async fn (allows `await` + `return`).
    // Attempt A treats code as an expression: `return (code)` — so bare
    // `2+2` yields 4. If that fails to compile (multi-statement code),
    // attempt B runs it as a body. Completion is ferried out via __finish
    // (JSON string) because script.run() cannot await isolate promises.
    let finishResolve!: (v: { json: unknown; err: unknown }) => void;
    const done = new Promise<{ json: unknown; err: unknown }>((res) => (finishResolve = res));
    const finishRef = new ivm.Callback((json: unknown, err: unknown) => {
      finishResolve({ json, err });
    });
    await jail.set("__finish", finishRef);

    const code = opts.code;
    // A trailing ";" turns `return (expr;)` into a SyntaxError, so a bare
    // expression with a trailing semicolon would fall through to body mode and
    // return null. Strip trailing semicolons for the expression attempt only.
    const exprCode = code.trim().replace(/;+\s*$/, "");
    const mkSrc = (body: string) => `
      __p = (async () => { ${body} })();
      __p.then(
        (v) => { let j; try { j = JSON.stringify(v); } catch (e) { j = JSON.stringify(String(v)); } __finish(j === undefined ? null : j, null); },
        (e) => __finish(null, String((e && e.stack) || e))
      );
    `;
    let compiled = false;
    let compileError: string | null = null;
    for (const body of [`return (\n${exprCode}\n)`, `\n${code}\n`]) {
      try {
        const s = await isolate.compileScript(mkSrc(body));
        await s.run(context, { timeout: opts.timeoutMs });
        compiled = true;
        break;
      } catch (e: unknown) {
        let msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        if (/already disposed/i.test(msg)) msg = "MemoryError: isolate exceeded memory limit and was terminated";
        // SyntaxError => code isn't an expression, retry as body. Anything
        // else at run stage is a real failure, stop.
        if (/SyntaxError|Unexpected token/i.test(msg)) {
          compileError = msg;
          continue;
        }
        compileError = msg;
        break;
      }
    }

    let value: unknown = undefined;
    let error: string | null = compileError && !compiled ? compileError : null;
    if (compiled) {
      const timeoutErr = `TimeoutError: execution exceeded ${opts.timeoutMs}ms`;
      const winner = await Promise.race([
        done,
        new Promise<{ json: unknown; err: unknown }>((_, rej) =>
          setTimeout(() => rej(new Error(timeoutErr)), opts.timeoutMs + 25),
        ),
      ]).catch((e: unknown) => ({ timeout: true as const, msg: e instanceof Error ? e.message : String(e) }));
      if ("timeout" in (winner as object)) {
        error = (winner as { msg: string }).msg;
      } else {
        const { json, err } = winner as { json: string | null; err: string | null };
        if (err) {
          error = String(err).split("\n")[0];
        } else {
          try {
            value = json == null ? null : JSON.parse(json);
          } catch {
            value = json;
          }
        }
      }
    }

    const durationMs = performance.now() - t0;
    return { value: error ? null : (value as unknown), error, logs, durationMs, readBytes, writeBytes };
  } finally {
    try {
      isolate.dispose();
    } catch {
      /* already terminated (e.g. OOM) — nothing to do */
    }
  }
}

// ---------------- sandboxed shell (macOS seatbelt) ----------------
// Seatbelt model (M-series macOS, no mount namespace):
// - Sandbox paths (/mnt/...) do NOT exist in the child FS. They are rewritten
//   to host paths in-process (argv + cwd) before spawn.
// - Kernel enforcement is via seatbelt allow/deny + clean env + no-rc bash.
// - Reads: (allow default) for system compat, then deny user-data prefixes and
//   re-allow only mounts + per-call scratch + cwd. This demonstrably blocks
//   /etc/passwd, sibling files under /tmp, and host paths outside mounts for
//   the covered prefixes (best effort — see README Limitations).
// - Writes: deny (subpath "/") then allow tmp/scratch/rw, then explicitly
//   deny `ro` mounts LAST so an `ro` mount under /tmp is NOT writable
//   (previous bypass fixed). Broad /tmp write allow exists for tool-cache
//   compat (xcrun/python); reads stay restricted, so outside tmp files cannot
//   be exfiltrated.
// - System TLS (unconditional): libressl/openssl reads its config + CA bundle
//   at startup, so sandboxed `curl` (even plain-http) fails without it.
//   The public cert store is explicitly re-allowed; everything else under
//   /etc stays denied (/etc/passwd etc.). Tools are also pointed at the
//   canonical /private/... spellings via env (seatbelt matches canonical).
function seatbeltProfile(opts: {
  allowNetwork: boolean;
  rwReals: string[];
  readReals: string[];
  roReals: string[];
  protectedReals: string[];
}): string {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const q = (s: string) => JSON.stringify(s);
  const rwRules = uniq(opts.rwReals).map((p) => `(allow file-write* file-read* (subpath ${q(p)}))`).join("\n");
  const readRules = uniq(opts.readReals).map((p) => `(allow file-read* (subpath ${q(p)}))`).join("\n");
  const roDeny = uniq(opts.roReals)
    .map((p) => `(deny file-write* (subpath ${q(p)}))`)
    .join("\n");
  const protectedDeny = uniq(opts.protectedReals)
    .map((p) => `(deny file-read* file-write* (subpath ${q(p)}))`).join("\n");
  // User-data / sensitive prefixes denied for reads (re-allowed per mount/scratch below).
  const readDenyPrefixes = [
    "/Users",
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    "/etc",
    "/private/etc",
    "/var/root",
    "/private/var/root",
  ];
  const readDeny = `(deny file-read* ${readDenyPrefixes.map((p) => `(subpath ${q(p)})`).join(" ")})`;
  // Public system TLS store (same bytes on every Mac; NOT a secret). Required
  // for any libressl/openssl client startup. Money quote: without this,
  // sandboxed `curl` dies with "fopen('/private/etc/ssl/openssl.cnf','rb')"
  // even with allowNetwork:true (verified). Narrow: only the ssl subtree.
  const tlsAllow = `(allow file-read* (subpath "/private/etc/ssl") (subpath "/etc/ssl"))`;
  return `(version 1)
(allow default)
${opts.allowNetwork ? "" : "(deny network* (with no-log))"}
${readDeny}
${protectedDeny}
${tlsAllow}
${readRules}
(deny file-write* (subpath "/"))
(allow file-write* (subpath "/dev") (literal "/dev/null") (literal "/dev/dtracehelper") (subpath "/tmp") (subpath "/private/tmp") (subpath "/var/folders") (subpath "/private/var/folders"))
${rwRules}
${roDeny}
`;
}

function isInsideDir(childReal: string, parentReal: string): boolean {
  if (childReal === parentReal) return true;
  return childReal.startsWith(parentReal + path.sep);
}

/** Boundary-aware path replacement: replaces `from` with `to` only when `from`
 * appears as a full path component (preceded by start or delimiter, followed
 * by /, end, or delimiter). Avoids double-rewriting `/private/var/...` via
 * lexical `/var/...` substring. */
function replacePathOccurrences(haystack: string, from: string, to: string): string {
  if (!from || haystack.indexOf(from) < 0) return haystack;
  let out = "";
  let i = 0;
  for (;;) {
    const j = haystack.indexOf(from, i);
    if (j < 0) {
      out += haystack.slice(i);
      break;
    }
    const prev = j === 0 ? "" : haystack[j - 1];
    const next = j + from.length >= haystack.length ? "" : haystack[j + from.length];
    const prevOk = j === 0 || /[\s"'=:/]/.test(prev);
    const nextOk = next === "" || /[/\s"' ;|&<>()$`\\]/.test(next);
    if (prevOk && nextOk) {
      out += haystack.slice(i, j) + to;
    } else {
      out += haystack.slice(i, j + from.length);
    }
    i = j + from.length;
  }
  return out;
}

/** Rewrite argv/cwd strings from sandboxPath to hostReal.
 * Handles prefix args, `--flag=/mnt/...` suffixes, and embedded occurrences
 * inside `bash -c` script text (boundary-aware substring replace).
 * Longest sandboxPath first (mounts already sorted). */
function rewriteSandboxPathToHost(
  s: string,
  mounts: { hostReal: string; sandboxPath: string }[],
): string {
  let out = s;
  for (const m of mounts) {
    if (m.sandboxPath === "/") continue;
    out = replacePathOccurrences(out, m.sandboxPath, m.hostReal);
  }
  // Root sandbox mount ("/") maps absolute paths lexically — only when the
  // whole arg is an absolute path to avoid rewriting every "/".
  for (const m of mounts) {
    if (m.sandboxPath !== "/") continue;
    if (out.startsWith("/") && !out.startsWith(m.hostReal)) {
      const rel = path.posix.relative("/", path.posix.normalize(out));
      if (!rel.startsWith("..") && !rel.startsWith("/")) {
        // Only rewrite when out looks like a single path (no spaces/semicolons).
        if (!/[\s;|&<>$`'"]/.test(out)) out = path.join(m.hostReal, rel);
      }
    }
  }
  return out;
}

/** Canonicalize argv occurrences of a mount's lexical hostPath to hostReal.
 * Seatbelt matches canonical paths; accessing via /tmp when real is
 * /private/tmp can otherwise bypass allows. Boundary-aware replace. */
function canonicalizeHostPathsInArg(
  s: string,
  mounts: { hostReal: string }[],
  lexicals: string[],
): string {
  let out = s;
  for (let i = 0; i < mounts.length; i++) {
    const lex = lexicals[i];
    const real = mounts[i].hostReal;
    if (!lex || lex === real) continue;
    out = replacePathOccurrences(out, lex, real);
  }
  return out;
}

async function execCommand(opts: {
  command: string[];
  timeoutMs: number;
  memoryMb: number;
  allowNetwork: boolean;
  mounts: Mount[];
  cwd?: string;
}) {
  const t0 = performance.now();
  const hostMounts = await materializeMounts(opts.mounts);
  const mounts = await resolveMounts(hostMounts);
  const isMac = os.platform() === "darwin";

  // Per-call scratch dir: default cwd + TMPDIR/HOME. Always allowed read/write.
  const scratchLex = await fs.mkdtemp(path.join(os.tmpdir(), "autobox-exec-"));
  const scratchReal = await fs.realpath(scratchLex).catch(() => scratchLex);
  const tmpReal = await fs.realpath(os.tmpdir()).catch(() => os.tmpdir());

  // Rewrite sandbox paths -> host paths in argv (so /mnt/... works, including
  // embedded occurrences inside `bash -c` script text), then canonicalize
  // lexical host spellings (/tmp vs /private/tmp) to canonical reals so
  // seatbelt allow/deny matching is deterministic.
  const lexicals = mounts.map((m) => {
    try {
      return path.normalize(hostMounts.find((h) => path.posix.normalize(h.sandboxPath) === m.sandboxPath)!.hostPath);
    } catch {
      return m.hostReal;
    }
  });
  const argv = opts.command.map((a) => {
    const s1 = rewriteSandboxPathToHost(String(a), mounts);
    return canonicalizeHostPathsInArg(s1, mounts, lexicals);
  });

  // Resolve + validate cwd (with sandbox-path rewriting). Canonical comparisons
  // handle /var <-> /private/var and /tmp <-> /private/tmp symlinks.
  let cwdLex = opts.cwd ? rewriteSandboxPathToHost(String(opts.cwd), mounts) : scratchReal;
  const cwdReal = await fs.realpath(cwdLex).catch(() => null);
  if (!cwdReal) {
    await fs.rm(scratchReal, { recursive: true, force: true }).catch(() => {});
    throw new Error(`cwd does not exist: ${opts.cwd}`);
  }
  const insideMount = mounts.some((m) => isInsideDir(cwdReal, m.hostReal));
  const inScratch = isInsideDir(cwdReal, scratchReal);
  const inTmp =
    isInsideDir(cwdReal, tmpReal) ||
    isInsideDir(cwdReal, "/tmp") ||
    isInsideDir(cwdReal, "/private/tmp") ||
    cwdReal === tmpReal;
  if (!insideMount && !inScratch && !inTmp) {
    await fs.rm(scratchReal, { recursive: true, force: true }).catch(() => {});
    throw new Error("cwd must be inside a mount, /tmp, or the per-call scratch dir");
  }
  const cwd = cwdReal;

  // Build seatbelt allow lists (canonical + lexical variants for symlink prefixes).
  const rwReals: string[] = [scratchReal];
  const readReals: string[] = [scratchReal, cwdReal];
  const roReals: string[] = [];
  for (const m of opts.mounts) if ("workspaceId" in m) roReals.push(await workspaces.source(m.workspaceId));
  for (const m of mounts) {
    readReals.push(m.hostReal);
    if (m.mode === "rw") rwReals.push(m.hostReal);
    else roReals.push(m.hostReal);
  }
  // Also allow the original lexical hostPath when it differs from realpath
  // (e.g. /var/... vs /private/var/...), so both spellings enforce identically.
  for (const m of hostMounts) {
    try {
      const lex = path.normalize(m.hostPath);
      if (!rwReals.includes(lex) && !readReals.includes(lex)) {
        readReals.push(lex);
        if (m.mode === "rw") rwReals.push(lex);
        else roReals.push(lex);
      }
    } catch {
      /* ignore */
    }
  }

  // No ulimit wrapper: RLIMIT_AS/RSS/DATA cannot be set on macOS (EINVAL) and
  // `ulimit -v` is a silent no-op. Memory is enforced below via an RSS watchdog
  // (best effort — see README). Use a clean bash that never sources rc files.
  const shCmd = `exec "$@"`;
  let finalArgv: string[];
  let profilePath: string | null = null;
  if (isMac) {
    profilePath = path.join(os.tmpdir(), `sb-${process.pid}-${Date.now()}.sb`);
    await fs.writeFile(
      profilePath,
      seatbeltProfile({ allowNetwork: opts.allowNetwork, rwReals, readReals, roReals, protectedReals: await workspaces.protections() }),
      "utf8",
    );
    // NOTE: sandbox-exec -f <file> (not -p, which takes a named profile).
    // --noprofile --norc + scrubbed env avoids ~/.bashrc noise (/.cargo/env).
    finalArgv = [
      "/usr/bin/sandbox-exec",
      "-f",
      profilePath,
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      shCmd,
      "--",
      ...argv,
    ];
  } else {
    finalArgv = ["/bin/bash", "--noprofile", "--norc", "-c", shCmd, "--", ...argv];
  }

  return await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    killed: boolean;
    durationMs: number;
  }>((resolve) => {
    const child = spawn(finalArgv[0], finalArgv.slice(1), {
      cwd,
      detached: true,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: scratchReal,
        HOME: scratchReal,
        BASH_ENV: "/dev/null",
        ENV: "/dev/null",
        // Point TLS clients at canonical paths: seatbelt matches canonical
        // (/private/...) spellings, while curl/libressl defaults use lexical
        // /etc/ssl/... which seatbelt won't match to an allow rule (verified:
        // without these, sandboxed curl dies on openssl.cnf even when network
        // is allowed). Values are the stock system store, same on every Mac.
        OPENSSL_CONF: "/private/etc/ssl/openssl.cnf",
        SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
        SSL_CERT_DIR: "/private/etc/ssl/certs",
        CURL_CA_BUNDLE: "/private/etc/ssl/cert.pem",
      },
    });
    const killTree = (sig: NodeJS.Signals = "SIGKILL") => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        /* group kill failed — fall back to single */
      }
      try {
        child.kill(sig);
      } catch {
        /* already exited */
      }
    };
    let stdout = "";
    let stderr = "";
    let killed = false;
    let memoryExceeded = false;
    const memLimitKb = opts.memoryMb * 1024;
    const timer = setTimeout(() => {
      killed = true;
      killTree("SIGKILL");
    }, opts.timeoutMs);
    // RSS watchdog (async ps so the event loop stays responsive for the
    // timeout killer): macOS cannot enforce RLIMIT_AS/RSS/DATA (setrlimit
    // returns EINVAL), so poll and SIGKILL the process GROUP on breach.
    // Best effort — covers main pid + children via group kill.
    let memInFlight = false;
    const memTimer = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null || memInFlight) return;
      if (child.pid === undefined) return;
      memInFlight = true;
      execFile("ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 1000 }, (_err, out) => {
        memInFlight = false;
        try {
          const rssKb = parseInt(String(out).trim().split(/\s+/)[0] ?? "", 10);
          if (Number.isFinite(rssKb) && rssKb > memLimitKb) {
            memoryExceeded = true;
            killed = true;
            killTree("SIGKILL");
          }
        } catch {
          /* ignore */
        }
      });
    }, 50);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(memTimer);
      if (profilePath) fs.unlink(profilePath).catch(() => {});
      fs.rm(scratchReal, { recursive: true, force: true }).catch(() => {});
    };
    child.stdout.on("data", (d) => {
      if (stdout.length < 256_000) stdout += d.toString("utf8").slice(0, 256_000 - stdout.length);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 64_000) stderr += d.toString("utf8").slice(0, 64_000 - stderr.length);
    });
    child.on("error", (e) => {
      killTree();
      cleanup();
      resolve({
        stdout,
        stderr: (memoryExceeded ? `memory limit exceeded (${opts.memoryMb}MB RSS watchdog)\n` : "") + stderr + String(e),
        exitCode: null,
        killed,
        durationMs: performance.now() - t0,
      });
    });
    child.on("close", (code) => {
      killTree();
      cleanup();
      resolve({
        stdout,
        stderr: (memoryExceeded ? `memory limit exceeded (${opts.memoryMb}MB RSS watchdog)\n` : "") + stderr,
        exitCode: code,
        killed,
        durationMs: performance.now() - t0,
      });
    });
  });
}

// ---------------- MCP server (stdio only) ----------------
const server = new McpServer({ name: "autobox", version: "0.1.0" });

server.tool(
  "execute_js",
  "Run JavaScript in a fresh V8 isolate (strong isolation, M-series <5ms). No network unless allowNetwork=true (then fetch/net.fetch/net.fetchJson exist). Filesystem only via host.* scoped to mounts; symlinks escaping mounts rejected.",
  ExecuteJsSchema,
  async ({ code, timeoutMs, memoryMb, allowNetwork, mounts, maxReadBytes, maxWriteBytes }) => {
    try {
      const r = await workspaces.exclusive(() => executeJs({ code, timeoutMs, memoryMb, allowNetwork, mounts, maxReadBytes, maxWriteBytes }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ok: !r.error, result: r.value ?? null, error: r.error, logs: r.logs, durationMs: +r.durationMs.toFixed(2), readBytes: r.readBytes, writeBytes: r.writeBytes },
              null,
              2,
            ),
          },
        ],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }], isError: true };
    }
  },
);

server.tool(
  "exec_command",
  "Run a host command under macOS seatbelt (best-effort sandbox). Network denied when allowNetwork=false. Sandbox paths (/mnt/...) rewritten to host mounts; ro enforced, rw + per-call scratch writable; reads outside mounts denied for user-data prefixes. Memory via RSS watchdog (macOS cannot enforce RLIMIT). Prefer execute_js for strong isolation.",
  ExecSchema,
  async ({ command, timeoutMs, memoryMb, allowNetwork, mounts, cwd }) => {
    try {
      const r = await workspaces.exclusive(() => execCommand({ command, timeoutMs, memoryMb, allowNetwork, mounts, cwd }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...r, durationMs: +r.durationMs.toFixed(2) }, null, 2) }],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }], isError: true };
    }
  },
);

server.tool(
  "copy_then_sync",
  "Create a persistent, isolated writable directory using APFS copy-on-write clones. Edit it separately using workspaceId mounts in execute_js/exec_command. status previews changes/conflicts; sync explicitly applies changes to the host; discard deletes only the workspace. Pause external host writers during create/sync. No automatic sync or overwrite of conflicting host changes.",
  CopyThenSyncSchema,
  async (opts) => {
    try {
      const r = await workspaces.exclusive(async () => {
        if (opts.action === "create") {
          if (!opts.hostPath || !opts.sandboxPath) throw new Error("create requires hostPath and sandboxPath");
          if (opts.workspaceId) throw new Error("create does not accept workspaceId");
          return workspaces.create({ ...opts, hostPath: opts.hostPath, sandboxPath: opts.sandboxPath });
        }
        if (!opts.workspaceId) throw new Error(`${opts.action} requires workspaceId`);
        if (opts.hostPath || opts.sandboxPath || opts.storagePath || opts.excludes.length) throw new Error("Source, mount path, storage, and excludes are fixed at creation");
        return workspaces[opts.action](opts.workspaceId);
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }], ...(!r.ok ? { isError: true } : {}) };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }], isError: true };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport(); // stdin/stdout only — no remote/SSE/HTTP
  await server.connect(transport);
  console.error("[autobox] listening on stdio (darwin/arm64)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
