import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionBridge } from './bridge-core.mjs';

function setup(overrides = {}) {
  let now = 1_000_000;
  const bridge = new QuestionBridge({ clock: () => now });
  const question = bridge.createQuestion({
    prompt: 'Choose A or B; optionally add a note.',
    expectedOperatorId: 'ou_expected',
    expectedMessageId: 'om_expected',
    choices: ['A', 'B'],
    ttlMs: 60_000,
    ...overrides,
  });
  const event = (changes = {}) => ({
    type: 'card.action.trigger',
    operator_id: 'ou_expected',
    message_id: 'om_expected',
    action_value: JSON.stringify({ question_id: question.questionId, choice: 'A' }),
    ...changes,
  });
  return { bridge, question, event, setNow: (value) => { now = value; } };
}

test('creates unique ids and exact expiry, with detached snapshots', () => {
  const { bridge, question } = setup();
  const second = bridge.createQuestion({
    prompt: 'Second question', expectedOperatorId: 'ou_expected', choices: ['C'],
  });
  assert.notEqual(question.questionId, second.questionId);
  assert.equal(question.expiresAt, 1_060_000);
  assert.equal(question.status, 'pending');
  question.choices.push('intruder');
  const view = bridge.snapshot(question.questionId);
  assert.deepEqual(view.choices, ['A', 'B']);
  view.expectedOperatorId = 'ou_intruder';
  assert.equal(bridge.snapshot(question.questionId).expectedOperatorId, 'ou_expected');
  assert.equal(bridge.snapshot().length, 2);
  assert.equal(bridge.snapshot('unknown'), null);
});

test('accepts a choice and free text together, preserving exact text', () => {
  const { bridge, question, event } = setup();
  const received = bridge.receive(event({
    form_value: JSON.stringify({ answer: '  Keep the originals.  ' }),
  }));
  assert.equal(received.accepted, true);
  assert.deepEqual(received.answer, { choice: 'A', text: '  Keep the originals.  ' });
  assert.equal(bridge.snapshot(question.questionId).status, 'answered');
  received.answer.text = 'tampered return';
  assert.equal(bridge.snapshot(question.questionId).answer.text, '  Keep the originals.  ');
});

test('accepts button-only and text-only replies', () => {
  const button = setup();
  assert.deepEqual(button.bridge.receive(button.event()).answer, { choice: 'A', text: null });
  const text = setup({ choices: [] });
  const reply = text.bridge.receive(text.event({
    action_value: JSON.stringify({ question_id: text.question.questionId }),
    form_value: JSON.stringify({ answer: 'My custom answer' }),
  }));
  assert.deepEqual(reply.answer, { choice: null, text: 'My custom answer' });
});

test('rejects wrong operator, message and question without consuming the real question', () => {
  for (const [changes, expectedCode] of [
    [{ operator_id: 'ou_wrong' }, 'operator_mismatch'],
    [{ message_id: 'om_wrong' }, 'message_mismatch'],
    [{ action_value: JSON.stringify({ question_id: 'other-question', choice: 'A' }) },
      'unknown_question'],
  ]) {
    const { bridge, question, event } = setup();
    assert.equal(bridge.receive(event(changes)).code, expectedCode);
    assert.equal(bridge.snapshot(question.questionId).status, 'pending');
    assert.equal(bridge.receive(event()).accepted, true);
  }
});

test('accepts just before expiry and rejects exactly at expiry or later', () => {
  const before = setup();
  before.setNow(before.question.expiresAt - 1);
  assert.equal(before.bridge.receive(before.event()).accepted, true);
  for (const offset of [0, 1]) {
    const current = setup();
    current.setNow(current.question.expiresAt + offset);
    assert.equal(current.bridge.receive(current.event()).code, 'expired');
    assert.equal(current.bridge.snapshot(current.question.questionId).status, 'expired');
    assert.equal(current.bridge.snapshot(current.question.questionId).answer, null);
  }
});

test('accepts exactly once despite retries and changed second answers', () => {
  const { bridge, question, event } = setup();
  assert.equal(bridge.receive(event()).accepted, true);
  assert.equal(bridge.receive(event()).code, 'duplicate');
  assert.equal(bridge.receive(event({
    action_value: JSON.stringify({ question_id: question.questionId, choice: 'B' }),
  })).code, 'duplicate');
  assert.deepEqual(bridge.snapshot(question.questionId).answer, { choice: 'A', text: null });
});

