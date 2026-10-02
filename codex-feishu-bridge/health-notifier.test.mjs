import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthNotifier } from './health-notifier.mjs';

function harness(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-health-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'health.json');
  const sent = [], urgent = [], events = [], delivered = new Map();
  let time = 0;
  const options = { file, urgentEnabled: true, now: () => time, graceMs: 120_000, retryMs: 60_000,
    sendCard: async (card, key) => {
      sent.push({ card, key });
      if (!delivered.has(key)) delivered.set(key, `message-${delivered.size + 1}`);
      return delivered.get(key);
    },
    urgentCard: async id => { urgent.push(id); },
    emit: (event, value) => events.push({ event, ...value }), ...overrides };
  return { file, options, sent, urgent, events, delivered,
    clock: value => { time = value; }, notifier: () => new HealthNotifier(options),
    state: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const failing = { healthy: false };
const immediate = { healthy: false, immediate: true, reason: 'protocol_incompatible' };
const healthy = { healthy: true };

test('initial health is silent and creates no state file', async t => {
  const h = harness(t), notifier = h.notifier();
  assert.equal((await notifier.tick(healthy)).phase, 'healthy');
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.sent.length, 0);
});

test('persistent failure waits exactly two minutes and sends one urgent message', async t => {
  const h = harness(t), notifier = h.notifier();
  await notifier.tick(failing);
  h.clock(119_999); await notifier.tick(failing);
  assert.equal(h.sent.length, 0);
  h.clock(120_000); await notifier.tick(failing);
  assert.equal(h.sent.length, 1); assert.equal(h.urgent.length, 1);
  assert.equal(h.sent[0].card.header.title.content, '飞书桥连接异常');
  assert.equal(h.sent[0].card.schema, '2.0');
  assert.match(h.sent[0].card.body.elements[0].content, /自动重试/);
  assert.match(h.sent[0].key, /^[a-f\d-]{36}$/);
  h.clock(500_000); await notifier.tick(failing);
  assert.equal(h.sent.length, 1);
  assert.equal(notifier.status().phase, 'fault_notified');
});

test('short outage disappears without a fault or recovery message', async t => {
  const h = harness(t), notifier = h.notifier();
  await notifier.tick(failing);
  h.clock(60_000); await notifier.tick(healthy);
  assert.equal(h.state().incident, null);
  h.clock(120_000); await notifier.tick(healthy);
  assert.equal(h.sent.length, 0);
});

test('explicit incompatibility bypasses the delay including at timestamp zero', async t => {
  const h = harness(t), notifier = h.notifier();
  await notifier.tick(immediate);
  assert.equal(h.sent.length, 1);
  assert.equal(h.state().incident.alert.attemptedAt, 0);
  assert.match(h.sent[0].card.body.elements[0].content, /实际接口暂不兼容/);
});

test('a waiting transient incident becomes immediately actionable for incompatible protocol', async t => {
  const h = harness(t), notifier = h.notifier();
  await notifier.tick(failing);
  h.clock(10_000); await notifier.tick(immediate);
  assert.equal(h.sent.length, 1);
  assert.equal(h.state().incident.startedAt, 0);
  assert.equal(h.state().incident.reason, 'protocol_incompatible');
});

test('unknown reasons and private details never enter cards, state, or logs', async t => {
  const h = harness(t), notifier = h.notifier();
  await notifier.tick({ ...immediate, reason: 'PRIVATE_PATH secret-token',
    details: { codexVersion: '26.930.2377.0', knownTasks: 3, pendingQuestions: 'PRIVATE',
      token: 'PRIVATE', taskTitle: 'PRIVATE', error: 'PRIVATE' } });
  assert.equal(h.state().incident.reason, 'connection_unavailable');
  assert.deepEqual(h.state().incident.details, { codexVersion: '26.930.2377.0', knownTasks: 3 });
  assert.doesNotMatch(JSON.stringify([h.sent, h.state(), h.events]), /PRIVATE|secret-token/);
  assert.doesNotMatch(JSON.stringify(h.events), /message-1|26\.930/);
});

test('all fixed reasons have safe localized explanations', async t => {
  const h = harness(t);
  for (const reason of ['codex_unavailable', 'identity_verification_failed', 'metadata_incompatible',
    'metadata_unavailable', 'listener_unavailable', 'state_unavailable', 'worker_unavailable']) {
    const notifier = new HealthNotifier({ ...h.options, file: `${h.file}.${reason}` });
    await notifier.tick({ ...immediate, reason });
    assert.equal(notifier.status().reason, reason);
    assert.doesNotMatch(h.sent.at(-1).card.body.elements[0].content, new RegExp(reason));
  }
});

