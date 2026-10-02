import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GlobalDesktopWatcher } from './global-desktop-watcher.mjs';
import {
  DesktopIpcClient, FrameDecoder, encodeFrame, MAX_FRAME_BYTES, DEFAULT_PIPE_PATH,
} from './desktop-ipc-client.mjs';

// Tests inject an in-memory socket. No real named pipe, network or desktop access.
class FakeSocket extends EventEmitter {
  sent = [];
  ended = false;
  destroyed = false;
  onMessage = null;
  decoder = new FrameDecoder((message) => {
    this.sent.push(message);
    this.onMessage?.(message);
  });
  write(frame) { this.decoder.push(frame); return true; }
  receive(message) { this.emit('data', encodeFrame(message)); }
  end() { this.ended = true; queueMicrotask(() => this.emit('close')); }
  destroy(error) {
    this.destroyed = true;
    queueMicrotask(() => { if (error) this.emit('error', error); this.emit('close'); });
  }
}

async function fixture(t, onMessage = null) {
  const socket = new FakeSocket();
  let endpoint;
  const client = new DesktopIpcClient({ createConnection: (options) => {
    endpoint = options;
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  } });
  socket.onMessage = (message) => {
    if (message.type === 'request' && message.method === 'initialize') {
      queueMicrotask(() => socket.receive({ type: 'response', requestId: message.requestId,
        resultType: 'success', result: { clientId: 'probe-1' } }));
    } else if (message.type === 'request' && message.method === 'thread-owner-discovery') {
      queueMicrotask(() => socket.receive({ type: 'response', requestId: message.requestId,
        resultType: 'success', handledByClientId: 'owner-1', result: { supportsUntrustedAppInput: true } }));
    } else onMessage?.(message, socket);
  };
  t.after(() => client.close());
  await client.connect();
  const initialized = await client.initialize();
  return { client, socket, initialized, endpoint };
}

function stateMessage(overrides = {}) {
  return { type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    sourceClientId: 'owner-1', targetClientIds: ['probe-1'],
    params: { hostId: 'local', conversationId: 'thread-1',
      change: { type: 'snapshot', revision: 1, conversationState: {} } }, ...overrides };
}

test('4-byte little-endian framing handles fragmented Unicode and multiple frames', () => {
  const messages = [];
  const decoder = new FrameDecoder((message) => messages.push(message));
  const first = encodeFrame({ text: '中文测试' });
  assert.equal(first.readUInt32LE(0), Buffer.byteLength(JSON.stringify({ text: '中文测试' })));
  const combined = Buffer.concat([first, encodeFrame({ result: true })]);
  for (let index = 0; index < combined.length; index++) decoder.push(combined.subarray(index, index + 1));
  assert.deepEqual(messages, [{ text: '中文测试' }, { result: true }]);
  assert.throws(() => new FrameDecoder(() => {}).push(Buffer.from([0, 0, 0, 0])), /length/);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameDecoder(() => {}).push(oversized), /length/);
  assert.throws(() => new FrameDecoder(() => {}).push(Buffer.from([1, 0, 0, 0, 0xff])));
  assert.throws(() => encodeFrame({ value: 'x'.repeat(MAX_FRAME_BYTES) }), /limit/);
});

test('connect is explicit, initializes independent identity and preserves whole response', async (t) => {
  const { client, socket, initialized, endpoint } = await fixture(t);
  assert.equal(endpoint.path, DEFAULT_PIPE_PATH);
  assert.equal(client.clientId, 'probe-1');
  assert.equal(initialized.resultType, 'success');
  assert.deepEqual(socket.sent.map(({ type, method, version, params }) => ({ type, method, version, params })), [
    { type: 'request', method: 'initialize', version: 0, params: { clientType: 'feishu-bridge-probe' } },
  ]);
  assert.equal(socket.sent[0].sourceClientId, 'initializing-client');
  assert.strictEqual(await client.initialize(), initialized);
  await assert.rejects(() => client.connect(), /new IPC client/);
});

