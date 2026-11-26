// Pure mapping from OpenCode hook/event payloads to activity records.
// No I/O and no throwing: malformed input yields null. Node built-ins only.

export const REDACTED = '[redacted]';
const MAX_BYTES = 262144;
const MAX_DEPTH = 50;

// Applied in order. The leading \b keeps words like "task-management-..." safe.
const PATTERNS = [
  [/\bsk-or-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}/g, REDACTED],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, REDACTED],
  // Assignment form: NAME_KEY=value, token: "value", "api_key": "a b" ...
  // Identifier parts are capped at 64 chars so scrubbing stays linear on hostile input.
  [
    /\b([A-Za-z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]{0,64})("?)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi,
    (_m, id, q, sep, val) => {
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : '';
      return `${id}${q}${sep}${quote}${REDACTED}${quote}`;
    },
  ],
];

// Postgres cannot store NUL (\u0000) or lone UTF-16 surrogates; a record carrying one would be
// refused forever. Drop NULs and replace lone surrogates with U+FFFD.
export function clean(s) {
  const out = s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
  return typeof out.toWellFormed === 'function' ? out.toWellFormed() : out.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

function scrubString(s) {
  let out = clean(s);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep copy with every string scrubbed and every string and key cleaned (see clean). */
export function scrub(value, depth = 0) {
  if (typeof value === 'string') return scrubString(value);
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[clean(k)] = scrub(v, depth + 1);
    return out;
  }
  return value;
}

/** True when the basename is .env or .env.<anything>. Handles / and \ separators. */
export function isEnvFile(path) {
  if (typeof path !== 'string') return false;
  const base = path.split(/[\\/]/).pop() ?? '';
  return /^\.env(\..*)?$/.test(base);
}

function cutBytes(s) {
  if (Buffer.byteLength(s, 'utf8') <= MAX_BYTES) return null;
  const buf = Buffer.from(s, 'utf8');
  let end = MAX_BYTES;
  // Do not split a multi-byte character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function truncateValue(value, flag, depth = 0) {
  if (typeof value === 'string') {
    const cut = cutBytes(value);
    if (cut === null) return value;
    flag.hit = true;
    return cut;
  }
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => truncateValue(v, flag, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateValue(v, flag, depth + 1);
    return out;
  }
  return value;
}

/** Cut strings over 262144 bytes; sets `truncated: true` when anything was cut. */
export function truncate(data) {
  const flag = { hit: false };
  const out = truncateValue(data, flag);
  if (flag.hit && out && typeof out === 'object' && !Array.isArray(out)) out.truncated = true;
  return out;
}

const isoOf = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString());
const str = (v) => (typeof v === 'string' ? v : null);
const cleanOrNull = (v) => (typeof v === 'string' ? clean(v) : v);

function build(id, kind, ts, folder, sessionId, data) {
  // Truncate first so the scrubber never sees an unbounded string.
  const sid = str(sessionId);
  return { id: clean(id), kind, ts, folder: cleanOrNull(folder), sessionId: sid === null ? null : clean(sid), data: scrub(truncate(data)) };
}

export function fromChatMessage(input, output, folder) {
  try {
    const msg = output?.message;
    const id = str(msg?.id);
    if (!id || !Array.isArray(output?.parts)) return null;
    const text = output.parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
    return build(id, 'prompt', isoOf(msg?.time?.created), folder, input?.sessionID ?? msg?.sessionID, {
      text,
      agent: input?.agent ?? msg?.agent ?? null,
      model: msg?.model?.modelID ?? null,
    });
  } catch {
    return null;
  }
}

const COMMIT_RE = /\bgit\b[^\n]*\bcommit\b/;
const NONE = { record: null, scanCommits: false };

function fromPart(props, folder) {
  const part = props?.part;
  const id = str(part?.id);
  if (!id) return NONE;
  const sessionId = part.sessionID ?? props.sessionID;
  if (part.type === 'text') {
    const end = part.time?.end;
    if (typeof end !== 'number') return NONE;
    const record = build(id, 'reply', isoOf(end), folder, sessionId, { text: part.text ?? '', messageId: part.messageID ?? null });
    return { record, scanCommits: false };
  }
  if (part.type === 'tool') {
    const state = part.state;
    if (state?.status !== 'completed' && state?.status !== 'error') return NONE;
    const input = state.input && typeof state.input === 'object' ? { ...state.input } : {};
    let output = state.status === 'error' ? (state.error ?? '') : (state.output ?? '');
    const path = input.filePath ?? input.path ?? input.file_path;
    if (isEnvFile(path)) {
      for (const k of ['content', 'newString', 'oldString']) if (k in input) input[k] = REDACTED;
      output = REDACTED;
    }
    const record = build(id, 'tool', isoOf(state.time?.end), folder, sessionId, {
      tool: part.tool ?? null,
      status: state.status,
      title: state.title ?? null,
      input,
      output,
    });
    const scanCommits = part.tool === 'bash' && state.status === 'completed' && COMMIT_RE.test(String(state.input?.command ?? ''));
    return { record, scanCommits };
  }
  return NONE;
}

function fromMessageUpdated(props, folder) {
  const info = props?.info;
  if (info?.role !== 'assistant' || typeof info.time?.completed !== 'number' || !str(info.id)) return NONE;
  const record = build(`${info.id}:turn`, 'turn', isoOf(info.time.completed), folder, info.sessionID ?? props.sessionID, {
    agent: info.agent ?? null,
    model: info.modelID ?? null,
    cost: info.cost ?? null,
    tokens: info.tokens ?? null,
    finish: info.finish ?? null,
  });
  return { record, scanCommits: false };
}

export function fromEvent(event, folder) {
  try {
    switch (event?.type) {
      case 'message.part.updated':
        return fromPart(event.properties, folder);
      case 'message.updated':
        return fromMessageUpdated(event.properties, folder);
      case 'session.idle':
        return { record: null, scanCommits: true };
      default:
        return NONE;
    }
  } catch {
    return NONE;
  }
}
