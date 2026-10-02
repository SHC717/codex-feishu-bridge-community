import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const MAX_FRAME_BYTES = 128 * 1024 * 1024;
export const DEFAULT_PIPE_PATH = '\\\\.\\pipe\\codex-ipc';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim() !== '';
const versionNumber = (value) => Number.isSafeInteger(value) && value >= 0;
const timeoutNumber = (value) => Number.isSafeInteger(value) && value > 0 && value <= 60_000;
const keyFor = (hostId, conversationId) => JSON.stringify([hostId, conversationId]);
const protocolError = (message) => Object.assign(new Error(message), { code: 'protocol_incompatible' });
const validStateChange = (change) => record(change) && versionNumber(change.revision)
  && (change.type === 'snapshot' ? record(change.conversationState)
    : change.type === 'patches' && versionNumber(change.baseRevision) && Array.isArray(change.patches));

export function encodeFrame(message) {
  const json = JSON.stringify(message);
  if (typeof json !== 'string') throw new TypeError('IPC message must be JSON data');
  const length = Buffer.byteLength(json, 'utf8');
  if (length === 0 || length > MAX_FRAME_BYTES) throw new RangeError('IPC frame exceeds size limit');
  const frame = Buffer.allocUnsafe(4 + length);
  frame.writeUInt32LE(length, 0);
  frame.write(json, 4, length, 'utf8');
  return frame;
}

/** Bounded frame parser, including split headers and multiple frames per chunk. */
export class FrameDecoder {
  #header = Buffer.alloc(4);
  #headerUsed = 0;
  #body = null;
  #bodyUsed = 0;
  #onMessage;

