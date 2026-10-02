import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableState, validateState, updateCompletionObservation, completionKey, turnKey } from './durable-state.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-durable-state-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('codex-durable-state-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, filename: path.join(directory, 'state.json') };
}
const fresh = () => ({ version: 1, questions: {}, turns: {}, outbox: {} });
const turn = (turnId, status, items = []) => ({ turnId, status, items });
const state = (...turns) => ({ turns });
const final = (text) => ({ type: 'agentMessage', id: 'msg-1', phase: 'final_answer', text });
const errorCode = (code) => (error) => error.code === code;

test('missing state opens without writing; save and reopen preserve question bindings and outbox', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  assert.deepEqual(store.data, fresh());
  await assert.rejects(fs.access(filename), errorCode('ENOENT'));
  store.data.questions.q1 = { cardId: 'card-1', threadId: 'thread-1', status: 'awaiting', operatorId: 'owner', answer: null };
  store.data.outbox.attention1 = { id: 'attention-1', kind: 'attention', deliveryStatus: 'pending' };
  await store.save();
  await store.close();
  const reopened = await DurableState.open(filename);
  assert.equal(reopened.data.questions.q1.cardId, 'card-1');
  assert.equal(reopened.data.outbox.attention1.id, 'attention-1');
  await reopened.close();
});

test('save takes a call-time snapshot, independent of later unsaved changes', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  store.data.questions.q = { status: 'one' };
  const saving = store.save();
  store.data.questions.q.status = 'two';
  await saving;
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).questions.q.status, 'one');
  await store.close();
});

test('concurrent saves serialize in order and close waits for queued writes', async (t) => {
  const { filename, directory } = await fixture(t);
  const store = await DurableState.open(filename);
  const promises = [];
  for (let index = 0; index < 12; index++) {
    store.data.questions.q = { revision: index, text: '中'.repeat(2048) };
    promises.push(store.save());
  }
  await store.close();
  await Promise.all(promises);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).questions.q.revision, 11);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
  await assert.rejects(store.save(), errorCode('STATE_CLOSED'));
});

test('close never silently persists changes for which save was not requested', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  await store.save();
  store.data.questions.unsaved = { text: 'not requested' };
  await store.close();
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')).questions, {});
});

test('corrupt existing JSON is preserved byte for byte', async (t) => {
  const { filename } = await fixture(t);
  const corrupt = Buffer.from('{ "version": 1, broken\n', 'utf8');
  await fs.writeFile(filename, corrupt);
  await assert.rejects(DurableState.open(filename), errorCode('CORRUPT_STATE'));
  assert.deepEqual(await fs.readFile(filename), corrupt);
});

test('unsupported version and invalid sections fail closed without modifying bytes', async (t) => {
  const { filename } = await fixture(t);
  for (const value of [{ ...fresh(), version: 2 }, { ...fresh(), questions: [] }, { ...fresh(), extra: {} }, { ...fresh(), turns: { bad: {} } }]) {
    const bytes = JSON.stringify(value);
    await fs.writeFile(filename, bytes);
    await assert.rejects(DurableState.open(filename), errorCode('INVALID_STATE'));
    assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  }
});

test('non-JSON values and unsafe keys are rejected before any disk write', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), 1n]) {
    store.data.questions.bad = { value };
    await assert.rejects(store.save(), errorCode('INVALID_STATE'));
  }
  store.data.questions = JSON.parse('{"__proto__":{"polluted":true}}');
  await assert.rejects(store.save(), errorCode('INVALID_STATE'));
  assert.equal({}.polluted, undefined);
  const cycle = {}; cycle.self = cycle;
  store.data.questions = { cycle };
  await assert.rejects(store.save(), errorCode('INVALID_STATE'));
  await assert.rejects(fs.access(filename), errorCode('ENOENT'));
  store.data.questions = {};
  await store.save();
  await store.close();
});

test('external change is preserved and poisons the writer instead of silently overwriting', async (t) => {
  const { filename, directory } = await fixture(t);
  const store = await DurableState.open(filename);
  await store.save();
  const external = '{ externally damaged but must be preserved';
  await fs.writeFile(filename, external);
  store.data.questions.q = { answer: 'new' };
  await assert.rejects(store.save(), errorCode('STATE_CONFLICT'));
  await assert.rejects(store.save(), errorCode('STATE_CONFLICT'));
  await assert.rejects(store.close(), errorCode('STATE_CONFLICT'));
  assert.equal(await fs.readFile(filename, 'utf8'), external);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
});

