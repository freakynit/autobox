import { promises as fs, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

const EntrySchema = z.object({
  kind: z.enum(["file", "directory", "symlink"]),
  mode: z.number(), size: z.string(), mtime: z.string(), ctime: z.string(),
  ino: z.string(), dev: z.string(), target: z.string().optional(),
});
type Entry = z.infer<typeof EntrySchema>;
type Tree = Map<string, Entry>;
const RecordSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), source: z.string(),
  container: z.string(), baseline: z.string(), sandboxPath: z.string(),
  copyMode: z.enum(["clone", "auto"]), excludes: z.array(z.string()),
  stateFile: z.string(),
});
const StateSchema = z.object({
  sourceState: z.array(z.tuple([z.string(), EntrySchema])),
  workState: z.array(z.tuple([z.string(), EntrySchema])),
});
type Workspace = z.infer<typeof RecordSchema> & z.infer<typeof StateSchema>;
type Change = { path: string; action: "add" | "delete" | "modify" | "replace" };

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function overlaps(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }
function excluded(p: string, excludes: string[]): boolean {
  return excludes.some((e) => p === e || p.startsWith(e + "/"));
}
function safeRelative(p: string): boolean {
  return p.length > 0 && !p.includes("\0") && !path.isAbsolute(p) &&
    path.posix.normalize(p) === p && p !== "." && !p.split("/").includes("..");
}
function errorCode(e: unknown): string | undefined { return (e as NodeJS.ErrnoException)?.code; }
const nativeHelper = fileURLToPath(new URL("../dist/autobox-clone", import.meta.url));

async function acquireLock(lock: string): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const child = spawn(nativeHelper, ["lock", lock], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", ready = false;
    const closed = new Promise<void>((done) => child.on("close", () => done()));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => { err = (err + d.toString()).slice(0, 8000); });
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (!ready && out.includes("locked\n")) {
        ready = true;
        resolve(async () => { child.stdin.end(); await closed; });
      }
    });
    child.on("close", () => {
      if (!ready) reject(new Error(`${err.trim() || "Native workspace lock helper unavailable; run npm run build"}. Another autobox operation may be busy; retry when it finishes.`));
    });
  });
}

async function scan(root: string, excludes: string[]): Promise<Tree> {
  const tree: Tree = new Map();
  async function visit(rel: string) {
    for (const name of await fs.readdir(path.join(root, rel))) {
      const p = rel ? `${rel}/${name}` : name;
      if (excluded(p, excludes)) continue;
      const st = await fs.lstat(path.join(root, p), { bigint: true });
      const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : null;
      if (!kind) throw new Error(`Unsupported special file: ${p}`);
      tree.set(p, {
        kind, mode: Number(st.mode & 0o777n), size: String(st.size),
        mtime: String(st.mtimeNs), ctime: String(st.ctimeNs), ino: String(st.ino), dev: String(st.dev),
        ...(kind === "symlink" ? { target: await fs.readlink(path.join(root, p)) } : {}),
      });
      if (kind === "directory") await visit(p);
    }
  }
  await visit("");
  return tree;
}

async function digest(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
function identicalStat(a?: Entry, b?: Entry): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}
function sameTree(a: Tree, b: Tree): boolean {
  return a.size === b.size && [...a].every(([p, e]) => identicalStat(e, b.get(p)));
}
function safeLink(p: string, target: string, tree: Tree, excludes: string[]): boolean {
  if (path.posix.isAbsolute(target)) return false;
  // Do not normalize away `link/..` before resolving the link itself.
  let pending = [...path.posix.dirname(p).split("/"), ...target.split("/")];
  let resolved: string[] = [], links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (!resolved.length) return false;
      resolved.pop();
      continue;
    }
    const candidate = [...resolved, part].join("/");
    if (excluded(candidate, excludes)) return false;
    const e = tree.get(candidate);
    if (e?.kind === "symlink") {
      if (++links > 40 || path.posix.isAbsolute(e.target!)) return false;
      pending = [...e.target!.split("/"), ...pending];
    } else resolved.push(part);
  }
  return true;
}
async function equal(a: Entry | undefined, b: Entry | undefined, aPath: string, bPath: string): Promise<boolean> {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "symlink") return a.target === b.target;
  if (a.mode !== b.mode) return false;
  if (a.kind === "directory") return true;
  if (a.size !== b.size) return false;
  return (await digest(aPath)) === (await digest(bPath));
}

