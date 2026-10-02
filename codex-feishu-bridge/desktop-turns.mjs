// Pure projections for Codex desktop snapshots; no I/O or submission authority.
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value) => typeof value === 'string' && value.trim() !== '';
export const SUMMARY_LIMIT = 320;

/**
 * Canonical island entries supply chronology; entitiesByKey is only a lookup.
 * Unreferenced entities and legacy mirrors are ignored when canonical history
 * exists. With no canonical history, use the legacy turns array.
 * Duplicate turn IDs retain their first chronological position and latest data.
 * The input state and turn objects are never modified.
 */
export function orderedTurns(state) {
  if (!record(state)) return [];
  const canonical = state.turnHistory?.kind === 'canonical';
  const history = state.turnHistory?.history;
  let candidates;
  if (canonical) {
    if (!record(history) || !record(history.entitiesByKey) || !Array.isArray(history.islands)) return [];
    candidates = history.islands.flatMap((island) =>
      Array.isArray(island?.entries) ? island.entries.flatMap((entry) => {
        const key = entry?.value;
        return typeof key === 'string' && Object.hasOwn(history.entitiesByKey, key)
          && record(history.entitiesByKey[key]) ? [history.entitiesByKey[key]] : [];
      }) : []);
  } else {
    candidates = Array.isArray(state.turns) ? state.turns.filter(record) : [];
  }
  const result = [];
  const positionById = new Map();
  for (const turn of candidates) {
    if (!nonblank(turn.turnId)) { result.push(turn); continue; }
    const position = positionById.get(turn.turnId);
    if (position === undefined) {
      positionById.set(turn.turnId, result.length);
      result.push(turn);
    } else result[position] = turn;
  }
  return result;
}

/**
 * A canonical tail must explicitly reach the newest boundary. Inspect the
 * latest meaningful turn before checking inProgress; never fall back to an old
 * inProgress turn after a newer terminal turn or pending no-ID placeholder.
 */
export function activeTurn(state) {
  if (!record(state)) return null;
  if (state.turnHistory?.kind === 'canonical') {
    const tail = state.turnHistory.history?.islands?.at(-1);
    if (tail?.newerBoundary?.status !== 'exhausted') return null;
  }
  const latest = orderedTurns(state).findLast((turn) =>
    nonblank(turn.turnId) || (turn.status !== 'completed' && turn.status !== 'failed'));
  return latest?.status === 'inProgress' && nonblank(latest.turnId) ? latest : null;
}

function summarize(text) {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  const characters = Array.from(normalized);
  return {
    summary: characters.length > SUMMARY_LIMIT
      ? characters.slice(0, SUMMARY_LIMIT - 1).join('') + '…' : normalized,
    summaryTruncated: characters.length > SUMMARY_LIMIT,
    fullText: text,
  };
}

function completionOf(turn) {
  if (!record(turn) || !nonblank(turn.turnId) || !TERMINAL.has(turn.status)) return null;
  const base = {
    turnId: turn.turnId, status: turn.status, summary: '', fullText: '',
    summaryTruncated: false, summarySource: 'none', agentMessageId: null,
  };
  // Failed/interrupted notifications report status only, never tool/error detail.
  if (turn.status !== 'completed') return base;
  const messages = Array.isArray(turn.items)
    ? turn.items.filter((item) => record(item) && item.type === 'agentMessage') : [];
  const eligible = (item) => typeof item?.text === 'string' && item.text.trim() !== ''
    && !(Array.isArray(item.questions) && item.questions.length > 0) && item.delivery !== 'async';
  let final = messages.findLast((item) => item.phase === 'final_answer' && eligible(item));
  let summarySource = 'explicit_final';
  if (!final) {
    // Older ordinary replies can omit phase. Codex's own terminal projection
    // uses the last agentMessage text; use that fallback only when unphased.
    const last = messages.at(-1);
    if (last && (last.phase == null || last.phase === '') && eligible(last)) {
      final = last;
      summarySource = 'terminal_last_agent_message';
    }
  }
  if (!final) return base;
  return {
    ...base, ...summarize(final.text), summarySource,
    agentMessageId: nonblank(final.id) ? final.id : null,
  };
}

/** Return only an explicitly terminal, identified turn; otherwise null. */
export function turnCompletion(state, turnId) {
  if (!nonblank(turnId)) return null;
  return completionOf(orderedTurns(state).find((turn) => turn.turnId === turnId));
}

/**
 * Per-thread, per-turn observation tracker.
 * - A turn first seen terminal is a baseline, never a historical notification.
 * - Only observed inProgress -> terminal transitions can emit.
 * - completed with no usable final text waits for a later state update.
 * - failed/interrupted emit status only.
 * - flushPending(threadId?) is an explicit caller-controlled status-only fallback,
 *   intended after a short grace period and a fresh observe() call.
 * Nothing is persisted; restarting intentionally establishes a new baseline.
 */
export function createCompletionTracker() {
  const threads = new Map();
  const emit = (threadId, entry, completion, output) => {
    entry.stage = 'emitted';
    entry.completion = completion;
    output.push({ threadId, ...completion });
  };
  return Object.freeze({
    observe(threadId, state) {
      if (!nonblank(threadId)) throw new TypeError('threadId is required');
      let tracked = threads.get(threadId);
      if (!tracked) { tracked = new Map(); threads.set(threadId, tracked); }
      const output = [];
      for (const turn of orderedTurns(state)) {
        if (!nonblank(turn.turnId)) continue;
        let entry = tracked.get(turn.turnId);
        if (turn.status === 'inProgress') {
          if (!entry) {
            tracked.set(turn.turnId, { stage: 'running', completion: null });
          } else if (entry.stage === 'other' || entry.stage === 'pending') {
            entry.stage = 'running';
            entry.completion = null;
          }
          continue;
        }
        const completion = completionOf(turn);
        if (!completion) {
          if (!entry) tracked.set(turn.turnId, { stage: 'other', completion: null });
          continue;
        }
        if (!entry) {
          tracked.set(turn.turnId, { stage: 'baseline', completion });
          continue;
        }
        if (entry.stage !== 'running' && entry.stage !== 'pending') continue;
        if (completion.status === 'completed' && completion.summary === '') {
          entry.stage = 'pending';
          entry.completion = completion;
        } else emit(threadId, entry, completion, output);
      }
      return output;
    },
    flushPending(threadId) {
      if (threadId !== undefined && !nonblank(threadId)) throw new TypeError('threadId must be nonblank');
      const output = [];
      for (const [id, tracked] of threads) {
        if (threadId !== undefined && id !== threadId) continue;
        for (const entry of tracked.values()) {
          if (entry.stage === 'pending') emit(id, entry, entry.completion, output);
        }
      }
      return output;
    },
    snapshot() {
      const pending = [];
      let trackedTurnCount = 0;
      for (const [threadId, tracked] of threads) {
        trackedTurnCount += tracked.size;
        for (const entry of tracked.values()) {
          if (entry.stage === 'pending') pending.push({ threadId, ...entry.completion });
        }
      }
      return { trackedThreadCount: threads.size, trackedTurnCount, pending };
    },
  });
}
