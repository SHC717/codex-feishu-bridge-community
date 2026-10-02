import { EventEmitter } from 'node:events';
import { DesktopIpcClient } from './desktop-ipc-client.mjs';
import { createDesktopState, reduceDesktopState } from './desktop-state.mjs';
import { loadUserThreadMetadata, verifyDesktopIdentity } from './global-discovery-probe.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Check only the containers that the projections consume. Additional fields are
// compatible; a task with no history yet is loading rather than broken.
function historyUsability(state) {
  if (Object.hasOwn(state, 'turnHistory')) {
    const history = state.turnHistory;
    if (!object(history)) return 'incompatible';
    if (history.kind === 'canonical') return object(history.history)
      && object(history.history.entitiesByKey) && Array.isArray(history.history.islands)
      ? 'usable' : 'incompatible';
    return history.kind === 'legacy' && Array.isArray(state.turns) ? 'usable' : 'incompatible';
  }
  if (Object.hasOwn(state, 'turns')) return Array.isArray(state.turns) ? 'usable' : 'incompatible';
  return 'loading';
}


/**
 * Read-only global desktop observer. Import has no effects. Its autonomous IPC
 * traffic is limited to initialization, owner discovery, following/unfollowing.
 * request() is only an explicit caller-directed forwarding operation: no retries,
 * thread creation, task steering or answer submission are initiated here.
 * The default metadata loader excludes non-user tasks before any subscription.
 */
export class GlobalDesktopWatcher extends EventEmitter {
  #client;
  #loadMetadata;
  #verifyIdentity;
  #refreshIntervalMs;
  #concurrency;
  #metadata = new Map();
  #records = new Map();
  #queue = new Set();
  #force = new Set();
  #hints = new Set();
  #inFlight = new Set();
  #idleWaiters = new Set();
  #refreshPromise = null;
  #refreshTimer = null;
  #startPromise = null;
  #closePromise = null;
  #running = false;
  #connected = false;
  #closing = false;
  #disconnected = false;
  #disconnectReason = null;
  #refreshes = 0;
  #discoveryAttempts = 0;
  #discoveryFailures = 0;
  #snapshots = 0;
  #patches = 0;
  #initialStates = 0;
  #codexVersion = null;
  #metadataUpdatedAt = null;

  constructor({ refreshIntervalMs = 10_000, concurrency = 4, discoveryTimeoutMs = 3000,
    loadMetadata = loadUserThreadMetadata, verifyIdentity = verifyDesktopIdentity,
    client = null } = {}) {
    super();
    if (!Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 1000 || refreshIntervalMs > 60_000) throw new RangeError('Refresh interval must be 1000..60000 ms');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new RangeError('Concurrency must be 1..4');
    if (typeof loadMetadata !== 'function' || typeof verifyIdentity !== 'function') throw new TypeError('Metadata loader and guard must be functions');
    this.#refreshIntervalMs = refreshIntervalMs;
    this.#concurrency = concurrency;
    this.#loadMetadata = loadMetadata;
    this.#verifyIdentity = verifyIdentity;
    this.#client = client ?? new DesktopIpcClient({ timeoutMs: discoveryTimeoutMs });
    this.#client.on('state', (event) => this.#onState(event));
    this.#client.on('broadcast', (message) => this.#onBroadcast(message));
    this.#client.on('close', () => this.#onDisconnected('socket_closed'));
    this.#client.on('connectionError', (error) => this.#onDisconnected(error?.code ?? 'connection_error'));
    this.#client.on('protocolError', (error) => this.#onDisconnected(error?.code ?? 'protocol_incompatible'));
  }