test('targeted request includes host and returns error envelope without swallowing it', async (t) => {
  const { client, socket } = await fixture(t, (message, transport) => {
    if (message.type === 'request') queueMicrotask(() => transport.receive({
      type: 'response', requestId: message.requestId, handledByClientId: 'owner-1',
      resultType: 'error', error: { code: 'example', message: 'read-only test response' },
    }));
  });
  const result = await client.request('read-only-example', { conversationId: 'thread-1' },
    { version: 3, targetClientId: 'owner-1', hostId: 'local', timeoutMs: 100 });
  assert.equal(result.resultType, 'error');
  assert.equal(result.error.code, 'example');
  assert.equal(socket.sent.at(-1).targetClientId, 'owner-1');
  assert.equal(socket.sent.at(-1).params.hostId, 'local');
  assert.equal(client.pendingRequestCount, 0);
  await assert.rejects(client.request('example', { hostId: 'remote' }, { hostId: 'local' }), /mismatch/);
});

test('bounded timeout and remote close reject and remove pending requests', async (t) => {
  const { client, socket } = await fixture(t);
  await assert.rejects(client.request('silent-example', {}, { timeoutMs: 10 }), /timed out/);
  assert.equal(client.pendingRequestCount, 0);
  const waiting = assert.rejects(client.request('pending-example', {}, { timeoutMs: 500 }), /socket closed/);
  socket.emit('close');
  await waiting;
  assert.equal(client.pendingRequestCount, 0);
  assert.equal(client.connected, false);
});

test('discovery/follow are scoped; only the subscribed owner, host and thread produce state', async (t) => {
  const { client, socket } = await fixture(t);
  const states = [];
  const broadcasts = [];
  client.on('state', (state) => states.push(state));
  client.on('broadcast', (message) => broadcasts.push(message));
  const owner = await client.subscribeThread('thread-1');
  assert.equal(owner.handledByClientId, 'owner-1');
  assert.deepEqual(socket.sent.at(-2).params, { hostId: 'local', conversationId: 'thread-1' });
  assert.deepEqual(socket.sent.at(-1), {
    type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
    sourceClientId: 'probe-1', targetClientIds: ['owner-1'],
    params: { hostId: 'local', conversationId: 'thread-1', following: true },
  });
  socket.receive(stateMessage({ sourceClientId: 'wrong-owner' }));
  socket.receive(stateMessage({ targetClientIds: ['someone-else'] }));
  socket.receive(stateMessage({ params: { ...stateMessage().params, conversationId: 'thread-other' } }));
  socket.receive(stateMessage({ params: { ...stateMessage().params, hostId: 'remote' } }));
  assert.equal(states.length, 0);
  assert.equal(broadcasts.length, 0);
  socket.receive(stateMessage());
  assert.deepEqual(states, [{ hostId: 'local', conversationId: 'thread-1', ownerId: 'owner-1',
    change: stateMessage().params.change }]);
  socket.receive({ type: 'broadcast', method: 'thread-metadata-example', version: 1,
    sourceClientId: 'owner-2', params: { conversationId: 'metadata-only' } });
  assert.equal(broadcasts.length, 2);
  const sentCount = socket.sent.length;
  assert.strictEqual(await client.subscribeThread('thread-1'), owner);
  assert.equal(socket.sent.length, sentCount);
});

test('close sends targeted unfollow, rejects pending work and emits close once', async (t) => {
  const { client, socket } = await fixture(t);
  await client.subscribeThread('thread-1');
  let closes = 0;
  client.on('close', () => closes++);
  const waiting = assert.rejects(client.request('pending-example', {}, { timeoutMs: 500 }), /client closed/);
  await client.close();
  await waiting;
  assert.equal(socket.sent.at(-1).params.following, false);
  assert.deepEqual(socket.sent.at(-1).targetClientIds, ['owner-1']);
  assert.equal(socket.ended, true);
  assert.equal(closes, 1);
  assert.equal(client.pendingRequestCount, 0);
  await client.close();
  assert.equal(closes, 1);
});

