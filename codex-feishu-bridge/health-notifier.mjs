import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const REASONS = Object.freeze({
  connection_unavailable: '暂时无法连接 Codex。',
  codex_unavailable: 'Codex 尚未运行，或连接入口暂不可用。',
  protocol_incompatible: 'Codex 的实际接口暂不兼容，需要更新飞书桥的接口支持。',
  identity_verification_failed: '暂时无法核实 Codex 程序和当前用户的身份。',
  metadata_incompatible: 'Codex 的任务清单结构发生变化，需要更新飞书桥的读取支持。',
  metadata_unavailable: '暂时无法读取 Codex 的任务清单。',
  listener_unavailable: '飞书回答通道暂不可用。',
  state_unavailable: '暂时无法完整读取 Codex 的任务状态。',
  worker_unavailable: '飞书桥的消息转发程序暂不可用。',
});
const COUNT_KEYS = new Set(['watchedTasks', 'knownTasks', 'pendingQuestions',
  'subscribedThreadCount', 'freshStateCount', 'consecutiveFailures', 'failures']);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const VERSION = /^\d{1,6}(?:\.\d{1,6}){1,5}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const number = value => Number.isSafeInteger(value) && value >= 0;
const keys = (value, expected) => plain(value) && Object.keys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key));
const reasonKey = value => typeof value === 'string' && Object.hasOwn(REASONS, value) ? value : 'connection_unavailable';
const timestamp = value => number(value) && value <= 8_640_000_000_000_000;
const GENERIC_REASONS = new Set(['connection_unavailable', 'worker_unavailable']);

export class HealthNotifierError extends Error {
  constructor(code, message) { super(message); this.name = 'HealthNotifierError'; this.code = code; }
}
function invalid() { throw new HealthNotifierError('HEALTH_STATE_INVALID', 'Health notification state is invalid; original file was preserved'); }
function sanitizedDetails(value) {
  const result = {};
  if (!plain(value)) return result;
  if (typeof value.codexVersion === 'string' && VERSION.test(value.codexVersion)) result.codexVersion = value.codexVersion;
  for (const key of COUNT_KEYS) if (number(value[key])) result[key] = value[key];
  return result;
}
function validDetails(value) {
  return plain(value) && Object.keys(value).every(key => key === 'codexVersion'
    ? typeof value[key] === 'string' && VERSION.test(value[key]) : COUNT_KEYS.has(key) && number(value[key]));
}
function delivery() { return { id: randomUUID(), attemptedAt: null, messageId: null, urgent: false, retryAt: 0 }; }
function validateDelivery(value) {
  if (!keys(value, ['id', 'attemptedAt', 'messageId', 'urgent', 'retryAt']) || !UUID.test(value.id)
    || !(value.attemptedAt === null || timestamp(value.attemptedAt)) || !number(value.retryAt)
    || !(value.messageId === null || typeof value.messageId === 'string' && value.messageId.trim() && value.messageId.length <= 512)
    || typeof value.urgent !== 'boolean' || value.messageId !== null && value.attemptedAt === null
    || value.urgent && value.messageId === null) invalid();
}
function validateFailure(value) {
  if (!keys(value, ['startedAt', 'reason', 'details', 'immediate']) || !timestamp(value.startedAt)
    || !Object.hasOwn(REASONS, value.reason) || !validDetails(value.details) || typeof value.immediate !== 'boolean') invalid();
}
function validate(data) {
  if (!keys(data, ['version', 'incident']) || data.version !== 1) invalid();
  const item = data.incident;
  if (item === null) return;
  if (!keys(item, ['startedAt', 'reason', 'details', 'immediate', 'alert', 'recoveredAt', 'recovery', 'followup'])) invalid();
  validateFailure({ startedAt: item.startedAt, reason: item.reason, details: item.details, immediate: item.immediate });
  validateDelivery(item.alert);
  if (!(item.recoveredAt === null || timestamp(item.recoveredAt)) || (item.recovery === null) !== (item.recoveredAt === null)) invalid();
  if (item.recovery !== null) {
    validateDelivery(item.recovery);
    if (item.alert.attemptedAt === null || item.recovery.id === item.alert.id) invalid();
  }
  if (item.followup !== null) {
    validateFailure(item.followup);
    if (item.recovery?.attemptedAt === null || !item.recovery) invalid();
  }
}
function read(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
    throw new HealthNotifierError('HEALTH_STATE_PATH', 'Health notification state must be a bounded regular file');
  return fs.readFileSync(file);
}
function upgradeFailure(current, observed) {
  if (observed.immediate && !current.immediate
    || GENERIC_REASONS.has(current.reason) && !GENERIC_REASONS.has(observed.reason)) {
    current.reason = observed.reason; current.details = observed.details;
    current.immediate ||= observed.immediate;
    return true;
  }
  return false;
}
function newIncident(failure) { return { ...failure, alert: delivery(), recoveredAt: null, recovery: null, followup: null }; }
function formatTime(value) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function card(item, recovered) {
  const title = recovered ? '飞书桥已恢复' : '飞书桥连接异常';
  const version = item.details.codexVersion ? `\nCodex 版本：${item.details.codexVersion}` : '';
  const content = recovered
    ? `飞书桥已在 ${formatTime(item.recoveredAt)} 检测到连接恢复，问答回传和结果通知可以继续。${version}\n这是本次故障对应的一次恢复通知；如网络曾中断，送达时间可能稍晚。`
    : `${REASONS[item.reason]}${version}\n故障开始：${formatTime(item.startedAt)}\n飞书桥仍在后台运行，并会自动重试。恢复前，手机问答或任务结果通知可能延迟；同一次故障只提醒一次。`;
  return { schema: '2.0', config: { update_multi: true, enable_forward: false, summary: { content: title } },
    header: { title: { tag: 'plain_text', content: title }, template: recovered ? 'green' : 'orange' },
    body: { elements: [{ tag: 'markdown', content }] } };
}

