// Pure in-memory desktop stream projection. No I/O or submission authority.
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const nonblank = (value) => typeof value === 'string' && value.trim() !== '';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

// Clone JSON data without invoking inherited setters. Reject non-JSON values,
// cycles, and dangerous keys even when they are nested inside patch values.
function clone(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!record(value) && !Array.isArray(value)) || seen.has(value)) fail('invalid_json_value');
  seen.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) fail('unsafe_key');
    Object.defineProperty(result, key, {
      value: clone(value[key], seen), enumerable: true, writable: true, configurable: true,
    });
  }
  if (Array.isArray(value) && result.length !== value.length) fail('sparse_array');
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!own(value, index)) fail('sparse_array');
    }
  }
  seen.delete(value);
  return result;
}

function arrayIndex(key, length, allowEnd = false) {
  // Immer uses integer indices, whereas JSON Patch's '-' is not accepted.
  if (!Number.isSafeInteger(key) || key < 0 || key > length
    || (!allowEnd && key === length)) fail('invalid_array_index');
  return key;
}

function validatePath(path) {
  if (!Array.isArray(path)) fail('invalid_patch_path');
  for (const segment of path) {
    if ((typeof segment !== 'string'
      && !(Number.isSafeInteger(segment) && segment >= 0))
      || FORBIDDEN.has(segment)) fail('unsafe_patch_path');
  }
}

/** Apply an entire patch batch atomically to a detached copy, or throw. */
export function applyImmerPatches(state, patches) {
  if (!Array.isArray(patches)) fail('invalid_patches');
  let result = clone(state);
  for (const patch of patches) {
    if (!record(patch) || !['add', 'remove', 'replace'].includes(patch.op)) fail('invalid_patch');
    validatePath(patch.path);
    if (patch.op !== 'remove' && !own(patch, 'value')) fail('missing_patch_value');
    if (patch.path.length === 0) {
      if (patch.op === 'remove') fail('cannot_remove_root');
      result = clone(patch.value);
      continue;
    }
    let parent = result;
    for (const segment of patch.path.slice(0, -1)) {
      if (!record(parent) && !Array.isArray(parent)) fail('invalid_patch_parent');
      if (Array.isArray(parent)) arrayIndex(segment, parent.length);
      if (!own(parent, segment)) fail('missing_patch_parent');
      parent = parent[segment];
    }
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length, patch.op === 'add');
      if (patch.op === 'add') parent.splice(index, 0, clone(patch.value));
      else if (patch.op === 'remove') parent.splice(index, 1);
      else parent[index] = clone(patch.value);
    } else if (record(parent)) {
      if (typeof key !== 'string') fail('invalid_object_key');
      if (patch.op !== 'add' && !own(parent, key)) fail('missing_patch_target');
      if (patch.op === 'remove') delete parent[key];
      else Object.defineProperty(parent, key, {
        value: clone(patch.value), enumerable: true, writable: true, configurable: true,
      });
    } else fail('invalid_patch_parent');
  }
  return result;
}

export function createDesktopState() {
  return { revision: null, conversationState: null, needsResnapshot: true, lastError: null };
}

/**
 * Consume change={type:'snapshot',revision,conversationState} or
 * {type:'patches',baseRevision,revision,patches}. A rejected batch preserves the
 * old state and requires a fresh snapshot; subsequent patches cannot repair it.
 * Reset with createDesktopState() when switching thread/owner/stream identity.
 */
