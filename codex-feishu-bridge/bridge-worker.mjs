import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {GlobalDesktopWatcher} from './global-desktop-watcher.mjs';
import {DurableState} from './durable-state.mjs';
import {BridgeEngine} from './bridge-engine.mjs';
import {createProfileTransport} from './profile-transport.mjs';
import {messageRoutes,destinationArgs} from './message-routing.mjs';

const args=process.argv.slice(2),arg=(name,other)=>{const i=args.indexOf(name);return i<0?other:args[i+1];};
const recipient=arg('--recipient',''),stateDir=resolve(arg('--state-dir','')),serve=args.includes('--serve');
const seconds=Number(arg('--seconds','900'));
if(!/^ou_[a-zA-Z0-9]+$/.test(recipient)||!args.includes('--state-dir')||(!serve&&(!Number.isInteger(seconds)||seconds<10||seconds>1800)))throw Error('explicit_deployment_parameters_required');
const runId=randomUUID(),stopFile=join(stateDir,'worker-stop.requested'),healthPath=join(stateDir,'worker-health.json');
const cli=process.env.CODEX_FEISHU_LARK??join(process.env.USERPROFILE,'.local','bin','lark-cli.exe');
const env={...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'};
const transport=createProfileTransport({executable:cli,profileName:process.env.CODEX_FEISHU_PROFILE,env});
const call=transport.call;
const interactionChatId=process.env.CODEX_FEISHU_INTERACTION_CHAT??'',resultChatId=process.env.CODEX_FEISHU_RESULT_CHAT??'';
const routes=messageRoutes(recipient,interactionChatId,resultChatId);
const emit=event=>process.stdout.write(JSON.stringify({at:new Date().toISOString(),runId,...event})+'\n');
let store,engine,listener,heartbeat,stopPoll,deadline,finished=false,reason='stopped',healthWriting=false;
let doneResolve;const done=new Promise(resolve=>doneResolve=resolve),accepts=new Set();
const watcher=new GlobalDesktopWatcher();
function stop(value){if(finished)return;reason=value;emit({stage:'connection_failed',code:value});if(engine)engine.stopping=true;doneResolve();}
async function health(status){if(healthWriting)return;healthWriting=true;
  try{const temp=healthPath+'.'+runId+'.tmp';await writeFile(temp,JSON.stringify({runId,instanceId:process.env.CODEX_FEISHU_INSTANCE_ID,pid:process.pid,status,updatedAt:Date.now(),
    health:watcher.stats(),pendingQuestions:store?Object.values(store.data.questions).filter(q=>q.status!=='closed').length:0}));
    await rename(temp,healthPath);}finally{healthWriting=false;}}
watcher.on('state',event=>{if(engine&&!finished)try{engine.observe(event.threadId,event.conversationState);}catch(e){emit({stage:'state_failed',reason:e.message});stop('state_failed');}});
watcher.on('disconnected',event=>stop(event?.reason??'desktop_disconnected'));
watcher.on('warning',event=>emit({stage:'watcher_warning',...event}));
watcher.on('error',error=>{emit({stage:'watcher_failed',reason:error.message});stop('watcher_failed');});
async function startListener(){
  const check=await call(['event','consume','card.action.trigger','--as','bot','--dry-run']);
  if(!['ready','allowed'].includes(check.data?.decision?.status))throw Error('feishu_callback_not_ready');
  listener=transport.consume();
  const lines=createInterface({input:listener.stdout}),errors=createInterface({input:listener.stderr});
  lines.on('line',line=>{let raw;try{raw=JSON.parse(line);}catch{return;}if(!engine||finished)return;
    const pending=engine.accept(raw).catch(e=>{emit({stage:'phone_reply_failed',reason:e.message});if(e.code?.includes('state'))stop('state_failed');});
    accepts.add(pending);pending.finally(()=>accepts.delete(pending));});
  await new Promise((resolve,reject)=>{let ready=false;const timer=setTimeout(()=>reject(Error('listener_timeout')),30000);
    errors.on('line',line=>{if(line.startsWith('[event] ready event_key=card.action.trigger')){ready=true;clearTimeout(timer);resolve();}});
    listener.once('error',()=>{clearTimeout(timer);reject(Error('listener_error'));});
    listener.once('close',()=>{clearTimeout(timer);if(!ready)reject(Error('listener_closed_before_ready'));else stop('listener_disconnected');});});
}
try{
  // Stop requests must also be observed during connection and backlog recovery.
  stopPoll=setInterval(()=>{if(existsSync(stopFile))stop('stop_requested');},250);
  process.once('SIGTERM',()=>stop('signal'));process.once('SIGINT',()=>stop('signal'));
  await mkdir(stateDir,{recursive:true});store=await DurableState.open(join(stateDir,'bridge-state.json'));
  engine=new BridgeEngine({store,recipient,interactionChatId,resultChatId,getState:id=>watcher.get(id)?.conversationState??null,emit,
    submit:(...values)=>watcher.request(...values),
    sendCard:async(card,key,target=routes.legacy)=>{const sent=await call(['im','+messages-send','--as','bot',...destinationArgs(target),
      '--msg-type','interactive','--content',JSON.stringify(card),'--idempotency-key',key]);return sent.data?.message_id;},
    uploadText:async(name,text)=>{const response=await transport.uploadText(name,text);return response.data?.file_key;},
    sendFile:async(fileKey,key,target)=>{const sent=await call(['im','+messages-send','--as','bot',...destinationArgs(target),
      '--msg-type','file','--content',JSON.stringify({file_key:fileKey}),'--idempotency-key',key]);return sent.data?.message_id;},
    // Ordinary notifications only; no production urgency transport is exposed.
    patchCard:(id,card)=>call(['im','messages','patch','--as','bot','--message-id',id,'--data','-'],{content:JSON.stringify(card)})});
  // Validate the desktop before opening the bot event consumer.
  if(existsSync(stopFile))throw Error('stop_requested_before_start');
  await watcher.start();
  if(existsSync(stopFile))throw Error('stop_requested_before_listener');
  await startListener();
  if(existsSync(stopFile))throw Error('stop_requested_before_notifications');
  await engine.tick();await health('running');
  emit({stage:'ready',pid:process.pid,serve,stopFile,health:watcher.stats()});
  heartbeat=setInterval(()=>{
    if(existsSync(stopFile)){stop('stop_requested');return;}
    engine.tick().catch(e=>{emit({stage:'tick_failed',reason:e.message});stop('state_failed');});
    health('running').catch(e=>{emit({stage:'health_failed',reason:e.message});stop('health_failed');});
  },1000);
  if(!serve)deadline=setTimeout(()=>stop('deadline'),seconds*1000);
  await done;
}catch(e){reason='startup_failed';emit({stage:'failed',reason:e.message,code:e.code??'worker_unavailable'});process.exitCode=1;}
finally{
  finished=true;clearInterval(heartbeat);clearInterval(stopPoll);clearTimeout(deadline);
  if(engine)engine.stopping=true;if(listener)listener.stdin.end();
  await Promise.allSettled([...accepts]);
  while(engine?.draining)await new Promise(resolve=>setTimeout(resolve,100));
  if(engine)await engine.pause(reason==='stop_requested'?'飞书桥接已暂停，恢复后可回答':'电脑连接暂时断开，恢复后可回答').catch(e=>emit({stage:'pause_failed',reason:e.message}));
  await watcher.close().catch(()=>{});await store?.close().catch(e=>emit({stage:'state_close_failed',reason:e.message}));
  await health('stopped').catch(()=>{});emit({stage:'stopped',reason});
}