  start() {
    if (this.#startPromise) return this.#startPromise;
    if (this.#closing) return Promise.reject(new Error('Watcher is closed; create a new instance'));
    this.#running = true;
    this.#startPromise = (async () => {
      try {
        const guard = await this.#verifyIdentity();
        this.#codexVersion = typeof guard.codexVersion === 'string' ? guard.codexVersion : null;
        if (!this.#running) throw new Error('Watcher stopped during identity verification');
        this.emit('identity', { verified: true, device: guard.device, serverPid: guard.serverPid });
        await this.#refreshMetadata();
        if (!this.#running) throw new Error('Watcher stopped during metadata loading');
        await this.#client.connect();
        await this.#client.initialize();
        if (!this.#running) throw new Error('Watcher stopped during initialization');
        this.#connected = true;
        for (const id of this.#metadata.keys()) this.#enqueue(id);
        this.#refreshTimer = setInterval(() => {
          this.#refreshMetadata().catch(error => this.#metadataFailure(error));
        }, this.#refreshIntervalMs);
        await this.#waitIdle();
        if (!this.#running) throw new Error('Watcher disconnected during initial discovery');
        const stats = this.stats();
        this.emit('ready', stats);
        return stats;
      } catch (error) {
        if (['protocol_incompatible','metadata_incompatible','identity_verification_failed'].includes(this.#disconnectReason)) error.code ??= this.#disconnectReason;
        await this.close();
        throw error;
      }
    })();
    return this.#startPromise;
  }

  #metadataFailure(error) {
    if (error?.code === 'metadata_incompatible') this.#onDisconnected('metadata_incompatible');
    else this.#warn('metadata_refresh_failed');
  }

  #warn(code, threadId) {
    if (this.#running) this.emit('warning', { code, ...(threadId ? { threadId } : {}) });
  }

  #refreshMetadata() {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = (async () => {
      const result = await this.#loadMetadata();
      if (!this.#running) return;
      if (!Array.isArray(result.threads) || result.count !== result.threads.length
        || result.threads.some((thread) => typeof thread.id !== 'string')) throw new Error('Invalid metadata projection');
      const next = new Map(result.threads.map((thread) => [thread.id, thread]));
      if (next.size !== result.count) throw new Error('Duplicate metadata identities');
      this.#metadata = next;
      this.#metadataUpdatedAt = Date.now();
      this.#refreshes++;
      for (const [id, record] of this.#records) if (!next.has(id)) {
        if (record.subscribed && this.#connected) {
          try { this.#client.unsubscribeThread(id, 'local'); } catch { this.#warn('unsubscribe_failed', id); }
        }
        this.#records.delete(id);
        this.#queue.delete(id);
        this.#force.delete(id);
        this.emit('removed', { threadId: id });
      }
      for (const id of this.#hints) if (next.has(id)) this.#enqueue(id, true);
      this.#hints.clear();
      for (const id of next.keys()) {
        const record = this.#records.get(id);
        if (!record?.subscribed || record.reduced.needsResnapshot) this.#enqueue(id);
      }
      this.emit('metadata', this.stats());
    })().finally(() => { this.#refreshPromise = null; });
    return this.#refreshPromise;
  }

  #enqueue(id, force = false) {
    if (!this.#running || !this.#connected || !this.#metadata.has(id)) return;
    if (force) this.#force.add(id);
    if (!this.#inFlight.has(id)) this.#queue.add(id);
    this.#pump();
  }

  #pump() {
    if (!this.#running || !this.#connected) { this.#resolveIdle(); return; }
    while (this.#inFlight.size < this.#concurrency && this.#queue.size) {
      const id = this.#queue.values().next().value;
      this.#queue.delete(id);
      if (!this.#metadata.has(id) || this.#inFlight.has(id)) continue;
      this.#inFlight.add(id);
      this.#subscribe(id).finally(() => {
        this.#inFlight.delete(id);
        if (this.#force.has(id) && this.#running && this.#metadata.has(id)) this.#queue.add(id);
        this.#pump();
        this.#resolveIdle();
      });
    }
    this.#resolveIdle();
  }

  async #subscribe(id) {
    const force = this.#force.delete(id);
    let record = this.#records.get(id);
    if (!record) {
      record = { ownerId: null, subscribed: false, initialEmitted: false,
        reduced: createDesktopState(), updatedAt: null, usableHistory: false };
      this.#records.set(id, record);
    }
    if (record.subscribed && !force && !record.reduced.needsResnapshot) return;
    try {
      if (record.subscribed) this.#client.unsubscribeThread(id, 'local');
      record.subscribed = false;
      record.ownerId = null;
      record.reduced = createDesktopState();
      record.updatedAt = null;
      record.usableHistory = false;
      this.#discoveryAttempts++;
      const response = await this.#client.subscribeThread(id, 'local');
      if (!this.#running || !this.#metadata.has(id)) {
        if (this.#connected) this.#client.unsubscribeThread(id, 'local');
        return;
      }
      record.ownerId = response.handledByClientId;
      record.subscribed = true;
    } catch (error) {
      record.subscribed = false;
      record.ownerId = null;
      this.#discoveryFailures++;
      if (error?.code === 'protocol_incompatible') {
        this.#onDisconnected(error.code);
        return;
      }
      // Ownerless history is expected. Retry after the next metadata refresh;
      // never resume/start the task to manufacture an owner.
    }
  }

  #onState({ hostId, conversationId, ownerId, change }) {
    if (!this.#running || !this.#connected || hostId !== 'local' || !this.#metadata.has(conversationId)) return;
    const record = this.#records.get(conversationId);
    if (!record) return;
    if (record.ownerId !== null && record.ownerId !== ownerId) {
      record.reduced = createDesktopState();
    }
    record.ownerId = ownerId;
    record.subscribed = true;
    record.usableHistory = false;
    record.reduced = reduceDesktopState(record.reduced, change);
    if (record.reduced.needsResnapshot) {
      this.#warn('snapshot_required', conversationId);
      // The periodic refresh will unfollow/refollow to request a fresh snapshot.
      return;
    }
    const history = historyUsability(record.reduced.conversationState);
    if (history === 'incompatible') {
      this.#onDisconnected('protocol_incompatible');
      return;
    }
    if (history === 'loading') return;
    record.usableHistory = true;
    record.updatedAt = Date.now();
    const initial = !record.initialEmitted;
    record.initialEmitted = true;
    if (initial) this.#initialStates++;
    if (change.type === 'snapshot') this.#snapshots++;
    if (change.type === 'patches') this.#patches++;
    this.emit('state', { threadId: conversationId, ownerId,
      conversationState: structuredClone(record.reduced.conversationState), initial,
      change: structuredClone(change), revision: record.reduced.revision,
      metadata: structuredClone(this.#metadata.get(conversationId)) });
  }

  #onBroadcast(message) {
    if (!this.#running || !this.#connected) return;
    if (message.method === 'thread-stream-following-status-requested' && message.version === 1
      && message.params.hostId === 'local' && typeof message.params.conversationId === 'string') {
      // Always reload the filtered DB projection before following an event ID.
      this.#hints.add(message.params.conversationId);
      this.#refreshMetadata().catch(error => this.#metadataFailure(error));
      return;
    }
    if (['thread-unarchived', 'thread-archived'].includes(message.method)
      && message.params.hostId === 'local') {
      this.#refreshMetadata().catch(error => this.#metadataFailure(error));
    }
    if (message.method === 'ipc-connection-reset' && message.version === 1) this.#onDisconnected('ipc_reset');
  }

  #onDisconnected(reason) {
    if (this.#closing || this.#disconnected) return;
    this.#disconnected = true;
    this.#disconnectReason = reason;
    this.#running = false;
    this.#connected = false;
    clearInterval(this.#refreshTimer);
    this.#queue.clear();
    this.#resolveIdle();
    this.emit('disconnected', { reason });
    // No reconnect or restart. A supervisor may construct a new guarded watcher.
    this.#client.close().catch(() => {});
  }

  #waitIdle() {
    if ((!this.#queue.size && !this.#inFlight.size) || !this.#running) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #resolveIdle() {
    if (this.#running && (this.#queue.size || this.#inFlight.size)) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  get(threadId) {
    const record = this.#records.get(threadId);
    if (!this.#running || !this.#connected || !record?.subscribed || !record.ownerId
      || record.reduced.needsResnapshot || !record.usableHistory || !this.#metadata.has(threadId)) return null;
    return { threadId, ownerId: record.ownerId, revision: record.reduced.revision,
      updatedAt: record.updatedAt, conversationState: structuredClone(record.reduced.conversationState),
      metadata: structuredClone(this.#metadata.get(threadId)) };
  }

  request(threadId, method, params, options = {}) {
    const current = this.get(threadId);
    if (!current) return Promise.reject(new Error('No current owner and fresh state for this user task'));
    if (options.targetClientId !== undefined && options.targetClientId !== current.ownerId) return Promise.reject(new Error('Owner identity mismatch'));
    if (options.hostId !== undefined && options.hostId !== 'local') return Promise.reject(new Error('Host identity mismatch'));
    if (params?.conversationId !== undefined && params.conversationId !== threadId
      || params?.threadId !== undefined && params.threadId !== threadId) return Promise.reject(new Error('Thread identity mismatch'));
    return this.#client.request(method, params, { ...options, targetClientId: current.ownerId, hostId: 'local' });
  }

  stats() {
    let subscribedThreadCount = 0;
    let freshStateCount = 0;
    for (const record of this.#records.values()) {
      if (record.subscribed) subscribedThreadCount++;
      if (record.subscribed && record.usableHistory && !record.reduced.needsResnapshot && record.updatedAt !== null) freshStateCount++;
    }
    return { running: this.#running, connected: this.#connected,
      knownUserThreadCount: this.#metadata.size, subscribedThreadCount, freshStateCount,
      unfreshSubscribedCount: subscribedThreadCount - freshStateCount,
      codexVersion: this.#codexVersion, metadataUpdatedAt: this.#metadataUpdatedAt,
      initialStateCount: this.#initialStates, snapshotCount: this.#snapshots, patchCount: this.#patches,
      metadataRefreshCount: this.#refreshes, discoveryAttempts: this.#discoveryAttempts,
      discoveryFailures: this.#discoveryFailures, discoveryInFlight: this.#inFlight.size,
      queuedDiscoveryCount: this.#queue.size };
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#running = false;
    clearInterval(this.#refreshTimer);
    this.#queue.clear();
    this.#force.clear();
    this.#hints.clear();
    this.#resolveIdle();
    this.#closePromise = (async () => {
      await this.#client.close();
      this.#connected = false;
      this.#records.clear();
      this.emit('closed');
    })();
    return this.#closePromise;
  }
}
