// Reports git commits not yet seen. Node built-ins only, no shell, never throws:
// any git or filesystem failure yields [].
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { isEnvFile, scrub, truncate } from './core.js';

const TIMEOUT_MS = 10000;
const MAX_BUFFER = 64 * 1024 * 1024;
// A patch is truncated to 262144 bytes anyway, so never buffer more than this.
const PATCH_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_FILES = 500; // per commit record; fileCount keeps the real total
const FS = '\x1f'; // field separator in git log output
const RS = '\x1e'; // record separator
// Neutralise user config that would change diff output or add escapes/prefixes.
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];

function git(dir, args, maxBuffer = MAX_BUFFER) {
  return new Promise((resolve, reject) => {
    // core.quotepath=off keeps non-ASCII file names (e.g. Ñiño.md) unescaped.
    execFile(
      'git',
      ['-C', dir, '-c', 'core.quotepath=off', ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: TIMEOUT_MS, maxBuffer, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

async function readState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, stateFile);
}

/** Drop whole per-file sections of a patch that belong to .env* files. */
function stripEnvHunks(patch) {
  const parts = patch.split(/^(?=diff --git )/m);
  return parts
    .filter((section) => {
      const header = section.split('\n', 1)[0];
      if (!header.startsWith('diff --git ')) return true;
      const i = header.lastIndexOf(' b/');
      return !(i >= 0 && isEnvFile(header.slice(i + 3)));
    })
    .join('');
}

function parseNumstat(out) {
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [added, deleted, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    const num = (v) => (v === '-' ? null : Number(v));
    files.push({ path, added: num(added), deleted: num(deleted) });
  }
  return files;
}

async function readCommit(dir, sha, folder) {
  const meta = await git(dir, ['show', '--no-patch', `--format=%an${FS}%aI${FS}%B`, sha]);
  const [author, aIso, ...msg] = meta.split(FS);
  const message = msg.join(FS).replace(/\s+$/, '');
  let files = [];
  try {
    files = parseNumstat(await git(dir, ['show', '--format=', '--numstat', ...DIFF_FLAGS, sha]));
  } catch {
    files = [];
  }
  const fileCount = files.length;
  let capped = false;
  if (fileCount > MAX_FILES) {
    files = files.slice(0, MAX_FILES);
    capped = true;
  }
  let patch = '';
  let failed = false;
  try {
    patch = stripEnvHunks(await git(dir, ['show', '--format=', '--patch', ...DIFF_FLAGS, sha], PATCH_MAX_BUFFER));
  } catch {
    failed = true; // overflow, timeout or git failure: keep the commit, drop the patch
  }
  const time = new Date(aIso).toISOString();
  const data = { sha, message, author, time, files, fileCount, patch };
  if (failed || capped) data.truncated = true;
  return { id: `commit:${sha}`, kind: 'commit', ts: time, folder, sessionId: null, data: scrub(truncate(data)) };
}

/** Install time as whole seconds (git committer times have no finer grain), or null for no limit. */
function sinceSeconds(since) {
  const ms = typeof since === 'string' ? Date.parse(since) : since;
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Commits on HEAD not reported before, oldest first, at most `max`.
 * `since` (ISO string or epoch ms) is the recorder's install time: commits whose committer time is
 * earlier are never reported, so a repo's history from before install is never uploaded.
 */
export async function newCommits({ dir, stateFile, max = 200, since }) {
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    if (!top) return [];
    const head = (await git(top, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
    if (!head) return [];

    const state = await readState(stateFile);
    const last = typeof state[top] === 'string' ? state[top] : null;
    const list = (revs) => git(top, ['rev-list', '--reverse', '--topo-order', '--timestamp', ...revs]);
    let out;
    if (last) {
      try {
        // Also right after an amend or rebase (last no longer an ancestor): only what HEAD has that last had not.
        out = await list([head, '--not', last]);
      } catch {
        out = await list([head]); // last is unknown to this repo (e.g. re-created): fall back to `since`
      }
    } else {
      out = await list([head]);
    }

    const floor = sinceSeconds(since);
    const shas = [];
    let seen = null;
    for (const line of out.split('\n')) {
      if (!line) continue;
      if (shas.length >= max) break;
      const [t, sha] = line.split(' ');
      seen = sha;
      if (floor === null || Number(t) >= floor) shas.push(sha);
    }
    if (seen === null) return [];

    const folder = basename(top);
    const recs = [];
    for (const sha of shas) {
      try {
        recs.push(await readCommit(top, sha, folder));
      } catch {
        // Unreadable commit (metadata failed): skip it, state still advances.
      }
    }

    await writeState(stateFile, { ...state, [top]: seen });
    return recs;
  } catch {
    return [];
  }
}