test('two stale store instances cannot overwrite each others persisted state', async (t) => {
  const { filename } = await fixture(t);
  const first = await DurableState.open(filename);
  const second = await DurableState.open(filename);
  first.data.questions.first = { status: 'kept' };
  await first.save();
  second.data.questions.second = { status: 'must fail' };
  await assert.rejects(second.save(), errorCode('STATE_CONFLICT'));
  await first.close();
  await assert.rejects(second.close(), errorCode('STATE_CONFLICT'));
  assert.ok(JSON.parse(await fs.readFile(filename, 'utf8')).questions.first);
});

test('first terminal snapshot is a durable baseline and never creates historical notifications', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  const terminal = state(turn('old', 'completed', [final('历史答案')]));
  assert.deepEqual(updateCompletionObservation(store.data, 'thread', terminal, { now: 100 }), []);
  assert.equal(store.data.turns[turnKey('thread', 'old')].stage, 'baseline');
  await store.save(); await store.close();
  const reopened = await DurableState.open(filename);
  assert.deepEqual(updateCompletionObservation(reopened.data, 'thread', terminal, { now: 9000 }), []);
  assert.deepEqual(reopened.data.outbox, {});
  await reopened.close();
});

test('observed running survives restart and completes into one stable pending UUID', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  updateCompletionObservation(store.data, 'thread', state(turn('turn', 'inProgress')), { now: 100 });
  await store.save(); await store.close();
  const restarted = await DurableState.open(filename);
  const completed = state(turn('turn', 'completed', [final('完成结果')]));
  const emitted = updateCompletionObservation(restarted.data, 'thread', completed, { now: 200, taskTitle: '任务标题', idFactory: () => 'fixed-uuid' });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], restarted.data.outbox[completionKey('thread', 'turn')]);
  assert.deepEqual([emitted[0].id, emitted[0].kind, emitted[0].deliveryStatus, emitted[0].summary], ['fixed-uuid', 'completion', 'pending', '完成结果']);
  await restarted.save(); await restarted.close();
  const again = await DurableState.open(filename);
  assert.deepEqual(updateCompletionObservation(again.data, 'thread', completed, { now: 300, idFactory: () => { throw new Error('must not generate again'); } }), []);
  assert.equal(again.data.outbox[completionKey('thread', 'turn')].id, 'fixed-uuid');
  await again.close();
});

test('sent outbox and a retained queued turn both prevent repeated notification', () => {
  const data = fresh();
  const running = state(turn('turn', 'inProgress'));
  const completed = state(turn('turn', 'completed', [final('done')]));
  updateCompletionObservation(data, 'thread', running, { now: 1 });
  const [entry] = updateCompletionObservation(data, 'thread', completed, { now: 2 });
  entry.deliveryStatus = 'sent'; entry.messageId = 'feishu-message';
  assert.deepEqual(updateCompletionObservation(data, 'thread', completed, { now: 3 }), []);
  delete data.outbox[completionKey('thread', 'turn')];
  assert.deepEqual(updateCompletionObservation(data, 'thread', running, { now: 4 }), []);
  assert.deepEqual(updateCompletionObservation(data, 'thread', completed, { now: 5 }), []);
});

test('terminal before final text waits across restart, then emits the late final summary', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  updateCompletionObservation(store.data, 'thread', state(turn('turn', 'inProgress')), { now: 100 });
  assert.deepEqual(updateCompletionObservation(store.data, 'thread', state(turn('turn', 'completed')), { now: 200 }), []);
  assert.equal(store.data.turns[turnKey('thread', 'turn')].pendingAt, 200);
  await store.save(); await store.close();
  const restarted = await DurableState.open(filename);
  const entries = updateCompletionObservation(restarted.data, 'thread', state(turn('turn', 'completed', [final('晚到的最终文本')])), { now: 300 });
  assert.equal(entries[0].summary, '晚到的最终文本');
  await restarted.close();
});

test('empty completion emits state only after explicit grace-period observation', () => {
  const data = fresh();
  updateCompletionObservation(data, 'thread', state(turn('turn', 'inProgress')), { now: 100 });
  const completed = state(turn('turn', 'completed'));
  assert.deepEqual(updateCompletionObservation(data, 'thread', completed, { now: 200 }), []);
  assert.deepEqual(updateCompletionObservation(data, 'thread', completed, { now: 2199 }), []);
  const emitted = updateCompletionObservation(data, 'thread', completed, { now: 2200 });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].summary, '');
  assert.deepEqual(updateCompletionObservation(data, 'thread', completed, { now: 9000 }), []);
});