/** One helper process per batch, rather than a process per file. */
async function copyFiles(pairs: [string, string][], mode: "clone" | "auto") {
  if (!pairs.length) return { clonedFiles: 0, copiedFiles: 0 };
  return await new Promise<{ clonedFiles: number; copiedFiles: number }>((resolve, reject) => {
    const child = spawn(nativeHelper, [mode], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err = (err + d.toString()).slice(0, 8000); });
    child.on("error", reject);
    child.stdin.on("error", () => { /* close reports helper failure */ });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${err.trim() || "Native clone helper unavailable; run npm run build"}. copyMode=auto explicitly permits ordinary copying.`));
      } else {
        const counts = out.trim().split(" ").map(Number);
        resolve({ clonedFiles: counts[0], copiedFiles: counts[1] });
      }
    });
    child.stdin.end(pairs.flat().join("\0") + "\0");
  });
}

async function copyTree(source: string, destination: string, tree: Tree, mode: "clone" | "auto") {
  await fs.mkdir(destination, { mode: 0o700 });
  const pairs: [string, string][] = [];
  for (const [p, e] of tree) {
    const dst = path.join(destination, p);
    if (e.kind === "directory") await fs.mkdir(dst, { mode: 0o700 });
    else if (e.kind === "symlink") await fs.symlink(e.target!, dst);
    else pairs.push([path.join(source, p), dst]);
  }
  const counts = await copyFiles(pairs, mode);
  // Apply directory modes only after filling them, including read-only directories.
  for (const [p, e] of [...tree].reverse()) {
    if (e.kind === "directory") await fs.chmod(path.join(destination, p), e.mode);
  }
  return counts;
}

export class WorkspaceManager {
  readonly stateRoot = path.resolve(process.env.AUTOBOX_STATE_DIR || path.join(os.homedir(), "Library", "Application Support", "autobox"));
  private queue: Promise<unknown> = Promise.resolve();

  /** Execution and lifecycle calls share a lock, including across server processes. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await fs.mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
      const release = await acquireLock(path.join(this.stateRoot, "operation.lock"));
      try {
        return await fn();
      } finally {
        await release();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private recordPath(id: string) {
    z.string().uuid().parse(id);
    return path.join(this.stateRoot, `${id}.json`);
  }
  private async save(w: Workspace) {
    const target = this.recordPath(w.id), temp = `${target}.${randomUUID()}.tmp`;
    const previous = w.stateFile;
    w.stateFile = `${w.id}.state-${randomUUID()}.json`;
    const { sourceState, workState, ...record } = w;
    await fs.writeFile(path.join(this.stateRoot, w.stateFile), JSON.stringify({ sourceState, workState }), { mode: 0o600, flag: "wx" });
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await fs.rename(temp, target);
    if (previous) await fs.unlink(path.join(this.stateRoot, previous)).catch(() => { /* harmless orphan after a successful commit */ });
  }
  private async header(id: string) {
    const w = RecordSchema.parse(JSON.parse(await fs.readFile(this.recordPath(id), "utf8")));
    if (w.id !== id || !path.isAbsolute(w.source) || !path.isAbsolute(w.container) ||
        path.basename(w.container) !== `autobox-workspace-${id}` ||
        !/^baseline-[\da-f-]+$/.test(w.baseline) ||
        !w.stateFile.startsWith(`${id}.state-`) || !/^[\da-f-]+\.state-[\da-f-]+\.json$/.test(w.stateFile) ||
        w.excludes.some((p) => !safeRelative(p))) {
      throw new Error("Invalid workspace record");
    }
    return w;
  }
  private async load(id: string): Promise<Workspace> {
    const record = await this.header(id);
    const state = StateSchema.parse(JSON.parse(await fs.readFile(path.join(this.stateRoot, record.stateFile), "utf8")));
    if ([...state.sourceState, ...state.workState].some(([p]) => !safeRelative(p))) throw new Error("Invalid workspace state");
    const w = { ...record, ...state };
    await this.assertRoot(w.container);
    await this.assertRoot(path.join(w.container, "work"));
    await this.assertRoot(path.join(w.container, w.baseline));
    return w;
  }
  private async assertRoot(root: string) {
    const st = await fs.lstat(root);
    if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(root) !== root) {
      throw new Error(`Workspace directory was moved or replaced: ${root}`);
    }
  }
  async mount(id: string) {
    const w = await this.header(id);
    await this.assertRoot(w.container);
    await this.assertRoot(path.join(w.container, "work"));
    return { hostPath: path.join(w.container, "work"), sandboxPath: w.sandboxPath, mode: "rw" as const };
  }
  async source(id: string) { return (await this.header(id)).source; }
  async protections() {
    const roots = [await fs.realpath(this.stateRoot)];
    for (const name of await fs.readdir(this.stateRoot)) {
      if (!/^[\da-f-]+\.json$/.test(name)) continue;
      const w = await this.header(name.slice(0, -5));
      roots.push(w.container);
    }
    return roots;
  }

  async create(opts: { hostPath: string; sandboxPath: string; storagePath?: string; copyMode: "clone" | "auto"; excludes: string[] }) {
    if (!path.isAbsolute(opts.hostPath) || opts.hostPath.includes("\0")) throw new Error("hostPath must be an absolute directory");
    if (!path.isAbsolute(opts.sandboxPath) || path.posix.normalize(opts.sandboxPath) === "/" || opts.sandboxPath.includes("\0")) {
      throw new Error("sandboxPath must be absolute and cannot be /");
    }
    if (opts.excludes.some((p) => !safeRelative(p))) throw new Error("excludes must be normalized relative paths, without .. or globs");
    const source = await fs.realpath(opts.hostPath);
    await this.assertRoot(source);
    const state = await fs.realpath(this.stateRoot);
    if (overlaps(source, state)) throw new Error("Source cannot overlap autobox management storage");
    const storageLex = opts.storagePath || path.join(os.homedir(), "Library", "Application Support", "autobox-workspaces");
    if (!path.isAbsolute(storageLex)) throw new Error("storagePath must be absolute");
    // Check before creating anything, so storage creation cannot modify the source.
    if (overlaps(source, path.resolve(storageLex))) throw new Error("storagePath must be outside the source directory");
    const existing = await fs.realpath(storageLex).catch((e) => { if (errorCode(e) !== "ENOENT") throw e; return null; });
    const parent = existing || await fs.realpath(path.dirname(storageLex));
    if (overlaps(source, parent) && !existing) throw new Error("storagePath parent overlaps source; choose an existing storage directory");
    if (existing && overlaps(source, existing)) throw new Error("storagePath resolves inside the source");
    for (const p of await this.protections()) if (overlaps(source, p)) throw new Error("Source overlaps an existing workspace");
    await fs.mkdir(storageLex, { recursive: true, mode: 0o700 });
    const storage = await fs.realpath(storageLex);
    if (overlaps(source, storage)) throw new Error("storagePath resolves inside the source");
    const id = randomUUID(), container = path.join(storage, `autobox-workspace-${id}`);
    await fs.mkdir(container, { mode: 0o700 });
    try {
      const sourceTree = await scan(source, opts.excludes);
      const baseline = `baseline-${randomUUID()}`;
      const counts = await copyTree(source, path.join(container, baseline), sourceTree, opts.copyMode);
      const baselineTree = await scan(path.join(container, baseline), []);
      await copyTree(path.join(container, baseline), path.join(container, "work"), baselineTree, opts.copyMode);
      const after = await scan(source, opts.excludes);
      if (!sameTree(sourceTree, after)) throw new Error("Source changed during creation; retry with source writers paused");
      const w: Workspace = {
        version: 1, id, source, container, baseline, stateFile: "",
        sandboxPath: path.posix.normalize(opts.sandboxPath), copyMode: opts.copyMode, excludes: opts.excludes,
        sourceState: [...sourceTree], workState: [...await scan(path.join(container, "work"), [])],
      };
      await this.save(w);
      return { ok: true, workspaceId: id, mount: { workspaceId: id }, sandboxPath: w.sandboxPath, ...counts };
    } catch (e) {
      await fs.rm(container, { recursive: true, force: true });
      throw e;
    }
  }

  private async inspect(w: Workspace) {
    const workRoot = path.join(w.container, "work"), baseRoot = path.join(w.container, w.baseline);
    await this.assertRoot(w.source);
    const base = await scan(baseRoot, []), work = await scan(workRoot, w.excludes), host = await scan(w.source, w.excludes);
    const originalWork = new Map(w.workState), originalHost = new Map(w.sourceState);
    const all: Change[] = [];
    for (const p of new Set([...base.keys(), ...work.keys()])) {
      const b = base.get(p), n = work.get(p);
      if (identicalStat(originalWork.get(p), n)) continue;
      if (await equal(b, n, path.join(baseRoot, p), path.join(workRoot, p))) continue;
      all.push({ path: p, action: !b ? "add" : !n ? "delete" : b.kind !== n.kind ? "replace" : "modify" });
    }
    const removingDirs = all.filter((c) => base.get(c.path)?.kind === "directory" && work.get(c.path)?.kind !== "directory");
    const changes = all.filter((c) => !removingDirs.some((d) => c.path.startsWith(d.path + "/")));
    const proposedHost = new Map(host);
    for (const c of changes) {
      const n = work.get(c.path);
      if (host.get(c.path)?.kind === "directory" && n?.kind !== "directory") {
        for (const p of proposedHost.keys()) if (p.startsWith(c.path + "/")) proposedHost.delete(p);
      }
      if (n) proposedHost.set(c.path, n);
      else proposedHost.delete(c.path);
    }
    const conflicts = new Set<string>();
    const alreadyApplied = new Set<string>();
    for (const c of changes) {
      const p = c.path, b = base.get(p), n = work.get(p), h = host.get(p);
      if (b?.kind === "directory" && n?.kind !== "directory" && w.excludes.some((e) => e.startsWith(p + "/"))) {
        conflicts.add(p); // Never recursively delete an excluded host subtree.
      }
      if (await equal(n, h, path.join(workRoot, p), path.join(w.source, p))) {
        // Directory equality alone cannot establish that descendant changes were applied.
        if (n?.kind !== "directory") alreadyApplied.add(p);
      } else if (!identicalStat(originalHost.get(p), h) &&
          !await equal(b, h, path.join(baseRoot, p), path.join(w.source, p))) conflicts.add(p);
      if (b?.kind === "directory" && n?.kind !== "directory" && !alreadyApplied.has(p)) {
        for (const child of new Set([...base.keys(), ...host.keys()])) {
          if (!child.startsWith(p + "/")) continue;
          if (!identicalStat(originalHost.get(child), host.get(child)) &&
              !await equal(base.get(child), host.get(child), path.join(baseRoot, child), path.join(w.source, child))) conflicts.add(child);
        }
      }
      let parent = path.posix.dirname(p);
      while (parent !== ".") {
        if (host.get(parent)?.kind !== "directory" &&
            !changes.some((c) => c.path === parent && work.get(parent)?.kind === "directory")) conflicts.add(parent);
        parent = path.posix.dirname(parent);
      }
      if (n?.kind === "symlink") {
        if (!safeLink(p, n.target!, work, w.excludes) || !safeLink(p, n.target!, proposedHost, w.excludes)) conflicts.add(p);
      }
    }
    return { workRoot, baseRoot, base, work, host, changes, conflicts: [...conflicts].sort(), alreadyApplied };
  }

  async status(id: string) {
    const w = await this.load(id), r = await this.inspect(w);
    return { ok: true, workspaceId: id, sandboxPath: w.sandboxPath, changes: r.changes, conflicts: r.conflicts };
  }

  async sync(id: string) {
    const w = await this.load(id), r = await this.inspect(w);
    if (r.conflicts.length) return { ok: false, workspaceId: id, changes: r.changes, conflicts: r.conflicts, applied: [] };
    if (!r.changes.length) return { ok: true, workspaceId: id, changes: [], applied: [], clonedFiles: 0, copiedFiles: 0 };
    // Staged replacements must be on the HOST volume so rename remains atomic,
    // including copyMode=auto workspaces stored on another disk.
    const stage = await fs.mkdtemp(path.join(w.source, ".autobox-sync-"));
    const stageExclude = path.basename(stage);
    const snapshotRoot = path.join(w.container, `stage-${randomUUID()}`);
    const applied: string[] = [];
    try {
      // Freeze ONLY changed files; unchanged project files need no extra clones during sync.
      await fs.mkdir(snapshotRoot, { mode: 0o700 });
      const frozen: [string, string][] = [];
      for (let i = 0; i < r.changes.length; i++) {
        const c = r.changes[i], e = r.work.get(c.path);
        if (e?.kind === "file") frozen.push([path.join(r.workRoot, c.path), path.join(snapshotRoot, String(i))]);
      }
      await copyFiles(frozen, w.copyMode);
      const pairs: [string, string][] = [];
      for (let i = 0; i < r.changes.length; i++) {
        const c = r.changes[i], e = r.work.get(c.path);
        if (e?.kind === "file" && !r.alreadyApplied.has(c.path)) pairs.push([path.join(snapshotRoot, String(i)), path.join(stage, String(i))]);
        else if (e?.kind === "symlink" && !r.alreadyApplied.has(c.path)) await fs.symlink(e.target!, path.join(stage, String(i)));
      }
      const counts = await copyFiles(pairs, w.copyMode);
      // Recheck all host metadata after staging. External writers must remain paused through apply.
      if (!sameTree(r.host, await scan(w.source, [...w.excludes, stageExclude])) ||
          !sameTree(r.work, await scan(r.workRoot, w.excludes))) {
        throw new Error("Host changed while staging sync; no changes applied, retry with host writers paused");
      }
      const ordered = r.changes.map((c, i) => ({ ...c, i })).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
      for (const c of ordered) {
        if (r.alreadyApplied.has(c.path)) continue;
        const target = path.join(w.source, c.path), e = r.work.get(c.path);
        const parent = await fs.realpath(path.dirname(target));
        if (!inside(w.source, parent) || parent !== path.dirname(target)) throw new Error(`Host parent changed or is a symlink: ${c.path}`);
        if (!e || (r.base.get(c.path)?.kind === "directory" && e.kind !== "directory")) {
          await fs.rm(target, { recursive: true, force: true });
        } else if (e.kind === "directory" && r.host.get(c.path)?.kind !== "directory") {
          await fs.rm(target, { force: true });
        }
        if (e?.kind === "directory") {
          await fs.mkdir(target, { recursive: false, mode: 0o700 }).catch((err) => { if (errorCode(err) !== "EEXIST") throw err; });
        } else if (e) await fs.rename(path.join(stage, String(c.i)), target);
        applied.push(c.path);
      }
      for (const c of [...ordered].reverse()) {
        const e = r.work.get(c.path);
        if (e?.kind === "directory") await fs.chmod(path.join(w.source, c.path), e.mode);
      }
      // Advance only synchronized baseline paths. If interrupted, host==workspace
      // comparisons make already-applied changes recoverable on the next sync.
      const baselinePairs: [string, string][] = [];
      for (const c of ordered) {
        if (r.work.get(c.path)?.kind === "file") {
          baselinePairs.push([path.join(snapshotRoot, String(c.i)), path.join(snapshotRoot, `base-${c.i}`)]);
        }
      }
      await copyFiles(baselinePairs, w.copyMode);
      for (const c of ordered) {
        const target = path.join(r.baseRoot, c.path), e = r.work.get(c.path);
        if (!e || (r.base.get(c.path)?.kind === "directory" && e.kind !== "directory")) {
          await fs.rm(target, { recursive: true, force: true });
        } else if (e.kind === "directory" && r.base.get(c.path)?.kind !== "directory") {
          await fs.rm(target, { force: true });
        }
        if (e?.kind === "directory") {
          await fs.mkdir(target, { mode: 0o700 }).catch((err) => { if (errorCode(err) !== "EEXIST") throw err; });
        } else if (e?.kind === "file") await fs.rename(path.join(snapshotRoot, `base-${c.i}`), target);
        else if (e?.kind === "symlink") {
          await fs.symlink(e.target!, path.join(snapshotRoot, `link-${c.i}`));
          await fs.rename(path.join(snapshotRoot, `link-${c.i}`), target);
        }
      }
      for (const c of [...ordered].reverse()) {
        const e = r.work.get(c.path);
        if (e?.kind === "directory") await fs.chmod(path.join(r.baseRoot, c.path), e.mode);
      }
      // Keep original host signatures for untouched paths; unrelated host changes remain outside our baseline.
      const sourceState = new Map(w.sourceState), nowHost = await scan(w.source, [...w.excludes, stageExclude]);
      for (const c of r.changes) {
        for (const p of sourceState.keys()) {
          if (p === c.path || (r.base.get(c.path)?.kind === "directory" && r.work.get(c.path)?.kind !== "directory" && p.startsWith(c.path + "/"))) sourceState.delete(p);
        }
        const e = nowHost.get(c.path);
        if (e) sourceState.set(c.path, e);
      }
      w.sourceState = [...sourceState];
      w.workState = [...r.work];
      await this.save(w);
      return { ok: true, workspaceId: id, changes: r.changes, applied, ...counts };
    } catch (e) {
      return { ok: false, workspaceId: id, error: e instanceof Error ? e.message : String(e), applied,
        recovery: "Workspace retained. Sync applies individual files atomically, not the whole tree. Inspect status before retrying." };
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
      await fs.rm(snapshotRoot, { recursive: true, force: true });
    }
  }

  async discard(id: string) {
    const w = await this.header(id);
    await this.assertRoot(w.container);
    // Rename detaches the workspace before deletion, and never targets the original host directory.
    const trash = path.join(path.dirname(w.container), `autobox-discard-${id}-${randomUUID()}`);
    await fs.rename(w.container, trash);
    try { await fs.unlink(this.recordPath(id)); }
    catch (e) { await fs.rename(trash, w.container); throw e; }
    try {
      for (const name of await fs.readdir(this.stateRoot)) {
        if (name.startsWith(`${id}.state-`) && /^[\da-f-]+\.state-[\da-f-]+\.json$/.test(name)) {
          await fs.unlink(path.join(this.stateRoot, name));
        }
      }
      await fs.rm(trash, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, workspaceId: id, discarded: true, cleanupPath: trash,
        error: `Workspace detached but storage cleanup failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, workspaceId: id, discarded: true };
  }
}