export function reduceDesktopState(current, change) {
  const reject = (code) => ({ ...current, needsResnapshot: true, lastError: code });
  if (!record(change) || !revision(change.revision)) return reject('invalid_revision');
  try {
    if (change.type === 'snapshot') {
      if (current.revision !== null && change.revision < current.revision) return reject('stale_snapshot');
      if (!record(change.conversationState)) return reject('invalid_snapshot');
      return {
        revision: change.revision, conversationState: clone(change.conversationState),
        needsResnapshot: false, lastError: null,
      };
    }
    if (change.type !== 'patches') return reject('invalid_change_type');
    if (current.needsResnapshot || current.conversationState === null) return reject('snapshot_required');
    if (!revision(change.baseRevision) || change.baseRevision !== current.revision) return reject('base_revision_mismatch');
    if (change.revision <= change.baseRevision) return reject('non_increasing_revision');
    const next = applyImmerPatches(current.conversationState, change.patches);
    if (!record(next)) return reject('invalid_snapshot');
    return { revision: change.revision, conversationState: next, needsResnapshot: false, lastError: null };
  } catch (error) {
    return reject(error.code ?? 'invalid_state_change');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function collectItems(state) {
  const items = [];
  const addItems = (source, values) => {
    if (!Array.isArray(values)) return;
    values.forEach((item, index) => {
      if (!record(item)) return;
      const sourcePath = [...source, index];
      // The same identified item can be mirrored in turns and history. Collapse
      // only byte-equivalent JSON data with that explicit identity, never replies
      // merely because their question ID or answer text happens to match.
      const identity = nonblank(item.id) ? JSON.stringify([item.type, item.id]) : null;
      const fingerprint = canonical(item);
      const existing = identity === null ? null : items.find((entry) =>
        entry.identity === identity && entry.fingerprint === fingerprint);
      if (existing) existing.sourcePaths.push(sourcePath);
      else items.push({ item, identity, fingerprint, sourcePaths: [sourcePath] });
    });
  };
  if (Array.isArray(state.turns)) state.turns.forEach((turn, index) => {
    if (record(turn)) addItems(['turns', index, 'items'], turn.items);
  });
  const entities = state.turnHistory?.history?.entitiesByKey;
  if (record(entities)) for (const [key, entity] of Object.entries(entities)) {
    if (record(entity)) addItems(['turnHistory', 'history', 'entitiesByKey', key, 'items'], entity.items);
  }
  for (const entry of items) entry.identityConflict = entry.identity !== null
    && items.some((other) => other.identity === entry.identity && other.fingerprint !== entry.fingerprint);
  return items;
}

function messageText(item) {
  // Read only explicit user message text containers, never arbitrary nested
  // strings, reasoning, tool results, commands, or assistant output.
  const value = own(item, 'input') ? item.input : own(item, 'content') ? item.content : item.text;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length !== 1) return null;
  const part = value[0];
  return record(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : null;
}

/**
 * Project visible historical questions and explicit reply evidence. Presence in
 * history is not proof of a live request: submissionAllowed is always false.
 * Transport authentication and proof of current submission eligibility belong
 * to the caller. Pass conversationState, not the reducer envelope.
 */
export function extractDesktopQuestions(state) {
  if (!record(state)) return { questions: [], pendingReplies: [], ignoredReplies: [], orphanReplies: [], issues: [] };
  const items = collectItems(state);
  const questions = new Map();
  const issues = [];
  for (const entry of items) {
    const { item } = entry;
    if (item.type !== 'agentMessage' || !Array.isArray(item.questions)) continue;
    if (!nonblank(item.id)) { issues.push({ code: 'question_item_missing_id', sourcePaths: entry.sourcePaths }); continue; }
    item.questions.forEach((question, index) => {
      if (!record(question)) { issues.push({ code: 'invalid_question', itemId: item.id, index }); return; }
      const questionItemId = JSON.stringify(['request_user_input_async', item.id, index]);
      const previous = questions.get(questionItemId);
      if (previous) {
        previous.definitionConflict ||= canonical(previous.question) !== canonical(question) || entry.identityConflict;
        previous.sourcePaths.push(...clone(entry.sourcePaths));
      } else questions.set(questionItemId, {
        questionItemId, itemId: item.id, index, question: clone(question),
        title: typeof question.title === 'string' ? question.title : null,
        options: Array.isArray(question.options) ? clone(question.options) : [],
        allowsFreeText: true, sourcePaths: clone(entry.sourcePaths),
        definitionConflict: entry.identityConflict,
        acceptedReplies: [], pendingReplies: [], ignoredReplies: [],
      });
    });
  }
  const pendingReplies = [];
  const ignoredReplies = [];
  const orphanReplies = [];
  for (const entry of items) {
    const { item } = entry;
    if (!['userMessage', 'steeringUserMessage'].includes(item.type)) continue;
    const text = messageText(item);
    if (text === null) continue;
    const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
    if (!match) continue;
    let replies;
    try { replies = JSON.parse(match[1]); } catch { issues.push({ code: 'invalid_reply_json', itemId: item.id ?? null }); continue; }
    if (!Array.isArray(replies)) { issues.push({ code: 'invalid_reply_array', itemId: item.id ?? null }); continue; }
    replies.forEach((reply, replyIndex) => {
      if (!record(reply) || typeof reply.questionItemId !== 'string'
        || typeof reply.question !== 'string' || typeof reply.answer !== 'string') {
        issues.push({ code: 'invalid_reply', itemId: item.id ?? null, replyIndex }); return;
      }
      const disposition = item.type === 'userMessage' || item.status === 'accepted'
        ? 'accepted' : item.status === 'pending' ? 'pending' : 'ignored';
      const evidence = {
        questionItemId: reply.questionItemId, answer: reply.answer,
        question: reply.question,
        itemId: item.id ?? null, itemType: item.type, replyIndex,
        desktopStatus: item.status ?? null, disposition,
        identityConflict: entry.identityConflict, sourcePaths: clone(entry.sourcePaths),
      };
      const question = questions.get(reply.questionItemId);
      if (question) question[`${disposition}Replies`].push(evidence);
      else orphanReplies.push(evidence);
      if (disposition === 'pending') pendingReplies.push(evidence);
      if (disposition === 'ignored') ignoredReplies.push(evidence);
    });
  }
  const projected = [...questions.values()].map((question) => {
    const conflict = question.definitionConflict || question.acceptedReplies.length > 1
      || [...question.acceptedReplies, ...question.pendingReplies].some((reply) => reply.identityConflict);
    return {
      ...question, status: conflict ? 'conflict' : question.acceptedReplies.length === 1
        ? 'answered' : question.pendingReplies.length > 0 ? 'pending' : 'unanswered',
      conflict, hasPendingReply: question.pendingReplies.length > 0,
      // Never choose a winner among repeated accepted replies.
      answer: !conflict && question.acceptedReplies.length === 1 ? question.acceptedReplies[0].answer : null,
      submissionAllowed: false,
    };
  });
  return { questions: projected, pendingReplies, ignoredReplies, orphanReplies, issues };
}
