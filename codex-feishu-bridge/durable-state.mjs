import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orderedTurns, turnCompletion } from './desktop-turns.mjs';

const TOP_KEYS = ['version', 'questions', 'turns', 'outbox'];
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const STAGES = new Set(['running', 'baseline', 'pending', 'queued']);
const nonblank = (value) => typeof value === 'string' && value.trim() !== '';
const plain = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const initialData = () => ({ version: 1, questions: {}, turns: {}, outbox: {} });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class DurableStateError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'DurableStateError';
    this.code = code;
  }
}

function invalid(message) {
  throw new DurableStateError('INVALID_STATE', message);
}

function checkJSON(value, at, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !plain(value)) invalid(`${at} must contain only plain JSON values`);
  if (ancestors.has(value)) invalid(`${at} contains a cycle`);
  if (Object.getOwnPropertySymbols(value).length) invalid(`${at} contains symbol keys`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) invalid(`${at} contains a sparse array`);
      checkJSON(value[index], `${at}[${index}]`, ancestors);
    }
    if (Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
      invalid(`${at} contains non-JSON array properties`);
  } else {
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        invalid(`${at} contains an unsafe object key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`${at} contains an accessor`);
      checkJSON(descriptor.value, `${at}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/** Validate rather than silently drop invalid/unsupported or non-JSON data. */
export function validateState(data) {
  if (!plain(data)) invalid('State must be a plain object');
  if (data.version !== 1) invalid('Unsupported durable state version');
  if (Object.keys(data).length !== TOP_KEYS.length || !TOP_KEYS.every((key) => Object.hasOwn(data, key)))
    invalid('State must contain only version, questions, turns and outbox');
  for (const section of ['questions', 'turns', 'outbox']) {
    if (!plain(data[section])) invalid(`${section} must be an object map`);
    for (const entry of Object.values(data[section])) {
      if (!plain(entry)) invalid(`${section} entries must be plain objects`);
    }
  }
  checkJSON(data, 'state');
  for (const [key, entry] of Object.entries(data.turns)) {
    if (!nonblank(entry.threadId) || !nonblank(entry.turnId) || !STAGES.has(entry.stage)
      || key !== turnKey(entry.threadId, entry.turnId)) invalid('Invalid completion observation entry');
    if (entry.stage === 'pending' && (!Number.isFinite(entry.pendingAt) || entry.pendingAt < 0))
      invalid('Pending completion requires pendingAt');
    if (entry.stage === 'queued' && entry.outboxKey !== completionKey(entry.threadId, entry.turnId))
      invalid('Queued completion requires its matching outboxKey');
  }
  return data;
}

function serialize(data) {
  validateState(data);
  return Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function readCurrent(filename) {
  let stat;
  try { stat = await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new DurableStateError('INVALID_PATH', 'Durable state path must be a regular file');
  return fs.readFile(filename);
}

/**
 * One owner per file. Saves capture the data at invocation and execute in order.
 * A failed disk write poisons this instance: callers must investigate/reopen it,
 * never automatically overwrite a conflicted or damaged file.
 * Atomic replacement uses a same-directory exclusive temporary file and fsync.
 * This is not a cross-process locking protocol.
 */
export class DurableState {
  #filename;
  #expectedDigest;
  #tail = Promise.resolve();
  #failure = null;
  #closed = false;
  data;

  constructor(filename, data, expectedDigest) {
    this.#filename = filename;
    this.data = data;
    this.#expectedDigest = expectedDigest;
  }

  static async open(filename) {
    if (!nonblank(filename) || !path.isAbsolute(filename))
      throw new DurableStateError('INVALID_PATH', 'An absolute state path is required');
    const resolved = path.resolve(filename);
    const bytes = await readCurrent(resolved);
    if (bytes === null) return new DurableState(resolved, initialData(), null);
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (error) {
      throw new DurableStateError('CORRUPT_STATE', 'Durable state JSON is invalid; original file was preserved', { cause: error });
    }
    validateState(data);
    return new DurableState(resolved, data, digest(bytes));
  }

  get filename() { return this.#filename; }

  save() {
    if (this.#closed)
      return Promise.reject(new DurableStateError('STATE_CLOSED', 'Durable state is closed'));
    let bytes;
    try { bytes = serialize(this.data); }
    catch (error) { return Promise.reject(error); }
    const operation = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      await this.#write(bytes);
    });
    this.#tail = operation.then(
      () => undefined,
      (error) => { this.#failure ??= error; },
    );
    return operation;
  }

  async #write(bytes) {
    const directory = path.dirname(this.#filename);
    await fs.mkdir(directory, { recursive: true });
    const current = await readCurrent(this.#filename);
    if ((current === null ? null : digest(current)) !== this.#expectedDigest)
      throw new DurableStateError('STATE_CONFLICT', 'Durable state changed outside this instance; original file was preserved');
    const nextDigest = digest(bytes);
    if (nextDigest === this.#expectedDigest) return;
    const temporary = path.join(directory, '.' + path.basename(this.#filename) + '.' + process.pid + '.' + randomUUID() + '.tmp');
    let handle;
    let created = false;
    let committed = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      // Recheck after flushing so a detected external edit is never overwritten.
      const beforeReplace = await readCurrent(this.#filename);
      if ((beforeReplace === null ? null : digest(beforeReplace)) !== this.#expectedDigest)
        throw new DurableStateError('STATE_CONFLICT', 'Durable state changed while saving; original file was preserved');
      await fs.rename(temporary, this.#filename);
      committed = true;
      this.#expectedDigest = nextDigest;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created && !committed) await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  /** Wait for already requested writes; does not implicitly save unsaved edits. */
  async close() {
    this.#closed = true;
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }
}

export const turnKey = (threadId, turnId) => JSON.stringify([threadId, turnId]);
export const completionKey = (threadId, turnId) => JSON.stringify([threadId, 'completion', turnId]);

/**
 * Synchronous I/O-free reducer: mutates only turns and completion outbox entries.
 * First-seen terminal turns become a baseline. A persisted running observation
 * may complete after restart. A queued tombstone prevents resending even when a
 * delivered outbox entry is pruned. Unsent entries keep their original UUID.
 *
 * Empty completed summaries wait summaryGraceMs; call again with the latest
 * snapshot after that delay. Failed/interrupted events have status only.
 * Caller must save BEFORE sending, then mark deliveryStatus/messageId and save.
 * now / createdAt / observedAt / pendingAt are Unix milliseconds.
 */
export function updateCompletionObservation(data, threadId, state, options = {}) {
  validateState(data);
  if (!nonblank(threadId)) throw new TypeError('threadId is required');
  const now = options.now ?? Date.now();
  const grace = options.summaryGraceMs ?? 2000;
  const idFactory = options.idFactory ?? randomUUID;
  if (!Number.isFinite(now) || now < 0 || !Number.isFinite(grace) || grace < 0)
    throw new TypeError('now and summaryGraceMs must be nonnegative finite numbers');
  if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function');
  const taskTitle = typeof options.taskTitle === 'string'
    ? Array.from(options.taskTitle.trim()).slice(0, 160).join('') : '';
  const created = [];
  for (const turn of orderedTurns(state)) {
    if (!nonblank(turn.turnId)) continue;
    const key = turnKey(threadId, turn.turnId);
    const outboxKey = completionKey(threadId, turn.turnId);
    let entry = data.turns[key];
    if (Object.hasOwn(data.outbox, outboxKey)) {
      // An already persisted pending/sent outbox is authoritative for dedup.
      if (!entry || entry.stage !== 'queued') {
        data.turns[key] = { threadId, turnId: turn.turnId, stage: 'queued', status: turn.status, outboxKey, observedAt: now };
      }
      continue;
    }
    if (entry?.stage === 'queued' || entry?.stage === 'baseline') continue;
    if (turn.status === 'inProgress') {
      if (!entry) data.turns[key] = { threadId, turnId: turn.turnId, stage: 'running', status: 'inProgress', observedAt: now };
      else if (entry.stage === 'pending') {
        entry.stage = 'running';
        entry.status = 'inProgress';
        delete entry.pendingAt;
      }
      continue;
    }
    if (!TERMINAL.has(turn.status)) continue;
    if (!entry) {
      data.turns[key] = { threadId, turnId: turn.turnId, stage: 'baseline', status: turn.status, observedAt: now };
      continue;
    }
    const completion = turnCompletion(state, turn.turnId);
    if (!completion) continue;
    if (completion.status === 'completed' && completion.summary === '') {
      if (entry.stage !== 'pending') {
        entry.stage = 'pending';
        entry.status = completion.status;
        entry.pendingAt = now;
      }
      if (now - entry.pendingAt < grace) continue;
    }
    const id = idFactory();
    if (!nonblank(id)) throw new TypeError('idFactory must return a nonblank identifier');
    const message = {
      id, kind: 'completion', threadId, turnId: turn.turnId,
      status: completion.status, summary: completion.summary, fullText: completion.fullText,
      summarySource: completion.summarySource, summaryTruncated: completion.summaryTruncated,
      taskTitle, createdAt: now, deliveryStatus: 'pending',
    };
    data.outbox[outboxKey] = message;
    entry.stage = 'queued';
    entry.status = completion.status;
    entry.outboxKey = outboxKey;
    delete entry.pendingAt;
    created.push(message);
  }
  return created;
}