test('client discovery refuses ownership; invalid frames close instead of emitting state', async (t) => {
  const { client, socket } = await fixture(t);
  socket.receive({ type: 'client-discovery-request', requestId: 'discovery-1' });
  assert.deepEqual(socket.sent.at(-1), { type: 'client-discovery-response', requestId: 'discovery-1', response: { canHandle: false } });
  let errors = 0;
  client.on('protocolError', () => errors++);
  const waiting = assert.rejects(client.request('pending-example', {}, { timeoutMs: 500 }), /frame length/);
  socket.emit('data', Buffer.from([0, 0, 0, 0]));
  await waiting;
  assert.equal(errors, 1);
  assert.equal(socket.destroyed, true);
});

test('connection timeout is bounded and no request starts before explicit initialization', async (t) => {
  const socket = new FakeSocket();
  const client = new DesktopIpcClient({ connectTimeoutMs: 10, createConnection: () => socket });
  t.after(() => client.close());
  await assert.rejects(client.request('thread-owner-discovery', {}), /not initialized/);
  assert.equal(socket.sent.length, 0);
  await assert.rejects(client.connect(), /connection timed out/);
  assert.equal(socket.destroyed, true);
  assert.throws(() => new DesktopIpcClient({ pipePath: '\\\\other-host\\pipe\\codex-ipc' }), /local/);
});

// Regression: a real loaded task snapshot exceeded the former 32 MiB cap.
test('large task snapshots decode across chunks without disconnecting', () => {
  const payload = 'x'.repeat(54 * 1024 * 1024);
  const frame = encodeFrame({type: 'response', payload});
  let received = 0;
  const decoder = new FrameDecoder(message => {
    assert.equal(message.payload.length, payload.length);
    assert.equal(message.payload[message.payload.length - 1], 'x');
    received++;
  });
  for (let offset = 0; offset < frame.length; offset += 1024 * 1024)
    decoder.push(frame.subarray(offset, offset + 1024 * 1024));
  assert.equal(received, 1);
});
test('oversize input is rejected from its header before allocating its body', () => {
  const header = Buffer.alloc(4); header.writeUInt32LE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameDecoder(() => {}).push(header), /Invalid IPC frame length/);
});


for (const [label, overrides] of [
  ['new stream version', { version: 12 }],
  ['missing stream version', { version: undefined }],
  ['missing change', { params: { ...stateMessage().params, change: null } }],
  ['unknown change type', { params: { ...stateMessage().params, change: { type: 'new-schema', revision: 1 } } }],
  ['invalid snapshot', { params: { ...stateMessage().params, change: { type: 'snapshot', revision: 1, conversationState: [] } } }],
  ['invalid patches', { params: { ...stateMessage().params, change: { type: 'patches', baseRevision: 1, revision: 2, patches: {} } } }],
]) test(`trusted local ${label} fails explicitly instead of silently losing notifications`, async (t) => {
  const { client, socket } = await fixture(t);
  await client.subscribeThread('thread-1');
  const failures = [];
  client.on('protocolError', error => failures.push(error.code));
  const pending = assert.rejects(client.request('pending-example', {}, { timeoutMs: 500 }),
    error => error.code === 'protocol_incompatible');
  socket.receive(stateMessage(overrides));
  await pending;
  assert.deepEqual(failures, ['protocol_incompatible']);
  assert.equal(client.connected, false);
  assert.equal(socket.destroyed, true);
});

test('unrelated invalid-version broadcasts cannot declare the local protocol incompatible', async (t) => {
  const { client, socket } = await fixture(t);
  await client.subscribeThread('thread-1');
  await client.subscribeThread('thread-remote', 'remote');
  const failures = [];
  client.on('protocolError', error => failures.push(error));
  socket.receive(stateMessage({ version: 12, sourceClientId: 'other-owner' }));
  socket.receive(stateMessage({ version: 12, targetClientIds: ['other-client'] }));
  socket.receive(stateMessage({ version: 12, params: { ...stateMessage().params, conversationId: 'other-thread' } }));
  socket.receive(stateMessage({ version: 12, params: { ...stateMessage().params, hostId: 'remote', conversationId: 'thread-remote' } }));
  socket.receive({ type: 'broadcast', method: 'other-method', version: 999, sourceClientId: 'other-owner', params: {} });
  assert.deepEqual(failures, []);
  assert.equal(client.connected, true);
  assert.equal(socket.destroyed, false);
});

