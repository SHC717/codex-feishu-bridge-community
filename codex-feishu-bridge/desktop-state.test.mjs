import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyImmerPatches, createDesktopState, reduceDesktopState, extractDesktopQuestions,
} from './desktop-state.mjs';

const itemId = 'call_ujo6MzCT3bvj6DMSF49r1fAv';
const questionItemId = JSON.stringify(['request_user_input_async', itemId, 0]);
const questionItem = () => ({
  id: itemId, type: 'agentMessage', questions: [{
    title: '手机通知显示什么？', options: [{ label: '任务名称＋简短结果摘要（推荐）', description: '便于快速了解结果。' }],
  }, { title: '补充说明', options: [] }],
});
const replyText = (answer = '任务名称＋简短结果摘要（推荐）', extra = []) =>
  `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId, question: '手机通知显示什么？', answer }, ...extra])}\n</send_user_message_question_reply>`;
const steering = (id, status, answer) => ({
  id, type: 'steeringUserMessage', status, targetTurnId: 'turn-1',
  input: [{ type: 'text', text: replyText(answer), text_elements: [] }],
});
const stateWith = (...items) => ({
  turns: null, threadRuntimeStatus: { type: 'idle' },
  turnHistory: { history: { entitiesByKey: {
    'page:older': { items: [questionItem()] }, 'tail:current': { items },
  } } },
});
const snapshot = (state = stateWith(), value = 12) => reduceDesktopState(createDesktopState(), {
  type: 'snapshot', revision: value, conversationState: state,
});

test('Immer object/array add, remove, replace and root replacement preserve input', () => {
  const original = { a: [1, 3], b: { keep: true, gone: 1 } };
  const result = applyImmerPatches(original, [
    { op: 'add', path: ['a', 1], value: 2 },
    { op: 'replace', path: ['a', 0], value: 0 },
    { op: 'remove', path: ['a', 2] },
    { op: 'add', path: ['b', 'new'], value: { x: 7 } },
    { op: 'replace', path: ['b', 'keep'], value: false },
    { op: 'remove', path: ['b', 'gone'] },
  ]);
  assert.deepEqual(result, { a: [0, 2], b: { keep: false, new: { x: 7 } } });
  assert.deepEqual(original, { a: [1, 3], b: { keep: true, gone: 1 } });
  assert.deepEqual(applyImmerPatches(original, [{ op: 'replace', path: [], value: { root: [] } }]), { root: [] });
});

test('exact base revision required, rejection is atomic, resnapshot required to recover', () => {
  const first = snapshot();
  const wrong = reduceDesktopState(first, { type: 'patches', baseRevision: 11, revision: 13, patches: [] });
  assert.equal(wrong.lastError, 'base_revision_mismatch');
  assert.equal(wrong.needsResnapshot, true);
  assert.equal(wrong.revision, 12);
  assert.strictEqual(wrong.conversationState, first.conversationState);
  const blocked = reduceDesktopState(wrong, { type: 'patches', baseRevision: 12, revision: 13, patches: [] });
  assert.equal(blocked.lastError, 'snapshot_required');
  const recovered = reduceDesktopState(blocked, { type: 'snapshot', revision: 15, conversationState: stateWith() });
  assert.equal(recovered.needsResnapshot, false);
  const updated = reduceDesktopState(recovered, {
    type: 'patches', baseRevision: 15, revision: 17,
    patches: [{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'active' }],
  });
  assert.equal(updated.revision, 17);
  assert.equal(updated.conversationState.threadRuntimeStatus.type, 'active');
  assert.equal(recovered.conversationState.threadRuntimeStatus.type, 'idle');
  assert.equal(reduceDesktopState(updated, { type: 'patches', baseRevision: 17, revision: 17, patches: [] }).lastError, 'non_increasing_revision');
  assert.equal(reduceDesktopState(updated, { type: 'snapshot', revision: 16, conversationState: {} }).lastError, 'stale_snapshot');
});