  constructor(onMessage) {
    if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function');
    this.#onMessage = onMessage;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('IPC chunk must be a Buffer');
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#body === null) {
        const count = Math.min(4 - this.#headerUsed, chunk.length - offset);
        chunk.copy(this.#header, this.#headerUsed, offset, offset + count);
        offset += count;
        this.#headerUsed += count;
        if (this.#headerUsed < 4) continue;
        const length = this.#header.readUInt32LE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) throw new RangeError(`Invalid IPC frame length: ${length} bytes (limit ${MAX_FRAME_BYTES})`);
        this.#body = Buffer.allocUnsafe(length);
        this.#bodyUsed = 0;
      }
      const count = Math.min(this.#body.length - this.#bodyUsed, chunk.length - offset);
      chunk.copy(this.#body, this.#bodyUsed, offset, offset + count);
      offset += count;
      this.#bodyUsed += count;
      if (this.#bodyUsed !== this.#body.length) continue;
      const body = this.#body;
      this.#body = null;
      this.#bodyUsed = 0;
      this.#headerUsed = 0;
      const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!record(message)) throw new TypeError('IPC envelope must be an object');
      this.#onMessage(message);
    }
  }
}

/**
 * Explicitly operated local pipe client. Importing this module does nothing.
 * The caller MUST first verify the pipe server process and same-user identity
 * with the existing Windows guard. This class cannot perform that Windows check.
 *
 * await client.connect(); await client.initialize();
 * await client.subscribeThread(conversationId, 'local');
 * No thread-start/turn-start/steer/request-submission calls run implicitly.
 * Use a new client instance after disconnection; no automatic reconnect/retry.
 */
export class DesktopIpcClient extends EventEmitter {
  #socket = null;
  #connected = false;
  #used = false;
  #closing = false;
  #closed = false;
  #clientId = null;
  #initialization = null;
  #pending = new Map();
  #subscriptions = new Map();
  #subscribing = new Map();
  #closePromise = null;
  #createConnection;

  constructor({ pipePath = DEFAULT_PIPE_PATH, timeoutMs = 5000, connectTimeoutMs = 2000,
    createConnection = (options) => net.createConnection(options) } = {}) {
    super();
    if (typeof pipePath !== 'string' || !pipePath.startsWith('\\\\.\\pipe\\')
      || pipePath.slice('\\\\.\\pipe\\'.length).includes('\\') || pipePath.endsWith('\\')) {
      throw new TypeError('Only a local named pipe path is allowed');
    }
    if (!timeoutNumber(timeoutMs) || !timeoutNumber(connectTimeoutMs)) throw new RangeError('Timeout must be 1..60000 ms');
    if (typeof createConnection !== 'function') throw new TypeError('createConnection must be a function');
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.#createConnection = createConnection;
  }

  get clientId() { return this.#clientId; }
  get connected() { return this.#connected && !this.#closing; }
  get pendingRequestCount() { return this.#pending.size; }

  async connect() {
    if (this.#used) throw new Error('Use a new IPC client for another connection');
    this.#used = true;
    const socket = this.#createConnection({ path: this.pipePath });
    this.#socket = socket;
    const decoder = new FrameDecoder((message) => this.#receive(message));
    socket.on('data', (chunk) => {
      if (this.#closing || this.#closed) return;
      try { decoder.push(chunk); } catch (error) {
        error.code ??= 'protocol_incompatible';
        this.#connected = false;
        this.emit('protocolError', error);
        this.#rejectPending(error);
        socket.destroy(error);
      }
    });
    socket.on('error', (error) => {
      this.#connected = false;
      this.#rejectPending(error);
      this.emit('connectionError', error);
    });
    socket.on('close', () => {
      this.#connected = false;
      this.#rejectPending(new Error('IPC socket closed'));
      this.#subscriptions.clear();
      if (!this.#closed) { this.#closed = true; this.emit('close'); }
    });
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const onConnect = () => { cleanup(); this.#connected = true; resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('IPC socket closed before connection')); };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error('IPC connection timed out');
        socket.destroy(error);
        reject(error);
      }, this.connectTimeoutMs);
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
    return this;
  }

  initialize() {
    if (!this.#initialization) this.#initialization = (async () => {
      const response = await this.request('initialize', { clientType: 'feishu-bridge-probe' }, { version: 0 });
      if (response.resultType !== 'success' || !text(response.result?.clientId)) {
        throw protocolError('Desktop IPC initialization did not return a client identity');
      }
      this.#clientId = response.result.clientId;
      return response;
    })();
    return this.#initialization;
  }

  #params(params, hostId) {
    if (!record(params)) throw new TypeError('IPC params must be an object');
    if (hostId === undefined) return params;
    if (!text(hostId) || (params.hostId !== undefined && params.hostId !== hostId)) throw new TypeError('Host identity mismatch');
    return { ...params, hostId };
  }

  #write(message) {
    if (!this.#connected || this.#closed || !this.#socket) throw new Error('IPC is not connected');
    this.#socket.write(encodeFrame(message));
  }

  request(method, params, { version = 1, targetClientId, timeoutMs = this.timeoutMs, hostId } = {}) {
    if (!text(method) || !versionNumber(version) || !timeoutNumber(timeoutMs)) return Promise.reject(new TypeError('Invalid IPC request options'));
    if (targetClientId !== undefined && !text(targetClientId)) return Promise.reject(new TypeError('Invalid target client'));
    if (this.#closing || (!this.#clientId && !(method === 'initialize' && version === 0))) return Promise.reject(new Error('IPC client is not initialized or is closing'));
    let requestParams;
    try { requestParams = this.#params(params, hostId); } catch (error) { return Promise.reject(error); }
    const requestId = randomUUID();
    const message = {
      type: 'request', requestId, sourceClientId: this.#clientId ?? 'initializing-client',
      version, method, params: requestParams, timeoutMs,
      ...(targetClientId === undefined ? {} : { targetClientId }),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`IPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer, targetClientId });
      try { this.#write(message); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  sendBroadcast(method, params, { version = 1, targetClientIds, hostId } = {}) {
    if (!this.#clientId || this.#closing) throw new Error('IPC client is not initialized or is closing');
    if (!text(method) || !versionNumber(version)) throw new TypeError('Invalid IPC broadcast');
    if (targetClientIds !== undefined && (!Array.isArray(targetClientIds)
      || targetClientIds.length === 0 || targetClientIds.some((id) => !text(id)))) throw new TypeError('Invalid broadcast targets');
    this.#write({ type: 'broadcast', method, version, sourceClientId: this.#clientId,
      params: this.#params(params, hostId),
      ...(targetClientIds === undefined ? {} : { targetClientIds: [...targetClientIds] }),
    });
  }

  subscribeThread(conversationId, hostId = 'local') {
    if (!text(conversationId) || !text(hostId)) return Promise.reject(new TypeError('Thread and host identities are required'));
    const key = keyFor(hostId, conversationId);
    if (this.#subscriptions.has(key)) return Promise.resolve(this.#subscriptions.get(key).response);
    if (this.#subscribing.has(key)) return this.#subscribing.get(key);
    const work = (async () => {
      const response = await this.request('thread-owner-discovery', { hostId, conversationId }, { version: 1 });
      if (response.resultType !== 'success') throw new Error('Thread owner discovery failed');
      if (!text(response.handledByClientId)) throw protocolError('Thread owner response did not return an owner identity');
      const ownerId = response.handledByClientId;
      this.#subscriptions.set(key, { hostId, conversationId, ownerId, response });
      try {
        this.sendBroadcast('thread-stream-following-changed', { hostId, conversationId, following: true },
          { version: 1, targetClientIds: [ownerId] });
      } catch (error) { this.#subscriptions.delete(key); throw error; }
      return response;
    })();
    this.#subscribing.set(key, work);
    work.then(() => this.#subscribing.delete(key), () => this.#subscribing.delete(key));
    return work;
  }

  unsubscribeThread(conversationId, hostId = 'local') {
    const key = keyFor(hostId, conversationId);
    const subscription = this.#subscriptions.get(key);
    if (!subscription) return false;
    this.sendBroadcast('thread-stream-following-changed', { hostId, conversationId, following: false },
      { version: 1, targetClientIds: [subscription.ownerId] });
    this.#subscriptions.delete(key);
    return true;
  }

  #receive(message) {
    if (message.type === 'response') {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      if (pending.targetClientId !== undefined && message.handledByClientId != null
        && message.handledByClientId !== pending.targetClientId) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.requestId);
      // Deliberately preserve resultType/error and the entire response envelope.
      pending.resolve(message);
      return;
    }
    if (message.type === 'client-discovery-request' && text(message.requestId)) {
      if (message.targetClientId !== undefined && message.targetClientId !== this.#clientId) return;
      this.#write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type !== 'broadcast' || !this.#clientId || !text(message.sourceClientId)
      || message.sourceClientId === this.#clientId || !text(message.method)
      || !record(message.params)) return;
    if (message.targetClientIds != null && (!Array.isArray(message.targetClientIds)
      || message.targetClientIds.some((id) => !text(id)) || !message.targetClientIds.includes(this.#clientId))) return;
    if (message.method === 'thread-stream-state-changed') {
      const { hostId, conversationId, change } = message.params;
      const subscription = this.#subscriptions.get(keyFor(hostId, conversationId));
      if (!subscription || message.sourceClientId !== subscription.ownerId) return;
      if (message.version !== 11 || !validStateChange(change)) {
        // Only authenticated, subscribed local task traffic can declare the
        // bridge protocol incompatible. Other hosts/broadcasts are irrelevant.
        if (hostId === 'local') throw protocolError('Desktop task stream protocol is incompatible');
        return;
      }
      this.emit('state', { hostId, conversationId, change, ownerId: subscription.ownerId });
    }
    if (versionNumber(message.version)) this.emit('broadcast', message);
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed || !this.#socket) return Promise.resolve();
    if (this.#connected && this.#clientId) {
      for (const subscription of this.#subscriptions.values()) {
        try { this.unsubscribeThread(subscription.conversationId, subscription.hostId); }
        catch (error) { this.emit('connectionError', error); }
      }
    }
    this.#closing = true;
    this.#rejectPending(new Error('IPC client closed'));
    this.#subscriptions.clear();
    this.#closePromise = new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.#socket.destroy(); resolve(); }, 1000);
      this.#socket.once('close', done);
      this.#socket.end();
    });
    return this.#closePromise;
  }
}
