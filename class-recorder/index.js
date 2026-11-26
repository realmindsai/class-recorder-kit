// OpenCode plugin: records prompts, replies, tool calls, turns and git commits and
// queues them for the teacher's collector. Plain ESM, Node built-ins only.
// Never throws into OpenCode and never prints to the screen; everything goes to recorder.log.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromChatMessage, fromEvent } from './core.js';
import { newCommits } from './git.js';
import { createQueue, makeSender } from './queue.js';

const NAME_MAX = 100; // the collector rejects longer names with a 400
const NAME_REFRESH_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 5000;

function makeLog(stateDir) {
  const file = join(stateDir, 'recorder.log');
  return (msg) => {
    try {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* logging must never throw */
    }
  };
}

// id.json: { studentId, installedAt }. installedAt (ISO) is when the recorder first ran here;
// commits made before it are never uploaded.
function readId(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const id = parsed?.studentId;
  if (!(typeof id === 'string' && id.length > 0 && id.length <= 200)) return null;
  const at = parsed.installedAt;
  return { parsed, studentId: id, installedAt: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null };
}

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Several OpenCode processes may start together. The id file is created with a single
// exclusive write (flag 'wx'); the loser of the race re-reads, retrying briefly in case
// the winner's write is not complete yet, and only then treats the file as corrupt.
// Returns { studentId, installedAt }. An id.json from before installedAt existed gets "now".
function loadStudentId(stateDir, log) {
  const file = join(stateDir, 'id.json');
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (e) {
    log(`cannot create ${stateDir}: ${e.message}`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let readErr = null;
    for (let i = 0; i < 20; i++) {
      try {
        const id = readId(file);
        if (id && id.installedAt) return { studentId: id.studentId, installedAt: id.installedAt };
        if (id) {
          const installedAt = new Date().toISOString();
          try {
            writeAtomic(file, { ...id.parsed, installedAt });
          } catch (e) {
            log(`cannot write installedAt to id.json: ${e.message}`);
          }
          return { studentId: id.studentId, installedAt };
        }
        readErr = new Error('no usable studentId');
      } catch (e) {
        readErr = e;
        if (e && e.code === 'ENOENT') break;
      }
      sleepSync(25);
    }
    const fresh = { studentId: randomUUID(), installedAt: new Date().toISOString() };
    try {
      if (readErr && readErr.code !== 'ENOENT') {
        log(`id.json unreadable (${readErr.message}); regenerating`);
        writeAtomic(file, fresh);
      } else {
        writeFileSync(file, JSON.stringify(fresh), { flag: 'wx' });
      }
      return fresh;
    } catch (e) {
      if (!(e && e.code === 'EEXIST')) {
        log(`cannot write id.json: ${e.message}`);
        return fresh;
      }
      // lost the race: loop and read the winner's file
    }
  }
  return { studentId: randomUUID(), installedAt: new Date().toISOString() };
}

function fallbackName() {
  try {
    const u = userInfo().username.trim();
    if (u) return u.slice(0, NAME_MAX);
  } catch {
    /* userInfo throws on some systems */
  }
  return 'student';
}

function readGitName(dir) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['config', 'user.name'], { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        const name = err ? '' : String(stdout).trim().slice(0, NAME_MAX);
        resolve(name || fallbackName());
      });
    } catch {
      resolve(fallbackName());
    }
  });
}

function loadConfig(log) {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'config.json');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    const url = process.env.CLASS_RECORDER_URL || cfg.collectorUrl;
    const classCode = process.env.CLASS_RECORDER_CODE || cfg.classCode;
    if (typeof url === 'string' && url && typeof classCode === 'string' && classCode) return { url, classCode };
    log('config.json incomplete: need collectorUrl and classCode');
  } catch (e) {
    log(e && e.code === 'ENOENT' ? 'config.json missing' : `config.json unreadable: ${e && e.message}`);
  }
  return null;
}

export const ClassRecorder = async (ctx) => {
  const noop = { event: async () => {}, 'chat.message': async () => {} };
  let log = () => {};
  try {
    const stateDir = process.env.CLASS_RECORDER_HOME || join(homedir(), '.class-recorder');
    log = makeLog(stateDir);
    const cfg = loadConfig(log);
    if (!cfg) return noop;

    const directory = ctx?.directory || process.cwd();
    const folder = basename(directory);
    const { studentId, installedAt } = loadStudentId(stateDir, log);

    let name = fallbackName();
    const refreshName = async () => {
      try {
        name = await readGitName(directory);
      } catch (e) {
        log(`name refresh failed: ${e && e.message}`);
      }
    };
    const nameReady = refreshName();
    const nameTimer = setInterval(() => void refreshName(), NAME_REFRESH_MS);
    if (nameTimer.unref) nameTimer.unref();

    const sender = makeSender({ url: cfg.url, classCode: cfg.classCode, studentId: () => studentId, name: () => name });
    const flushDelayMs = Number(process.env.CLASS_RECORDER_FLUSH_MS);
    const queue = createQueue({
      dir: join(stateDir, 'queue'),
      send: async (records) => {
        await nameReady; // the first batch must carry the real name
        return sender(records);
      },
      log,
      ...(Number.isFinite(flushDelayMs) && flushDelayMs > 0 ? { flushDelayMs } : {}),
    });

    let scanning = false;
    let rescan = false;
    const scanCommits = async () => {
      if (scanning) {
        rescan = true; // a commit may land while a scan runs; look again afterwards
        return;
      }
      scanning = true;
      try {
        do {
          rescan = false;
          const recs = await newCommits({ dir: directory, stateFile: join(stateDir, 'commits.json'), since: installedAt });
          for (const r of recs) queue.add(r);
        } while (rescan);
      } catch (e) {
        log(`commit scan failed: ${e && e.message}`);
      } finally {
        scanning = false;
      }
    };

    return {
      'chat.message': async (input, output) => {
        try {
          const rec = fromChatMessage(input, output, folder);
          if (rec) queue.add(rec);
        } catch (e) {
          log(`chat.message hook failed: ${e && e.message}`);
        }
      },
      event: async (arg) => {
        try {
          const { record, scanCommits: scan } = fromEvent(arg?.event, folder);
          if (record) queue.add(record);
          if (scan) void scanCommits();
        } catch (e) {
          log(`event hook failed: ${e && e.message}`);
        }
      },
    };
  } catch (e) {
    log(`plugin init failed: ${e && e.message}`);
    return noop;
  }
};