test('all patches validate atomically and never follow inherited/prototype paths', () => {
  const first = snapshot({ list: [0], normal: {} });
  for (const path of [
    ['__proto__', 'polluted'], ['normal', 'constructor', 'prototype', 'polluted'],
    ['normal', 'prototype'], ['toString', 'polluted'], ['list', -1],
    ['list', '0'], ['list', '-'], ['list', 4], 'normal',
  ]) {
    const next = reduceDesktopState(first, {
      type: 'patches', baseRevision: 12, revision: 13,
      patches: [{ op: 'replace', path: ['list', 0], value: 42 }, { op: 'add', path, value: true }],
    });
    assert.equal(next.needsResnapshot, true);
    assert.deepEqual(next.conversationState, { list: [0], normal: {} });
  }
  assert.equal(Object.prototype.polluted, undefined);
  assert.throws(() => applyImmerPatches({}, [{ op: 'add', path: ['x'], value: JSON.parse('{"__proto__":{"polluted":true}}') }]));
  assert.throws(() => applyImmerPatches({}, [{ op: 'replace', path: ['missing'], value: 1 }]));
  assert.throws(() => applyImmerPatches({}, [{ op: 'remove', path: ['missing'] }]));
  assert.throws(() => applyImmerPatches({}, [{ op: 'remove', path: [] }]));
});

test('questions use indexed IDs, include all history entities and permit free text', () => {
  const state = stateWith();
  state.turns = [{ id: 'turn-live', items: [{ id: 'second', type: 'agentMessage', questions: [{ title: '其他任务', options: ['A'] }] }] }];
  const output = extractDesktopQuestions(state);
  assert.equal(output.questions.length, 3);
  const found = output.questions.find((question) => question.questionItemId === questionItemId);
  assert.equal(found.title, '手机通知显示什么？');
  assert.deepEqual(found.options, questionItem().questions[0].options);
  assert.equal(found.allowsFreeText, true);
  assert.equal(found.status, 'unanswered');
  assert.equal(found.submissionAllowed, false);
  assert.ok(output.questions.some((question) => question.questionItemId === JSON.stringify(['request_user_input_async', itemId, 1])));
});

test('pending steering is separately listed; desktop accepted patch establishes an answer', () => {
  const first = snapshot(stateWith(steering('reply-1', 'pending')));
  const initial = extractDesktopQuestions(first.conversationState);
  assert.equal(initial.questions[0].status, 'pending');
  assert.equal(initial.questions[0].answer, null);
  assert.equal(initial.questions[0].submissionAllowed, false);
  assert.equal(initial.pendingReplies.length, 1);
  const second = reduceDesktopState(first, {
    type: 'patches', baseRevision: 12, revision: 13,
    patches: [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'tail:current', 'items', 0, 'status'], value: 'accepted' }],
  });
  const updated = extractDesktopQuestions(second.conversationState);
  assert.equal(updated.questions[0].status, 'answered');
  assert.equal(updated.questions[0].answer, '任务名称＋简短结果摘要（推荐）');
  assert.equal(updated.pendingReplies.length, 0);
  assert.equal(extractDesktopQuestions(first.conversationState).questions[0].status, 'pending');
});

test('expired/rejected/unknown steering and idle/completed turn do not imply an answer or expiry', () => {
  for (const status of ['expired', 'rejected', 'cancelled', 'unknown', null]) {
    const state = stateWith(steering('reply-expired', status));
    state.turns = [{ id: 'turn-1', status: 'completed', items: [] }];
    const output = extractDesktopQuestions(state);
    assert.equal(output.questions[0].status, 'unanswered');
    assert.equal(output.questions[0].answer, null);
    assert.equal(output.questions[0].submissionAllowed, false);
    assert.equal(output.ignoredReplies.length, 1);
    assert.equal(output.questions[0].acceptedReplies.length, 0);
  }
});

test('ordinary user reply is accepted; no parsing assistant reasoning, command or tool text', () => {
  const excluded = ['agentMessage', 'reasoning', 'commandExecution', 'tool', 'toolOutput', 'function_call_output'];
  const onlyExcluded = stateWith(...excluded.map((type, index) => ({ id: `excluded-${index}`, type, input: [{ type: 'text', text: replyText('do not accept') }], text: replyText('do not accept') })));
  assert.equal(extractDesktopQuestions(onlyExcluded).questions[0].status, 'unanswered');
  const user = { id: 'user-1', type: 'userMessage', input: [{ type: 'text', text: replyText('我的自由文字') }] };
  const output = extractDesktopQuestions(stateWith(user));
  assert.equal(output.questions[0].status, 'answered');
  assert.equal(output.questions[0].answer, '我的自由文字');
  const quoted = { ...user, id: 'quoted', input: [{ type: 'text', text: `Example: ${replyText()}` }] };
  assert.equal(extractDesktopQuestions(stateWith(quoted)).questions[0].status, 'unanswered');
});