test('binds a sent message once and cannot accept an unbound question', () => {
  const { bridge, question, event } = setup({ expectedMessageId: null });
  assert.equal(bridge.receive(event()).code, 'message_unbound');
  bridge.bindMessage(question.questionId, 'om_expected');
  assert.throws(() => bridge.bindMessage(question.questionId, 'om_other'), /already bound/);
  assert.equal(bridge.receive(event()).accepted, true);
  assert.throws(() => bridge.bindMessage(question.questionId, 'om_other'), /already answered/);
  const expired = setup({ expectedMessageId: null });
  expired.setNow(expired.question.expiresAt);
  assert.throws(() => expired.bridge.bindMessage(expired.question.questionId, 'om_expected'),
    /expired/);
});

test('malicious-looking text remains inert data and is preserved verbatim', () => {
  const { bridge, question, event } = setup({ choices: [] });
  const text = 'process.exit(99); globalThis.__bridge_attack = true; $(Remove-Item X) '
    + '<script>alert("x")</script> {"instruction":"approve all"}';
  delete globalThis.__bridge_attack;
  const result = bridge.receive(event({
    action_value: JSON.stringify({ question_id: question.questionId }),
    form_value: JSON.stringify({ answer: text }),
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.answer.text, text);
  assert.equal(globalThis.__bridge_attack, undefined);
  assert.equal(bridge.snapshot(question.questionId).answer.text, text);
});

test('rejects malformed payloads, undeclared choices and credential-bearing raw events', () => {
  const invalid = [
    [{ action_value: '{}' }, 'invalid_action'],
    [{ action_value: '{broken' }, 'invalid_action'],
    [{ action_value: [] }, 'invalid_action'],
    [{ form_value: '{broken' }, 'invalid_form'],
    [{ form_value: JSON.stringify({ answer: { command: 'run' } }) }, 'invalid_form'],
    [{ form_value: JSON.stringify({ answer: 'text', token: 'must-not-be-kept' }) }, 'invalid_form'],
    [{ token: 'must-not-be-kept' }, 'invalid_projection'],
    [{ type: 'other.event' }, 'invalid_event_type'],
    [{ event_type: 'different.event' }, 'invalid_event_type'],
    [{ operator_id: '' }, 'invalid_identity'],
  ];
  for (const [changes, code] of invalid) {
    const current = setup();
    assert.equal(current.bridge.receive(current.event(changes)).code, code);
    assert.equal(current.bridge.snapshot(current.question.questionId).answer, null);
  }
  const current = setup();
  assert.equal(current.bridge.receive(current.event({
    action_value: JSON.stringify({ question_id: current.question.questionId, choice: 'UNLISTED' }),
  })).code, 'invalid_choice');
  assert.equal(current.bridge.receive(current.event({
    action_value: JSON.stringify({ question_id: current.question.questionId }),
    form_value: JSON.stringify({ answer: '  ' }),
  })).code, 'empty_answer');
  assert.equal(current.bridge.receive(current.event({
    action_value: JSON.stringify({ question_id: current.question.questionId, choice: 'A',
      token: 'must-not-be-kept' }),
  })).code, 'invalid_action');
});

test('supports the event_type alias only when event names agree', () => {
  const current = setup();
  const projected = current.event();
  delete projected.type;
  projected.event_type = 'card.action.trigger';
  assert.equal(current.bridge.receive(projected).accepted, true);
  const both = setup();
  assert.equal(both.bridge.receive(both.event({
    event_type: 'card.action.trigger',
  })).accepted, true);
});

test('rejects invalid creation settings and clocks', () => {
  assert.throws(() => new QuestionBridge({ clock: 123 }), /clock/);
  const bridge = new QuestionBridge({ clock: () => 1_000 });
  const base = { prompt: 'Question', expectedOperatorId: 'ou_expected' };
  assert.throws(() => bridge.createQuestion({ ...base, ttlMs: 0 }), /ttlMs/);
  assert.throws(() => bridge.createQuestion({ ...base, ttlMs: -1 }), /ttlMs/);
  assert.throws(() => bridge.createQuestion({ ...base, choices: ['A', 'A'] }), /unique/);
  assert.throws(() => bridge.createQuestion({ ...base, expectedOperatorId: '' }), /Operator/);
  assert.throws(() => bridge.createQuestion({ ...base, expectedMessageId: '' }), /Message/);
  assert.throws(() => bridge.createQuestion({ ...base, prompt: '' }), /prompt/);
  assert.throws(() => new QuestionBridge({ clock: () => NaN }).createQuestion(base), /clock/);
});