test('failure and interruption notify status immediately without tool or assistant details', () => {
  for (const status of ['failed', 'interrupted']) {
    const data = fresh();
    updateCompletionObservation(data, 'thread', state(turn('turn', 'inProgress')), { now: 1 });
    const [entry] = updateCompletionObservation(data, 'thread', state(turn('turn', status, [
      { type: 'commandExecution', output: 'sensitive tool output' }, final('do not forward') ])), { now: 2 });
    assert.equal(entry.status, status);
    assert.equal(entry.summary, '');
    assert.ok(!JSON.stringify(data).includes('sensitive tool output'));
    assert.ok(!JSON.stringify(data).includes('do not forward'));
  }
});

test('canonical state chronology and final-only summaries work without serializing history', () => {
  const data = fresh();
  const canonical = (status, items) => ({
    turns: [],
    turnHistory: { kind: 'canonical', history: {
      entitiesByKey: { key: turn('turn', status, items), orphan: turn('orphan', 'inProgress') },
      islands: [{ entries: [{ value: 'key' }], newerBoundary: { status: 'exhausted' } }],
    } },
  });
  updateCompletionObservation(data, 'thread', canonical('inProgress', []), { now: 1 });
  const [entry] = updateCompletionObservation(data, 'thread', canonical('completed', [
    { type: 'reasoning', text: 'private reasoning' },
    { type: 'agentMessage', phase: 'commentary', text: 'private progress' },
    final('中'.repeat(400)),
  ]), { now: 2 });
  assert.equal(Array.from(entry.summary).length, 320);
  assert.equal(entry.summaryTruncated, true);
  assert.equal(Object.keys(data.turns).length, 1);
  assert.ok(!JSON.stringify(data).includes('private'));
});

test('thread-scoped keys keep identical turn IDs and attention outbox isolated', () => {
  const data = fresh();
  data.outbox.attention = { id: 'attention', kind: 'attention', deliveryStatus: 'pending' };
  for (const threadId of ['one', 'two']) {
    updateCompletionObservation(data, threadId, state(turn('same-turn', 'inProgress')), { now: 1 });
    updateCompletionObservation(data, threadId, state(turn('same-turn', 'completed', [final(threadId)])), { now: 2 });
  }
  assert.equal(Object.keys(data.outbox).length, 3);
  assert.equal(data.outbox[completionKey('one', 'same-turn')].summary, 'one');
  assert.equal(data.outbox[completionKey('two', 'same-turn')].summary, 'two');
  assert.equal(data.outbox.attention.id, 'attention');
  validateState(data);
});

test('malicious-looking answer text is persisted literally as data, never interpreted', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  const text = '$(Remove-Item everything); <script>execute()</script> __proto__';
  store.data.questions.q = { cardId: 'card', answer: text };
  await store.save(); await store.close();
  const reopened = await DurableState.open(filename);
  assert.equal(reopened.data.questions.q.answer, text);
  await reopened.close();
});

test('invalid UTF-8 inside JSON is treated as corruption and preserved', async (t) => {
  const { filename } = await fixture(t);
  const corrupt = Buffer.concat([
    Buffer.from('{"version":1,"questions":{"q":{"answer":"'),
    Buffer.from([0xff]),
    Buffer.from('"}},"turns":{},"outbox":{}}'),
  ]);
  await fs.writeFile(filename, corrupt);
  await assert.rejects(DurableState.open(filename), errorCode('CORRUPT_STATE'));
  assert.deepEqual(await fs.readFile(filename), corrupt);
});

test('unchanged saves preserve file identity and modification time after verifying disk state', async (t) => {
  const { filename, directory } = await fixture(t);
  const store = await DurableState.open(filename);
  await store.save();
  const sentinel = new Date('2001-01-01T00:00:00.000Z');
  await fs.utimes(filename, sentinel, sentinel);
  const before = await fs.stat(filename, { bigint: true });
  await Promise.all([store.save(), store.save(), store.save()]);
  const after = await fs.stat(filename, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
  store.data.questions.changed = { status: 'pending' };
  await store.save();
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).questions.changed.status, 'pending');
  assert.notEqual((await fs.stat(filename, { bigint: true })).mtimeNs, before.mtimeNs);
  await store.close();
});

test('unchanged in-memory state still detects and preserves external file changes', async (t) => {
  const { filename } = await fixture(t);
  const store = await DurableState.open(filename);
  await store.save();
  const external = 'external bytes must not be overwritten or silently accepted';
  await fs.writeFile(filename, external);
  await assert.rejects(store.save(), errorCode('STATE_CONFLICT'));
  await assert.rejects(store.close(), errorCode('STATE_CONFLICT'));
  assert.equal(await fs.readFile(filename, 'utf8'), external);
});