test('restart continues the original two-minute timer', async t => {
  const h = harness(t);
  await h.notifier().tick(failing);
  h.clock(119_000); await h.notifier().tick(failing);
  assert.equal(h.sent.length, 0);
  h.clock(120_000); await h.notifier().tick(failing);
  assert.equal(h.sent.length, 1);
});

test('restart never repeats a delivered fault and sends only one recovery', async t => {
  const h = harness(t);
  await h.notifier().tick(immediate);
  h.clock(200_000); await h.notifier().tick(failing);
  assert.equal(h.sent.length, 1);
  await h.notifier().tick(healthy);
  assert.equal(h.sent.length, 2); assert.equal(h.urgent.length, 2);
  assert.equal(h.sent[1].card.header.title.content, '飞书桥已恢复');
  assert.equal(h.state().incident, null);
  await h.notifier().tick(healthy);
  assert.equal(h.sent.length, 2);
});

test('failed send persists intent and retries the same UUID after its deadline', async t => {
  const h = harness(t);
  const send = h.options.sendCard;
  let failures = 1;
  h.options.sendCard = async (...args) => {
    const receipt = await send(...args);
    if (failures-- > 0) throw new Error('secret transport body');
    return receipt;
  };
  await h.notifier().tick(immediate);
  assert.equal(h.state().incident.alert.messageId, null);
  h.clock(59_999); await h.notifier().tick(failing);
  assert.equal(h.sent.length, 1);
  h.clock(60_000); await h.notifier().tick(failing);
  assert.equal(h.sent.length, 2); assert.equal(h.delivered.size, 1);
  assert.equal(h.sent[0].key, h.sent[1].key);
  assert.deepEqual(h.sent[0].card, h.sent[1].card);
  assert.equal(h.urgent.length, 1);
  assert.doesNotMatch(JSON.stringify(h.events), /secret/);
});

test('fault send intent is on disk before the transport is called', async t => {
  const h = harness(t);
  h.options.sendCard = async (_card, key) => {
    const state = h.state();
    assert.equal(state.incident.alert.id, key);
    assert.equal(state.incident.alert.attemptedAt, 0);
    assert.equal(state.incident.alert.retryAt, 60_000);
    return 'receipt';
  };
  await h.notifier().tick(immediate);
});

test('urgency failure never recreates a card and receipt is persisted before urgency', async t => {
  const h = harness(t);
  let calls = 0;
  h.options.urgentCard = async id => {
    assert.equal(h.state().incident.alert.messageId, id);
    h.urgent.push(id);
    if (calls++ === 0) throw new Error('unavailable');
  };
  await h.notifier().tick(immediate);
  h.clock(60_000); await h.notifier().tick(failing);
  assert.equal(h.sent.length, 1); assert.equal(h.urgent.length, 2);
  assert.equal(h.state().incident.alert.urgent, true);
});

test('unknown delivery outcome is resolved before the recovery card is sent', async t => {
  const h = harness(t);
  const send = h.options.sendCard;
  let calls = 0;
  h.options.sendCard = async (...args) => {
    const receipt = await send(...args);
    if (calls++ === 0) throw new Error('received but reply lost');
    return receipt;
  };
  await h.notifier().tick(immediate);
  h.clock(10_000); await h.notifier().tick(healthy);
  assert.equal(h.sent.length, 1);
  assert.equal(h.state().incident.recovery.attemptedAt, null);
  h.clock(60_000); await h.notifier().tick(healthy);
  assert.equal(h.sent.length, 3); assert.equal(h.delivered.size, 2);
  assert.equal(h.sent[0].key, h.sent[1].key);
  assert.equal(h.sent[2].card.header.title.content, '飞书桥已恢复');
  assert.equal(h.state().incident, null);
});

test('continuing network failure holds recovery until both prior send and urgency succeed', async t => {
  const h = harness(t);
  const urgent = h.options.urgentCard;
  let offline = true;
  h.options.urgentCard = async id => { if (offline) throw new Error('network'); await urgent(id); };
  await h.notifier().tick(immediate);
  h.clock(60_000); await h.notifier().tick(healthy);
  assert.equal(h.sent.length, 1);
  assert.equal(h.state().incident.recovery.attemptedAt, null);
  offline = false;
  h.clock(120_000); await h.notifier().tick(healthy);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.urgent, ['message-1', 'message-2']);
});

