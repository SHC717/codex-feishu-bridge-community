import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { DesktopIpcClient } from './desktop-ipc-client.mjs';
import { createDesktopState, reduceDesktopState } from './desktop-state.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const python = process.env.CODEX_FEISHU_PYTHON;
const shell = process.env.CODEX_FEISHU_PWSH ?? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const emit = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);

function readChild(executable, args, fallbackCode, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!executable) { reject(new Error('Explicit local runtime configuration is required')); return; }
    const child = spawn(executable, args, { windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let diagnostics = '';
    const failure = () => {
      const code = /CFB_FAILURE:(protocol_incompatible|identity_verification_failed|codex_unavailable|metadata_incompatible|metadata_unavailable)\b/.exec(diagnostics)?.[1] ?? fallbackCode;
      return Object.assign(new Error(code), { code });
    };
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error(fallbackCode), { code: fallbackCode })); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) { child.kill(); finish(new Error('Metadata/guard output exceeded limit')); }
      else output += chunk;
    });
    // Only fixed machine-readable codes leave this helper; never surface raw diagnostics.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
    child.on('error', () => finish(Object.assign(new Error(fallbackCode), { code: fallbackCode })));
    child.on('close', (code) => finish(code === 0 ? null : failure(), output));
  });
}

export async function loadUserThreadMetadata() {
  const metadata = JSON.parse(await readChild(python, ['-I', join(directory, 'list-user-threads.py')], 'metadata_unavailable'));
  if (!Array.isArray(metadata.threads) || metadata.count !== metadata.threads.length
    || metadata.threads.some((thread) => typeof thread.id !== 'string')) throw new Error('Invalid metadata projection');
  if (new Set(metadata.threads.map((thread) => thread.id)).size !== metadata.count) throw new Error('Duplicate metadata identities');
  return metadata;
}

export async function verifyDesktopIdentity() {
  const guard = JSON.parse(await readChild(shell, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-File', join(directory, 'desktop-ipc-handshake.ps1')], 'codex_unavailable'));
  if (guard.serverIdentityVerified !== true || guard.resultType !== 'success' || guard.clientIdAssigned !== true) {
    throw Object.assign(new Error('protocol_incompatible'), { code: 'protocol_incompatible' });
  }
  return guard;
}

function projectKey(thread) {
  if (thread.project_id) return `project:${thread.project_id}`;
  if (typeof thread.cwd === 'string' && thread.cwd.trim()) return `cwd:${thread.cwd.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()}`;
  return 'unassigned';
}

function statusName(value) {
  const raw = typeof value === 'string' ? value : value?.type ?? value?.status;
  // Status names are metadata, but never emit an arbitrary string as a label.
  return typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw) ? raw : 'unknown';
}

function increment(counts, status) { counts[status] = (counts[status] ?? 0) + 1; }

export function observedTurns(state) {
  const canonical = state?.turnHistory?.kind === 'canonical';
  const entities = state?.turnHistory?.history?.entitiesByKey;
  const entries = canonical && entities && typeof entities === 'object' && !Array.isArray(entities)
    ? Object.entries(entities) : Array.isArray(state?.turns)
      ? state.turns.map((turn, index) => [`legacy:${index}`, turn]) : [];
  const turns = new Map();
  for (const [key, entity] of entries) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) continue;
    const turnId = typeof entity.turnId === 'string' && entity.turnId ? entity.turnId : null;
    const identity = turnId ?? `entity:${key}`;
    const status = statusName(entity.status);
    const previous = turns.get(identity);
    if (previous) {
      if (previous.status !== status) previous.status = 'conflicting';
      previous.entityKeys.push(key);
    } else turns.set(identity, { turnId, status, entityKeys: [key] });
  }
  return { canonical, entries, turns };
}