/**
 * Independent of the Codex connection. The caller supplies the existing, verified
 * result-chat transport and serial health observations; this class never chooses
 * recipients, reads credentials, invokes a model, or replays task answers.
 * A persisted UUID is reused whenever sending has an uncertain outcome. The
 * transport must implement idempotency for that UUID. Urgency is retried against
 * the receipt, never by creating a replacement message.
 */
export class HealthNotifier {
  #file; #sendCard; #urgentCard; #urgentEnabled; #now; #graceMs; #retryMs; #emit;
  #data; #digest; #failure = null; #tail = Promise.resolve();

  constructor({ file, sendCard, urgentCard, urgentEnabled = false, now = Date.now, graceMs = 120_000, retryMs = 60_000, emit = () => {} }) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || typeof sendCard !== 'function'
      || typeof urgentEnabled !== 'boolean' || (urgentEnabled && typeof urgentCard !== 'function') || typeof now !== 'function' || typeof emit !== 'function'
      || !number(graceMs) || !number(retryMs) || retryMs === 0)
      throw new HealthNotifierError('HEALTH_CONFIG_INVALID', 'Health notifier configuration is invalid');
    this.#file = path.resolve(file); this.#sendCard = sendCard; this.#urgentCard = urgentCard; this.#urgentEnabled = urgentEnabled;
    this.#now = now; this.#graceMs = graceMs; this.#retryMs = retryMs; this.#emit = emit;
    const bytes = read(this.#file);
    this.#digest = bytes === null ? null : digest(bytes);
    if (bytes === null) this.#data = { version: 1, incident: null };
    else {
      try { this.#data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { invalid(); }
      validate(this.#data);
    }
  }

  #delivered(target) { return !!target?.messageId && (!this.#urgentEnabled || target.urgent); }

  status() {
    const item = this.#data.incident;
    return { active: !!item, phase: this.#failure ? 'state_error' : !item ? 'healthy'
      : item.recovery ? 'recovery_pending' : this.#delivered(item.alert) ? 'fault_notified'
        : item.alert.attemptedAt === null ? 'waiting' : 'fault_pending',
    reason: item?.reason ?? null, incidentStartedAt: item?.startedAt ?? null,
    faultDelivered: this.#delivered(item?.alert),
    nextAttemptAt: item ? (!this.#delivered(item.alert) ? item.alert.retryAt : item.recovery?.retryAt ?? null) : null };
  }

  tick({ healthy, reason = 'connection_unavailable', immediate = false, details = {} }) {
    if (typeof healthy !== 'boolean' || typeof immediate !== 'boolean')
      return Promise.reject(new HealthNotifierError('HEALTH_OBSERVATION_INVALID', 'A boolean health observation is required'));
    // Capture only the whitelist now; callers cannot mutate queued observations.
    const observation = { healthy, reason: reasonKey(reason), immediate, details: sanitizedDetails(details) };
    const operation = this.#tail.then(() => this.#tick(observation));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  #log(event, phase) { try { this.#emit(event, { phase }); } catch {} }

  #save() {
    if (this.#failure) throw this.#failure;
    let temporary;
    try {
      validate(this.#data);
      const bytes = Buffer.from(JSON.stringify(this.#data) + '\n');
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const check = () => {
        const current = read(this.#file);
        if ((current === null ? null : digest(current)) !== this.#digest)
          throw new HealthNotifierError('HEALTH_STATE_CONFLICT', 'Health notification state changed outside this instance; original file was preserved');
      };
      check();
      temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      check();
      fs.renameSync(temporary, this.#file);
      temporary = null; this.#digest = digest(bytes);
    } catch (error) {
      this.#failure = error instanceof HealthNotifierError ? error
        : new HealthNotifierError('HEALTH_STATE_WRITE', 'Health notification state could not be saved; sending stopped');
      throw this.#failure;
    } finally {
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
    }
  }

  async #deliver(item, phase, time) {
    const target = phase === 'fault' ? item.alert : item.recovery;
    // A confirmed ordinary receipt completes delivery in normal mode, including
    // old records waiting to retry urgency. Never claim an urgency was sent.
    if (this.#delivered(target)) return true;
    if (time < target.retryAt) return false;
    if (target.attemptedAt === null) target.attemptedAt = time;
    target.retryAt = time + this.#retryMs;
    this.#save(); // Persist intent before either external call.
    if (target.messageId === null) {
      let receipt;
      try {
        receipt = await this.#sendCard(card(item, phase === 'recovery'), target.id);
        if (typeof receipt !== 'string' || !receipt.trim() || receipt.length > 512) throw new Error('invalid receipt');
      } catch {
        this.#log('health_notification_retry', phase); return false;
      }
      target.messageId = receipt;
      this.#save();
    }
    if (!this.#urgentEnabled) {
      target.retryAt = 0; this.#save(); this.#log('health_notification_delivered', phase); return true;
    }
    try { await this.#urgentCard(target.messageId); }
    catch { this.#log('health_urgency_retry', phase); return false; }
    target.urgent = true; target.retryAt = 0;
    this.#save(); this.#log('health_notification_delivered', phase);
    return true;
  }

  async #tick(observation) {
    if (this.#failure) throw this.#failure;
    const time = this.#now();
    if (!number(time) || time > 8_640_000_000_000_000)
      throw new HealthNotifierError('HEALTH_CLOCK_INVALID', 'Health notifier clock must be a valid timestamp');
    const failure = { startedAt: time, reason: observation.reason, details: observation.details, immediate: observation.immediate };
    let item = this.#data.incident;
    if (!item) {
      if (observation.healthy) return this.status();
      item = this.#data.incident = newIncident(failure); this.#save();
    } else if (observation.healthy) {
      if (item.alert.attemptedAt === null) {
        this.#data.incident = null; this.#save(); return this.status();
      }
      if (item.recovery === null) { item.recoveredAt = time; item.recovery = delivery(); this.#save(); }
      if (item.followup !== null) { item.followup = null; this.#save(); }
    } else if (item.recovery?.attemptedAt !== null && item.recovery) {
      // Recovery may already have reached the phone. Preserve its UUID and queue
      // the new failure instead of changing that historical message's content.
      if (!item.followup) { item.followup = failure; this.#save(); }
      else if (upgradeFailure(item.followup, failure)) this.#save();
    } else {
      if (item.recovery) { item.recoveredAt = null; item.recovery = null; this.#save(); }
      if (item.alert.attemptedAt === null && upgradeFailure(item, failure)) this.#save();
    }
    if (!item.immediate && item.alert.attemptedAt === null && time - item.startedAt < this.#graceMs) return this.status();
    if (!await this.#deliver(item, 'fault', time)) return this.status();
    if (item.recovery && await this.#deliver(item, 'recovery', time)) {
      this.#data.incident = item.followup && !observation.healthy ? newIncident(item.followup) : null;
      this.#save();
      const next = this.#data.incident;
      if (next && (next.immediate || time - next.startedAt >= this.#graceMs)) await this.#deliver(next, 'fault', time);
    }
    return this.status();
  }
}