test('uncertain recovery send is resumed with the same UUID after restart', async t => {
  const h = harness(t);
  const send = h.options.sendCard;
  let recoveryFailed = false;
  h.options.sendCard = async (...args) => {
    const receipt = await send(...args);
    if (args[0].header.title.content === '飞书桥已恢复' && !recoveryFailed) {
      recoveryFailed = true; throw new Error('reply lost');
    }
    return receipt;
  };
  await h.notifier().tick(immediate);
  h.clock(10_000); await h.notifier().tick(healthy);
  h.clock(70_000); await h.notifier().tick(healthy);
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[1].key, h.sent[2].key);
  assert.deepEqual(h.sent[1].card, h.sent[2].card);
  assert.equal(h.delivered.size, 2);
  assert.equal(h.state().incident, null);
});

test('failure flapping before recovery is attempted keeps the original incident', async t => {
  const h = harness(t);
  const urgent = h.options.urgentCard;
  let fail = true;
  h.options.urgentCard = async id => { if (fail) throw new Error('offline'); await urgent(id); };
  const notifier = h.notifier();
  await notifier.tick(immediate);
  h.clock(10_000); await notifier.tick(healthy);
  assert.notEqual(h.state().incident.recovery, null);
  h.clock(20_000); await notifier.tick(failing);
  assert.equal(h.state().incident.recovery, null);
  fail = false;
  h.clock(60_000); await notifier.tick(failing);
  assert.equal(h.sent.length, 1);
  assert.equal(notifier.status().phase, 'fault_notified');
});

test('relapse after a recovery send attempt retains both events in chronological order', async t => {
  const h = harness(t);
  const send = h.options.sendCard;
  let fail = true;
  h.options.sendCard = async (...args) => {
    const receipt = await send(...args);
    if (args[0].header.title.content === '飞书桥已恢复' && fail) throw new Error('offline');
    return receipt;
  };
  await h.notifier().tick(immediate);
  h.clock(10_000); await h.notifier().tick(healthy);
  h.clock(20_000); await h.notifier().tick({ healthy: false, reason: 'worker_unavailable' });
  assert.equal(h.state().incident.followup.startedAt, 20_000);
  fail = false;
  h.clock(150_000); await h.notifier().tick(failing);
  assert.equal(h.delivered.size, 3);
  assert.equal(h.sent.at(-1).card.header.title.content, '飞书桥连接异常');
  assert.equal(h.state().incident.startedAt, 20_000);
  assert.equal(h.state().incident.reason, 'worker_unavailable');
  assert.equal(h.state().incident.recovery, null);
});

test('concurrent ticks serialize transport and share one fault UUID', async t => {
  const h = harness(t);
  const send = h.options.sendCard;
  let active = 0, maximum = 0;
  h.options.sendCard = async (...args) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    const receipt = await send(...args); active--; return receipt;
  };
  const notifier = h.notifier();
  await Promise.all(Array.from({ length: 5 }, () => notifier.tick(immediate)));
  assert.equal(maximum, 1); assert.equal(h.sent.length, 1);
});

test('invalid JSON and unsupported schemas fail closed without overwriting original', t => {
  const h = harness(t);
  for (const bytes of ['bad json', '{"version":2,"incident":null}', '{"version":1,"incident":{}}']) {
    fs.writeFileSync(h.file, bytes);
    assert.throws(() => h.notifier(), { code: 'HEALTH_STATE_INVALID' });
    assert.equal(fs.readFileSync(h.file, 'utf8'), bytes);
  }
  assert.equal(h.sent.length, 0);
});

test('external state edits poison an instance before any network call', async t => {
  const h = harness(t), notifier = h.notifier();
  fs.writeFileSync(h.file, '{"version":1,"incident":null}\n');
  await assert.rejects(notifier.tick(immediate), { code: 'HEALTH_STATE_CONFLICT' });
  assert.equal(h.sent.length, 0);
  assert.equal(notifier.status().phase, 'state_error');
  await assert.rejects(notifier.tick(healthy), { code: 'HEALTH_STATE_CONFLICT' });
  assert.equal(h.state().incident, null);
});

test('state directories and oversized files are rejected', t => {
  const h = harness(t);
  fs.mkdirSync(h.file);
  assert.throws(() => h.notifier(), { code: 'HEALTH_STATE_PATH' });
  fs.rmdirSync(h.file);
  fs.writeFileSync(h.file, 'x'.repeat(65_537));
  assert.throws(() => h.notifier(), { code: 'HEALTH_STATE_PATH' });
});