export async function runGlobalDiscoveryProbe({ observeSeconds = 60 } = {}) {
  if (!Number.isInteger(observeSeconds) || observeSeconds < 1 || observeSeconds > 60) throw new RangeError('Observation must be 1..60 seconds');
  const startedAt = Date.now();
  const metadata = await loadUserThreadMetadata();
  const seeds = metadata.threads;
  const seedById = new Map(seeds.map((thread) => [thread.id, thread]));
  if (seedById.size !== seeds.length || seeds.some((thread) => typeof thread.id !== 'string')) throw new Error('Invalid thread identities');
  emit({ stage: 'metadata', seedThreadCount: seeds.length,
    seedProjectCount: new Set(seeds.map(projectKey).filter((key) => key !== 'unassigned')).size,
    unassignedSeedThreadCount: seeds.filter((thread) => projectKey(thread) === 'unassigned').length,
    titlesOrBodiesSelected: false });

  const guard = await verifyDesktopIdentity();
  emit({ stage: 'identity-guard', verified: true, device: guard.device, serverPid: guard.serverPid });

  const client = new DesktopIpcClient({ timeoutMs: 3000 });
  const subscribed = new Map();
  const states = new Map();
  const baselineIds = new Set();
  const failureCounts = {};
  const broadcastCounts = {};
  const followingStatusRequests = new Map();
  const terminalTransitions = new Set();
  let patchEvents = 0;
  let snapshotEvents = 0;
  let transportLost = false;
  let expectedClose = false;
  let interval;
  let observationTimer;
  let stopObservation;
  let nextSeed = 0;
  client.on('state', ({ hostId, conversationId, change }) => {
    if (hostId !== 'local' || !seedById.has(conversationId)) return;
    const previous = states.get(conversationId) ?? createDesktopState();
    const next = reduceDesktopState(previous, change);
    states.set(conversationId, next);
    if (baselineIds.has(conversationId) && !previous.needsResnapshot && !next.needsResnapshot) {
      const previousTurns = observedTurns(previous.conversationState).turns;
      for (const [identity, turn] of observedTurns(next.conversationState).turns) {
        const before = previousTurns.get(identity);
        if (turn.turnId && before && ['inProgress', 'in_progress', 'running'].includes(before.status)
          && ['completed', 'interrupted', 'failed'].includes(turn.status)) {
          terminalTransitions.add(JSON.stringify([conversationId, turn.turnId, turn.status]));
        }
      }
    }
    if (change.type === 'snapshot' && !next.needsResnapshot) {
      snapshotEvents++;
      // First snapshots are baselines, never notification-triggering events.
      baselineIds.add(conversationId);
    } else if (change.type === 'patches') patchEvents++;
  });
  client.on('broadcast', (message) => {
    if (/^[A-Za-z0-9_/-]{1,100}$/.test(message.method)) increment(broadcastCounts, message.method);
    if (message.method === 'thread-stream-following-status-requested' && message.version === 1
      && message.params.hostId === 'local' && typeof message.params.conversationId === 'string') {
      const { conversationId } = message.params;
      followingStatusRequests.set(conversationId, { conversationId,
        alreadyInSeedMetadata: seedById.has(conversationId), alreadySubscribed: subscribed.has(conversationId) });
    }
  });
  client.on('close', () => {
    if (!expectedClose) { transportLost = true; stopObservation?.(); }
  });
  client.on('protocolError', () => increment(failureCounts, 'protocol_error'));
  client.on('connectionError', () => increment(failureCounts, 'connection_error'));

  const summarize = (stage) => {
    const runtimeStatusCounts = {};
    const turnStatusCounts = {};
    const historyKinds = {};
    const entityFieldNames = new Set();
    let noTurnDataThreads = 0;
    let needsResnapshotCount = 0;
    let noSnapshotCount = 0;
    for (const [id] of subscribed) {
      const reduced = states.get(id);
      if (!reduced) { noSnapshotCount++; continue; }
      if (reduced.needsResnapshot) { needsResnapshotCount++; continue; }
      const state = reduced.conversationState;
      increment(runtimeStatusCounts, statusName(state.threadRuntimeStatus));
      increment(historyKinds, statusName(state.turnHistory?.kind));
      const observed = observedTurns(state);
      if (observed.turns.size === 0) noTurnDataThreads++;
      for (const turn of observed.turns.values()) increment(turnStatusCounts, turn.status);
      for (const [, entity] of observed.entries) if (entity && typeof entity === 'object') {
        for (const field of Object.keys(entity)) if (/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(field)) entityFieldNames.add(field);
      }
    }
    const threads = [...subscribed.values()];
    return { stage, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      seedThreadCount: seeds.length, attemptedThreadCount: Math.min(nextSeed, seeds.length),
      subscribedThreadCount: threads.length,
      subscribedProjectCount: new Set(threads.map(projectKey).filter((key) => key !== 'unassigned')).size,
      unassignedSubscribedThreadCount: threads.filter((thread) => projectKey(thread) === 'unassigned').length,
      baselineSnapshotCount: baselineIds.size, snapshotEvents, patchEvents,
      runtimeStatusCounts, turnStatusCounts, noTurnDataThreads, historyKinds,
      observedTerminalTransitions: terminalTransitions.size,
      broadcastCounts: { ...broadcastCounts }, followingStatusRequests: [...followingStatusRequests.values()],
      noSnapshotCount, needsResnapshotCount, failureCounts: { ...failureCounts }, transportLost,
      historicalNotifications: 0, feishuMessagesSent: 0, answersSubmitted: 0,
      ...(stage === 'summary' ? { observationSeconds: observeSeconds,
        historyEntityFieldNames: [...entityFieldNames].sort() } : {}),
    };
  };

  try {
    await client.connect();
    await client.initialize();
    emit({ stage: 'connected', independentClientIdentity: true, maximumConcurrentDiscovery: 4 });
    interval = setInterval(() => emit(summarize('progress')), 15_000);
    const worker = async () => {
      while (nextSeed < seeds.length && !transportLost) {
        const thread = seeds[nextSeed++];
        try {
          await client.subscribeThread(thread.id, 'local');
          subscribed.set(thread.id, thread);
        } catch (error) {
          increment(failureCounts, error.message?.includes('timed out') ? 'owner_timeout' : 'owner_discovery_failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, seeds.length) }, worker));
    emit(summarize('discovery-complete'));
    if (!transportLost) await new Promise((resolve) => {
      stopObservation = resolve;
      observationTimer = setTimeout(resolve, observeSeconds * 1000);
    });
    clearTimeout(observationTimer);
    const summary = summarize('summary');
    emit(summary);
    return summary;
  } finally {
    clearInterval(interval);
    clearTimeout(observationTimer);
    expectedClose = true;
    await client.close();
    states.clear();
    emit({ stage: 'closed', allSubscriptionsReleased: true, feishuMessagesSent: 0, answersSubmitted: 0 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secondsIndex = process.argv.indexOf('--seconds');
  const observeSeconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : 60;
  runGlobalDiscoveryProbe({ observeSeconds }).catch((error) => {
    emit({ stage: 'failed', reason: error.message, feishuMessagesSent: 0, answersSubmitted: 0 });
    process.exitCode = 1;
  });
}