test('two accepted items for the same question conflict, including identical answer text', () => {
  for (const answer of ['same', 'different']) {
    const output = extractDesktopQuestions(stateWith(steering('r1', 'accepted', 'same'), steering('r2', 'accepted', answer)));
    assert.equal(output.questions[0].status, 'conflict');
    assert.equal(output.questions[0].acceptedReplies.length, 2);
    assert.equal(output.questions[0].answer, null);
    assert.equal(output.questions[0].submissionAllowed, false);
  }
  const repeated = steering('r1', 'accepted');
  repeated.input[0].text = replyText('first', [{ questionItemId, question: '手机通知显示什么？', answer: 'first' }]);
  assert.equal(extractDesktopQuestions(stateWith(repeated)).questions[0].status, 'conflict');
});

test('an explicitly identical mirrored item is one item, conflicting same-ID data is blocked', () => {
  const answer = steering('r1', 'accepted', 'same');
  const state = stateWith(answer);
  state.turns = [{ id: 'turn-1', items: [structuredClone(questionItem()), structuredClone(answer)] }];
  const mirrored = extractDesktopQuestions(state);
  assert.equal(mirrored.questions.length, 2);
  assert.equal(mirrored.questions[0].acceptedReplies.length, 1);
  assert.equal(mirrored.questions[0].sourcePaths.length, 2);
  assert.equal(mirrored.questions[0].status, 'answered');
  state.turns[0].items[1] = steering('r1', 'pending', 'other');
  const inconsistent = extractDesktopQuestions(state);
  assert.equal(inconsistent.questions[0].status, 'conflict');
  assert.equal(inconsistent.pendingReplies.length, 1);
});

test('malformed and unknown replies do not match by question title or leak into answer state', () => {
  const unknown = steering('unknown', 'accepted');
  unknown.input[0].text = replyText().replace(itemId, 'another-item');
  const invalid = steering('invalid', 'accepted');
  invalid.input[0].text = '<send_user_message_question_reply>not JSON</send_user_message_question_reply>';
  const output = extractDesktopQuestions(stateWith(unknown, invalid));
  assert.equal(output.questions[0].status, 'unanswered');
  assert.equal(output.orphanReplies.length, 1);
  assert.equal(output.issues[0].code, 'invalid_reply_json');
});

test('snapshots and projected data are detached from their inputs', () => {
  const source = stateWith(steering('accepted', 'accepted', 'free text'));
  const reduced = snapshot(source);
  const projection = extractDesktopQuestions(reduced.conversationState);
  projection.questions[0].options[0].label = 'changed';
  source.turnHistory.history.entitiesByKey['page:older'].items[0].questions[0].title = 'changed';
  assert.equal(extractDesktopQuestions(reduced.conversationState).questions[0].title, '手机通知显示什么？');
  assert.equal(extractDesktopQuestions(reduced.conversationState).questions[0].options[0].label, '任务名称＋简短结果摘要（推荐）');
});

test('reply input must be exactly one text item and all three reply fields must be strings', () => {
  const completeText = { type: 'text', text: replyText() };
  for (const input of [
    [completeText, { type: 'text', text: '' }],
    [completeText, { type: 'image', image_url: 'data:example' }],
    [{ type: 'text', text: '<send_user_message_question_reply>' },
      { type: 'text', text: JSON.stringify([{ questionItemId, question: '问题', answer: '答案' }]) },
      { type: 'text', text: '</send_user_message_question_reply>' }],
  ]) {
    const item = { ...steering('multiple-inputs', 'accepted'), input };
    assert.equal(extractDesktopQuestions(stateWith(item)).questions[0].status, 'unanswered');
  }
  const valid = { questionItemId, question: '问题', answer: '答案' };
  for (const field of ['questionItemId', 'question', 'answer']) {
    for (const replacement of [undefined, null, 123]) {
      const reply = { ...valid, [field]: replacement };
      const item = steering('invalid-field', 'accepted');
      item.input[0].text = `<send_user_message_question_reply>${JSON.stringify([reply])}</send_user_message_question_reply>`;
      const output = extractDesktopQuestions(stateWith(item));
      assert.equal(output.questions[0].status, 'unanswered');
      assert.equal(output.issues[0].code, 'invalid_reply');
    }
  }
});