class WatcherClient extends EventEmitter {
  async connect() {}
  async initialize() {}
  async subscribeThread(id) {
    if (id === 'unloaded-history') throw new Error('Thread owner discovery failed');
    return { handledByClientId: 'owner-1', resultType: 'success' };
  }
  unsubscribeThread() { return true; }
  async close() { this.emit('close'); }
}

async function watcherFixture(t, client = new WatcherClient()) {
  const watcher = new GlobalDesktopWatcher({ client,
    verifyIdentity: async () => ({ codexVersion: '99.999.9999.0', device: 'test', serverPid: 123 }),
    loadMetadata: async () => ({ count: 2, threads: [{ id: 'thread-1' }, { id: 'unloaded-history' }] }) });
  t.after(() => watcher.close());
  await watcher.start();
  return { watcher, client };
}

const watcherState = change => ({ hostId: 'local', conversationId: 'thread-1', ownerId: 'owner-1', change });

test('watcher does not consider a connected subscription fresh until a usable snapshot arrives', async (t) => {
  const { watcher, client } = await watcherFixture(t);
  let stats = watcher.stats();
  assert.equal(stats.connected, true);
  assert.equal(stats.codexVersion, '99.999.9999.0');
  assert.equal(stats.knownUserThreadCount, 2);
  assert.equal(stats.subscribedThreadCount, 1);
  assert.equal(stats.unfreshSubscribedCount, 1);
  assert.equal(stats.freshStateCount, 0);
  assert.ok(Number.isSafeInteger(stats.metadataUpdatedAt) && stats.metadataUpdatedAt <= Date.now());
  assert.equal(watcher.get('thread-1'), null);
  client.emit('state', watcherState({ type: 'snapshot', revision: 1, conversationState: { turns: [] } }));
  stats = watcher.stats();
  assert.equal(stats.freshStateCount, 1);
  assert.equal(stats.unfreshSubscribedCount, 0);
  assert.ok(watcher.get('thread-1'));
  client.emit('state', watcherState({ type: 'patches', baseRevision: 0, revision: 2, patches: [] }));
  stats = watcher.stats();
  assert.equal(stats.freshStateCount, 0);
  assert.equal(stats.unfreshSubscribedCount, 1);
  assert.equal(watcher.get('thread-1'), null);
});

for (const [event, code] of [['protocolError', 'protocol_incompatible'], ['connectionError', 'ECONNRESET']])
  test(`watcher preserves ${event} code and invalidates current task access`, async (t) => {
    const { watcher, client } = await watcherFixture(t);
    const events = [];
    watcher.on('disconnected', event => events.push(event));
    client.emit(event, Object.assign(new Error('test failure'), { code }));
    assert.deepEqual(events, [{ reason: code }]);
    assert.equal(watcher.stats().running, false);
    assert.equal(watcher.stats().connected, false);
    assert.equal(watcher.get('thread-1'), null);
  });

test('protocol incompatibility during owner discovery rejects startup with its typed cause', async (t) => {
  const client = new WatcherClient();
  client.subscribeThread = async () => { throw Object.assign(new Error('bad owner response'), { code: 'protocol_incompatible' }); };
  const watcher = new GlobalDesktopWatcher({ client,
    verifyIdentity: async () => ({ codexVersion: '99.0.0.0' }),
    loadMetadata: async () => ({ count: 1, threads: [{ id: 'thread-1' }] }) });
  t.after(() => watcher.close());
  await assert.rejects(watcher.start(), error => error.code === 'protocol_incompatible');
  assert.equal(watcher.stats().running, false);
});


