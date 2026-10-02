import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { HealthNotifier } from './health-notifier.mjs';
import { WorkerHealthMonitor } from './supervisor-health.mjs';
import { createProfileTransport } from './profile-transport.mjs';
import { messageRoutes, destinationArgs } from './message-routing.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_LOG = 2 * 1024 * 1024;
function rotateAppend(file, data) {
  let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > MAX_LOG) buffer = buffer.subarray(buffer.length - MAX_LOG);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size + buffer.length > MAX_LOG) {
    if (fs.existsSync(`${file}.3`)) fs.unlinkSync(`${file}.3`);
    for (let index = 2; index >= 1; index--) if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, buffer);
}

function processCreationTicks(pwshPath, pid) {
  const result = spawnSync(pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    `([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks.ToString()`],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0 || !/^\d+$/.test(result.stdout?.trim() ?? '')) throw new Error('Cannot verify process creation identity');
  return result.stdout.trim();
}

export function createHealthDelivery(config,{createTransport=createProfileTransport}={}) {
  const transport = createTransport({executable:config.larkCliPath,profileName:config.profileName,
    env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
  const routes = messageRoutes(config.recipient,config.interactionChatId??'',config.resultChatId??'');
  return {
    sendCard:async (card,key) => {
      const response=await transport.call(['im','+messages-send','--as','bot',...destinationArgs(routes.result),
        '--msg-type','interactive','--content',JSON.stringify(card),'--idempotency-key',key]);
      if (!response.data?.message_id) throw Error('fault_message_unconfirmed');
      return response.data.message_id;
    },

  };
}

export async function runSupervisor(installRoot) {
  if (process.platform !== 'win32') throw new Error('This supervisor is for the approved Windows host only');
  const root = path.resolve(installRoot);
  if (path.dirname(fileURLToPath(import.meta.url)).toLowerCase() !== root.toLowerCase()) throw new Error('Run only the verified deployed supervisor');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'deployment.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (config.application !== 'CodexFeishuBridge' || config.schema !== 2 || path.resolve(config.installRoot) !== root) throw new Error('Invalid deployment configuration');
  // Verify actual file-handle paths and hashes again before the first state write.
  const guard = spawnSync(config.pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-File', path.join(root, 'Get-BridgeStatus.ps1'), '-InstallRoot', root],
  { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (guard.status !== 0) throw new Error('Deployment final-path verification failed');
  const verified = JSON.parse(guard.stdout.trim());
  if (verified.packageContext !== false || verified.realPathVerified !== true || verified.runtimeHashesVerified !== true || verified.taskMatches !== true || verified.autoStartEnabled !== true) throw new Error('Packaged or redirected execution refused');
  if (verified.workerRunning || verified.supervisorRunning) throw new Error('Another verified bridge instance is still running');
  if (!Number.isInteger(config.singletonPort) || config.singletonPort < 1024 || config.singletonPort > 65535) throw new Error('Invalid singleton port');
  const createdAtTicks = processCreationTicks(config.pwshPath, process.pid);
  const singleton = net.createServer((socket) => socket.destroy());
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const stopFile = path.join(stateDir, 'stop.requested');
  const workerStop = path.join(stateDir, 'worker-stop.requested');
  const recordFile = path.join(stateDir, 'supervisor.json');
  const instanceId = randomUUID();
  const record = { schema: 1, application: 'CodexFeishuBridge', instanceId, pid: process.pid,
    nodePath: process.execPath, supervisorPath: fileURLToPath(import.meta.url),
    createdAtTicks, workerPid: null,
    workerCreatedAtTicks: null, phase: 'starting', retryDelayMs: 5000, generation: 0, heartbeatAt: null };
  let worker = null;
  let stopping = false;
  let stopDeadline = null;
  let delay = 5000;
  let wakeSleep;
  let notificationWork = null;
  const monitor = new WorkerHealthMonitor();
  const log = (event, details = {}) => rotateAppend(path.join(logDir, 'supervisor.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), instanceId, event, ...details })}\n`);
  const save = () => {
    record.heartbeatAt = new Date().toISOString();
    const temporary = path.join(stateDir, `supervisor.${instanceId}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, recordFile);
  };
  // This sender belongs to the supervisor, so it works before/without Codex IPC
  // and never opens a second card callback consumer.
  const notifier = new HealthNotifier({file:path.join(stateDir,'health-notifications.json'),
    ...createHealthDelivery(config),emit:(event,details)=>log(event,details)});
  const checkConnection = async () => {
    let health=null;
    try {
      const healthFile=path.join(stateDir,'worker-health.json');
      if (fs.statSync(healthFile).size<65536) health=JSON.parse(fs.readFileSync(healthFile,'utf8'));
    } catch {}
    const status=monitor.inspect({pid:record.workerPid,instanceId,health});
    record.connectionHealth=status;
    if (status.mode==='unhealthy' || status.mode==='healthy') await notifier.tick(status);
    record.notification=notifier.status();
  };
  const requestStop = (reason) => {
    if (stopping) return;
    stopping = true;
    record.phase = 'stopping';
    stopDeadline = Date.now() + 45_000;
    wakeSleep?.();
    try { fs.writeFileSync(workerStop, new Date().toISOString()); } catch {}
    try { log('stop_requested', { reason }); } catch {}
    try { save(); } catch {}
  };
  // Complete fallible configuration/state loading before acquiring a live server.
  await new Promise((resolve, reject) => {
    singleton.once('error', reject);
    singleton.listen({ host: '127.0.0.1', port: config.singletonPort, exclusive: true }, resolve);
  });
  const interval = setInterval(() => {
    try {
      if (fs.existsSync(stopFile)) requestStop('stop_file');
      if (stopping && worker && stopDeadline !== null && Date.now() >= stopDeadline) {
        log('worker_stop_grace_expired');
        // ChildProcess holds the handle of the child we spawned. Never scan or
        // terminate by process name, and never target Codex or another task.
        worker.kill();
        stopDeadline = null;
      }
      if (!stopping && !notificationWork) {
        notificationWork=checkConnection().catch(()=>log('health_notification_failed'))
          .finally(()=>{notificationWork=null;});
      }
      save();
    } catch { requestStop('state_write_failed'); }
  }, 1000);
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));
  try {
    save();
    log('supervisor_started', { pid: process.pid, singletonPort: config.singletonPort });
    while (!stopping) {
      if (fs.existsSync(stopFile)) { requestStop('stop_file'); break; }
      // A worker-only stop requests a graceful reconnect; a supervisor stop
      // above always takes precedence and is never removed here.
      if (fs.existsSync(workerStop)) fs.unlinkSync(workerStop);
      const workerStarted = Date.now();
      record.phase = 'worker_starting';
      monitor.reset();
      record.generation++;
      const child = spawn(config.nodePath, [path.join(root, 'bridge-worker.mjs'), '--state-dir', stateDir,
        '--recipient', config.recipient, '--serve', '--live'], {
        cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CODEX_FEISHU_PYTHON: config.pythonPath, CODEX_FEISHU_PWSH: config.pwshPath,
          CODEX_FEISHU_LARK: config.larkCliPath, CODEX_FEISHU_INSTANCE_ID: instanceId,
          CODEX_FEISHU_PROFILE: config.profileName, CODEX_FEISHU_DATABASE: config.databasePath,
          CODEX_FEISHU_INTERACTION_CHAT: config.interactionChatId??'', CODEX_FEISHU_RESULT_CHAT: config.resultChatId??'' },
      });
      worker = child;
      const workerLines=createInterface({input:child.stdout});
      workerLines.on('line',line=>{
        if (line.length>65536) return;
        try { monitor.observe(JSON.parse(line)); } catch {}
      });
      child.stdout.on('data', (data) => {
        try { rotateAppend(path.join(logDir, 'worker.stdout.log'), data); } catch { requestStop('log_write_failed'); }
      });
      child.stderr.on('data', (data) => {
        try { rotateAppend(path.join(logDir, 'worker.stderr.log'), data); } catch { requestStop('log_write_failed'); }
      });
      const completion = new Promise((resolve) => {
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        child.once('error', (error) => finish({ code: null, error: error.code ?? 'spawn_failed' }));
        child.once('exit', (code, signal) => finish({ code, signal }));
      });
      if (child.pid) {
        record.workerPid = child.pid;
        try { record.workerCreatedAtTicks = processCreationTicks(config.pwshPath, child.pid); }
        catch { record.workerCreatedAtTicks = null; }
      }
      record.phase = 'running';
      save();
      const result = await completion;
      worker = null;
      record.workerPid = null;
      record.workerCreatedAtTicks = null;
      log('worker_exited', { ...result, generation: record.generation, uptimeMs: Date.now() - workerStarted });
      if (stopping || fs.existsSync(stopFile)) { requestStop('stop_file'); break; }
      if (Date.now() - workerStarted >= 60_000) delay = 5000;
      record.phase = 'backoff'; record.retryDelayMs = delay; save();
      await new Promise((resolve) => {
        const timer = setTimeout(() => { wakeSleep = null; resolve(); }, delay);
        wakeSleep = () => { clearTimeout(timer); wakeSleep = null; resolve(); };
      });
      delay = Math.min(delay * 2, 60_000);
    }
  } finally {
    clearInterval(interval);
    if (notificationWork) await notificationWork;
    if (worker) worker.kill();
    record.phase = 'stopped'; record.workerPid = null; record.workerCreatedAtTicks = null;
    try { save(); log('supervisor_stopped'); }
    finally { await new Promise((resolve) => singleton.close(resolve)); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--install-root');
  runSupervisor(index >= 0 ? process.argv[index + 1] : path.dirname(fileURLToPath(import.meta.url)))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
