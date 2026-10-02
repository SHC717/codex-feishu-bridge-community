// Health is based on the current worker's live state, never an app-version list.
const immediateCodes = new Set(['protocol_incompatible','identity_verification_failed','metadata_incompatible']);
const reasons = new Set([...immediateCodes,'codex_unavailable','metadata_unavailable','worker_unavailable','listener_unavailable','state_unavailable','connection_unavailable']);
export function failureCode(value) {
  if (reasons.has(value)) return value;
  if (['listener_disconnected','listener_timeout','listener_error','listener_closed_before_ready','feishu_callback_not_ready'].includes(value)) return 'listener_unavailable';
  if (['state_failed','health_failed'].includes(value)) return 'state_unavailable';
  return 'connection_unavailable';
}
export class WorkerHealthMonitor {
  constructor({now=Date.now,settleMs=10000}={}) { this.now=now;this.settleMs=settleMs;this.reset(); }
  reset() { this.failure=null;this.healthySince=null; }
  observe(event) {
    if (['failed','connection_failed','watcher_failed'].includes(event.stage)) {
      this.failure=failureCode(event.code??event.reason);this.healthySince=null;
    }
  }
  inspect({pid,instanceId,health}={}) {
    const now=this.now(), stats=health?.health;
    let reason=this.failure;
    if (!reason && (!pid || health?.pid!==pid || health.instanceId!==instanceId || health.status!=='running'
      || !Number.isFinite(health.updatedAt) || now-health.updatedAt>15000 || health.updatedAt>now+5000)) reason='worker_unavailable';
    if (!reason && (!stats?.running || !stats.connected)) reason='connection_unavailable';
    if (!reason && (!Number.isFinite(stats.metadataUpdatedAt) || now-stats.metadataUpdatedAt>60000 || stats.metadataUpdatedAt>now+5000)) reason='metadata_unavailable';
    if (!reason && (!Number.isInteger(stats.unfreshSubscribedCount) || stats.unfreshSubscribedCount>0)) reason='state_unavailable';
    if (reason) { this.healthySince=null;return {mode:'unhealthy',healthy:false,reason,immediate:immediateCodes.has(reason)}; }
    // An empty/ownerless desktop is legitimate. Wait for a real snapshot before
    // announcing recovery; do not invent a failure solely from unloaded history.
    if (!Number.isInteger(stats.freshStateCount) || stats.freshStateCount===0) {
      this.healthySince=null;return {mode:'waiting_for_task'};
    }
    this.healthySince??=now;
    const details={};
    if (typeof stats.codexVersion==='string' && /^\d+(\.\d+){1,4}$/.test(stats.codexVersion)) details.codexVersion=stats.codexVersion;
    if (now-this.healthySince<this.settleMs) return {mode:'settling',details};
    return {mode:'healthy',healthy:true,details};
  }
}