test('a new task without history stays loading until a compatible history patch arrives', async (t) => {
  const { watcher, client } = await watcherFixture(t);
  const states = [], failures = [];
  watcher.on('state', event => states.push(event));
  watcher.on('disconnected', event => failures.push(event));
  client.emit('state', watcherState({ type: 'snapshot', revision: 1, conversationState: { title: 'new task' } }));
  assert.equal(watcher.stats().connected, true);
  assert.equal(watcher.stats().freshStateCount, 0);
  assert.equal(watcher.stats().unfreshSubscribedCount, 1);
  assert.equal(watcher.get('thread-1'), null);
  assert.deepEqual(states, []);
  assert.deepEqual(failures, []);
  client.emit('state', watcherState({ type: 'patches', baseRevision: 1, revision: 2,
    patches: [{ op: 'add', path: ['turns'], value: [] }] }));
  assert.equal(watcher.stats().freshStateCount, 1);
  assert.equal(watcher.stats().unfreshSubscribedCount, 0);
  assert.equal(states.length, 1);
  assert.equal(states[0].initial, true);
});

for (const [label, state] of [
  ['empty canonical history', { turnHistory: { kind: 'canonical', history: { entitiesByKey: {}, islands: [] } } }],
  ['empty legacy turns', { turns: [] }],
  ['legacy history with additional fields', { turnHistory: { kind: 'legacy', extra: true }, turns: [], futureField: {} }],
]) test(`watcher accepts ${label} as a usable history`, async (t) => {
  const { watcher, client } = await watcherFixture(t);
  client.emit('state', watcherState({ type: 'snapshot', revision: 1, conversationState: state }));
  assert.equal(watcher.stats().freshStateCount, 1);
  assert.equal(watcher.stats().unfreshSubscribedCount, 0);
  assert.ok(watcher.get('thread-1'));
});

for (const [label, state] of [
  ['unknown history structure', { turnHistory: { kind: 'new-format', entries: [] } }],
  ['unknown history despite legacy mirror', { turnHistory: { kind: 'new-format', entries: [] }, turns: [] }],
  ['null history', { turnHistory: null }],
  ['canonical missing history', { turnHistory: { kind: 'canonical' } }],
  ['canonical invalid entities', { turnHistory: { kind: 'canonical', history: { entitiesByKey: [], islands: [] } } }],
  ['canonical invalid islands', { turnHistory: { kind: 'canonical', history: { entitiesByKey: {}, islands: {} } } }],
  ['invalid legacy turns', { turns: {} }],
]) test(`watcher rejects ${label} as a protocol incompatibility`, async (t) => {
  const { watcher, client } = await watcherFixture(t);
  const states = [], failures = [];
  watcher.on('state', event => states.push(event));
  watcher.on('disconnected', event => failures.push(event));
  client.emit('state', watcherState({ type: 'snapshot', revision: 1, conversationState: state }));
  assert.deepEqual(failures, [{ reason: 'protocol_incompatible' }]);
  assert.deepEqual(states, []);
  assert.equal(watcher.stats().connected, false);
  assert.equal(watcher.stats().freshStateCount, 0);
  assert.equal(watcher.get('thread-1'), null);
});


test('runtime metadata schema incompatibility disconnects with its precise cause', async (t) => {
  const client=new WatcherClient();let invalid=false;
  const watcher=new GlobalDesktopWatcher({client,verifyIdentity:async()=>({}),loadMetadata:async()=>{
    if(invalid)throw Object.assign(new Error('schema mismatch'),{code:'metadata_incompatible'});
    return {count:1,threads:[{id:'thread-1'}]};
  }});
  t.after(()=>watcher.close());await watcher.start();
  const failures=[];watcher.on('disconnected',event=>failures.push(event));invalid=true;
  client.emit('broadcast',{method:'thread-archived',version:1,params:{hostId:'local'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(failures,[{reason:'metadata_incompatible'}]);assert.equal(watcher.stats().connected,false);
});