test('bad receipt is retried without marking a false delivery', async t => {
  const h = harness(t, { sendCard: async () => undefined });
  const notifier = h.notifier();
  await notifier.tick(immediate);
  assert.equal(notifier.status().faultDelivered, false);
  assert.equal(h.state().incident.alert.messageId, null);
  assert.equal(h.urgent.length, 0);
});

test('new incidents after completed recovery receive fresh message UUIDs', async t => {
  const h = harness(t), notifier = h.notifier();
  await notifier.tick(immediate);
  h.clock(1000); await notifier.tick(healthy);
  h.clock(2000); await notifier.tick(immediate);
  assert.equal(new Set(h.sent.map(item => item.key)).size, 3);
});

test('invalid input does not poison valid subsequent observations', async t => {
  const h = harness(t), notifier = h.notifier();
  await assert.rejects(notifier.tick({ healthy: 'yes' }), { code: 'HEALTH_OBSERVATION_INVALID' });
  await notifier.tick(immediate);
  assert.equal(h.sent.length, 1);
});


test('a generic startup failure is upgraded to a specific diagnosis before its first send', async t => {
  const h = harness(t), notifier = h.notifier();
  await notifier.tick({ healthy: false, reason: 'worker_unavailable' });
  h.clock(1000); await notifier.tick({ healthy: false, reason: 'metadata_unavailable',
    details: { codexVersion: '26.930.2377.0' } });
  h.clock(2000); await notifier.tick({ healthy: false, reason: 'worker_unavailable' });
  h.clock(120_000); await notifier.tick(failing);
  assert.equal(h.state().incident.startedAt, 0);
  assert.equal(h.state().incident.reason, 'metadata_unavailable');
  assert.match(h.sent[0].card.body.elements[0].content, /任务清单/);
  assert.match(h.sent[0].card.body.elements[0].content, /26\.930\.2377\.0/);
});

test('a persisted card payload remains identical after an uncertain send despite a newer diagnosis', async t => {
  const h = harness(t);
  const send = h.options.sendCard;
  let fail = true;
  h.options.sendCard = async (...args) => {
    const receipt = await send(...args);
    if (fail) { fail = false; throw new Error('reply lost'); }
    return receipt;
  };
  await h.notifier().tick({ healthy: false, immediate: true, reason: 'worker_unavailable' });
  h.clock(60_000); await h.notifier().tick(immediate);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[0], h.sent[1]);
});

test('invalid persisted dates are rejected before any sending', async t => {
  const h = harness(t);
  await h.notifier().tick(failing);
  const state = h.state();
  state.incident.startedAt = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(h.file, JSON.stringify(state));
  assert.throws(() => h.notifier(), { code: 'HEALTH_STATE_INVALID' });
  assert.equal(h.sent.length, 0);
});


test('normal default delivers fault and recovery once without urgency and survives reopen',async t=>{
 const h=harness(t);delete h.options.urgentEnabled;let notifier=h.notifier();
 await notifier.tick(immediate);assert.equal(h.sent.length,1);assert.equal(h.urgent.length,0);
 assert.equal(notifier.status().faultDelivered,true);assert.equal(h.state().incident.alert.urgent,false);
 notifier=h.notifier();await notifier.tick(immediate);assert.equal(h.sent.length,1);
 await notifier.tick(healthy);assert.equal(h.sent.length,2);assert.equal(h.urgent.length,0);assert.equal(notifier.status().active,false);
 notifier=h.notifier();await notifier.tick(healthy);assert.equal(h.sent.length,2);
});

test('normal mode accepts existing card receipt and cancels an old pending urgent retry',async t=>{
 const h=harness(t);let attempts=0;h.options.urgentCard=async()=>{attempts++;throw Error('temporary');};
 let notifier=h.notifier();await notifier.tick(immediate);assert.equal(attempts,1);assert.equal(h.sent.length,1);
 assert.equal(notifier.status().faultDelivered,false);h.options.urgentEnabled=false;notifier=h.notifier();
 await notifier.tick(immediate);assert.equal(notifier.status().faultDelivered,true);assert.equal(attempts,1);assert.equal(h.sent.length,1);
 await notifier.tick(healthy);assert.equal(h.sent.length,2);assert.equal(attempts,1);assert.equal(notifier.status().active,false);
});
