// Durable on-disk queue + HTTP sender for the class recorder.
// Plain ESM, Node built-ins and global fetch only. Never throws into OpenCode.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Owners are `<pid>-<uuid>` (or a bare `<pid>` from recorders before the heartbeat existed).
// Only files of owners in this form are ever claimed by another process.
const OWNER = '\\d+(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?';
const ORPHAN_RE = new RegExp(`^queue-(${OWNER})\\.jsonl$`);
const CLAIMED_RE = new RegExp(`^claimed-(${OWNER})-(.+\\.jsonl)$`);
const HEARTBEAT_RE = new RegExp(`^heartbeat-(${OWNER})$`);
const UNIQUE_PREFIX_RE = /^\d+-\d+-(.+)$/;
// Students upload over slow, patchy mobile data: a batch must fit inside the send timeout.
const BATCH_MAX_BYTES = 262144;
const SEND_TIMEOUT_MS = 30000;
const HEARTBEAT_MS = 60 * 1000;
// A queue file is orphaned when its owner's heartbeat (or, without one, the file itself)
// has not been touched for this long. Pids are not checked: they are reused.
const STALE_MS = 5 * 60 * 1000;

const mtimeMs = (file) => {
  try { return statSync(file).mtimeMs; } catch { return null; }
};

export function createQueue({ dir, send, log, batchMax = 200, backoff = { minMs: 5000, maxMs: 300000 }, owner = `${process.pid}-${randomUUID()}`, flushDelayMs = 200, heartbeatMs = HEARTBEAT_MS }) {
  const say = (m) => {
    try { log(m); } catch { /* logging must never throw */ }
  };
  const ownFile = join(dir, `queue-${owner}.jsonl`);
  const claimedPrefix = `claimed-${owner}-`;
  let running = null;
  let timer = null;
  let stopped = false;
  let delay = 0;
  let claimSeq = 0;
  let tailChecked = false;
  // Adaptive size cap: halved after a timeout or network error, regrown 25% per success.
  // It never drops below one record per batch (an oversize record always goes alone).
  let capBytes = BATCH_MAX_BYTES;
  const rejectedFile = join(dir, `rejected-${owner}.jsonl`);

  try { mkdirSync(dir, { recursive: true }); } catch (e) { say(`queue: cannot create ${dir}: ${e.message}`); }

  // Heartbeat: tells other recorders this owner is alive and its files are not orphans.
  const heartbeatFile = join(dir, `heartbeat-${owner}`);
  let heartbeatFailed = false;
  const beat = () => {
    try {
      writeFileSync(heartbeatFile, new Date().toISOString());
      heartbeatFailed = false;
    } catch (e) {
      if (!heartbeatFailed) say(`queue: cannot write ${heartbeatFile}: ${e.message}`);
      heartbeatFailed = true;
    }
  };
  beat();
  const heartbeat = setInterval(beat, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  const isStale = (otherOwner, file, now) => {
    const hb = mtimeMs(join(dir, `heartbeat-${otherOwner}`));
    const t = hb ?? mtimeMs(file);
    return t !== null && now - t > STALE_MS;
  };

  const ownFiles = () => {
    const files = [];
    if (existsSync(ownFile)) files.push(ownFile);
    try {
      for (const f of readdirSync(dir).sort()) if (f.startsWith(claimedPrefix) && f.endsWith('.jsonl')) files.push(join(dir, f));
    } catch { /* dir unreadable */ }
    return files;
  };

  // Parse a file into [{ id, rec }] and corrupt line count; logs corrupt lines.
  const readRecs = (file) => {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.id === 'string') out.push(rec);
        else say(`queue: dropping unparseable record in ${file}`);
      } catch {
        say(`queue: dropping corrupt line in ${file}: ${line.slice(0, 80)}`);
      }
    }
    return out;
  };

  const claimOrphans = () => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    const now = Date.now();
    for (const name of names) {
      let m = ORPHAN_RE.exec(name);
      let base = name;
      if (m) {
        if (m[1] === owner) continue;
      } else if ((m = CLAIMED_RE.exec(name))) {
        if (name.startsWith(claimedPrefix)) continue;
        base = m[2];
        const u = UNIQUE_PREFIX_RE.exec(base);
        if (u) base = u[1];
      } else continue;
      if (!isStale(m[1], join(dir, name), now)) continue;
      try {
        // Unique rename: exactly one claimer wins; the loser's rename fails with ENOENT.
        renameSync(join(dir, name), join(dir, `${claimedPrefix}${Date.now()}-${claimSeq++}-${base}`));
      } catch { /* another process won the claim */ }
    }
    // Only after the claims: a long-dead owner's heartbeat, whose files are now claimed.
    for (const name of names) {
      const m = HEARTBEAT_RE.exec(name);
      if (m && m[1] !== owner && isStale(m[1], null, now)) {
        try { unlinkSync(join(dir, name)); } catch { /* already gone */ }
      }
    }
  };

  // Remove sent ids from a file, keeping lines appended since the read. Also drops corrupt lines.
  const removeSent = (file, sent) => {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return; }
    const keep = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.id === 'string' && !sent.has(rec.id)) keep.push(line);
      } catch { /* corrupt, already logged */ }
    }
    if (keep.length === 0) {
      try { unlinkSync(file); } catch { /* already gone */ }
      return;
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, keep.join('\n') + '\n');
    renameSync(tmp, file);
  };

  const schedule = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void flush(); }, ms);
    if (timer.unref) timer.unref();
  };

  // Split by count and serialized size; an oversize single record goes alone.
  const makeBatches = (recs) => {
    const out = [];
    let cur = [];
    let bytes = 0;
    for (const r of recs) {
      const n = Buffer.byteLength(JSON.stringify(r)) + 1;
      if (cur.length && (cur.length >= batchMax || bytes + n > capBytes)) {
        out.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(r);
      bytes += n;
    }
    if (cur.length) out.push(cur);
    return out;
  };

  // Returns true when the batch is fully dealt with (sent or quarantined), false to back off.
  const sendBatch = async (file, batch) => {
    let status;
    try {
      status = await send(batch);
    } catch (e) {
      capBytes = Math.max(1, Math.floor(capBytes / 2));
      say(`queue: send failed: ${e && e.message}; next batches up to ${capBytes} bytes`);
      return false;
    }
    if (status >= 200 && status < 300) {
      capBytes = Math.min(BATCH_MAX_BYTES, Math.ceil(capBytes * 1.25));
      removeSent(file, new Set(batch.map((r) => r.id)));
      return true;
    }
    if (status === 400 || status === 413) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        if (!(await sendBatch(file, batch.slice(0, mid)))) return false;
        return sendBatch(file, batch.slice(mid));
      }
      say(`queue: collector rejected record ${batch[0].id} with ${status}; moved to ${rejectedFile}`);
      try {
        appendFileSync(rejectedFile, JSON.stringify(batch[0]) + '\n');
      } catch (e) {
        say(`queue: cannot write ${rejectedFile}: ${e.message}`);
        return false;
      }
      removeSent(file, new Set([batch[0].id]));
      return true;
    }
    say(`queue: collector answered ${status}`);
    return false;
  };

  const run = async () => {
    claimOrphans();
    let failed = false;
    for (const file of ownFiles()) {
      const recs = readRecs(file);
      if (recs.length === 0) { removeSent(file, new Set()); continue; }
      for (const batch of makeBatches(recs)) {
        if (!(await sendBatch(file, batch))) { failed = true; break; }
      }
      if (failed) break;
    }
    if (failed) {
      delay = delay ? Math.min(delay * 2, backoff.maxMs) : backoff.minMs;
      schedule(delay);
    } else {
      delay = 0;
      if (pending() > 0) schedule(flushDelayMs);
    }
  };

  function flush() {
    if (running) return running;
    running = run()
      .catch((e) => {
        say(`queue: flush error: ${e && e.message}`);
        delay = delay ? Math.min(delay * 2, backoff.maxMs) : backoff.minMs;
        schedule(delay);
      })
      .finally(() => { running = null; });
    return running;
  }

  function pending() {
    let n = 0;
    for (const file of ownFiles()) {
      try {
        n += readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
      } catch { /* vanished */ }
    }
    return n;
  }

  return {
    add(rec) {
      try {
        let lead = '';
        if (!tailChecked) {
          tailChecked = true;
          if (existsSync(ownFile)) {
            const buf = readFileSync(ownFile);
            if (buf.length && buf[buf.length - 1] !== 10) lead = '\n';
          }
        }
        appendFileSync(ownFile, lead + JSON.stringify(rec) + '\n');
      } catch (e) {
        say(`queue: cannot write ${ownFile}: ${e.message}`);
        return;
      }
      if (!timer && !running) schedule(flushDelayMs);
    },
    flush,
    pending,
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function makeSender({ url, classCode, studentId, name, timeoutMs = SEND_TIMEOUT_MS }) {
  return async (records) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classCode, studentId: studentId(), name: name(), records }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.body?.cancel(); } catch { /* body already consumed */ }
    return res.status;
  };
}
