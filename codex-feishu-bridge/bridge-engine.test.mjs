import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableState} from './durable-state.mjs';
import {BridgeEngine} from './bridge-engine.mjs';

const nativeId='["request_user_input_async","ask",0]';
function state({title='Task',cwd='C:/project-a',status='inProgress',answer=null,clientId=null,withQuestion=true}={}){
  const items=withQuestion?[{type:'agentMessage',id:'ask',questions:[{title:'完整选项是否可读？',options:['完整可读','需要调整']}]}]:[];
  if(answer!==null)items.push({type:'steeringUserMessage',id:'accepted',clientUserMessageId:clientId,status:'accepted',
    input:[{type:'text',text:'<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:nativeId,question:'完整选项是否可读？',answer}])+'\n</send_user_message_question_reply>'}]});
  if(status==='completed')items.push({type:'agentMessage',id:'final',phase:'final_answer',text:'实际最终结果。'});
  return {title,cwd,turns:[{turnId:'turn',status,items}],requests:[]};
}
async function fixture(t,{urgentEnabled=true}={}){
  const dir=await mkdtemp(join(tmpdir(),'feishu-engine-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'state.json'),states=new Map([['a',state()]]),sends=[],patches=[],submits=[],events=[],urgents=[];
  let now=10000,sequence=0,store=await DurableState.open(path);
  const transports={urgentEnabled,recipient:'ou_me',getState:id=>states.get(id),now:()=>now,emit:e=>events.push(e),
    sendCard:async(card,key)=>{const existing=sends.find(x=>x.key===key);if(existing)return existing.id;
      const id=`om_${++sequence}`;sends.push({card,key,id});return id;},
    urgentCard:async id=>{urgents.push(id);},
    patchCard:async(id,card)=>{patches.push({id,card});},submit:async(...args)=>{submits.push(args);return {resultType:'success'};}};
  let engine=new BridgeEngine({store,...transports});
  return {dir,path,states,sends,patches,submits,events,urgents,transports,get store(){return store;},get engine(){return engine;},
    tick:async(id='a')=>{engine.observe(id,states.get(id));await engine.tick();},
    restart:async()=>{await store.close();store=await DurableState.open(path);engine=new BridgeEngine({store,...transports});},
    advance:ms=>{now+=ms;},close:()=>store.close()};
}
const question=(f,id='a')=>Object.values(f.store.data.questions).find(q=>q.threadId===id);
function callback(q,extra={}){return {type:'card.action.trigger',operator_id:'ou_me',message_id:q.messageId,
  action_value:JSON.stringify({question_id:q.localId,choice:'完整可读'}),...extra};}

test('restart rebinds original card without sending duplicate and rejects stale buttons',async t=>{
  const f=await fixture(t);await f.tick();await f.tick();assert.equal(f.sends.length,1);
  const old=structuredClone(question(f));await f.restart();await f.tick();const current=question(f);
  assert.equal(f.sends.length,1);assert.equal(current.messageId,old.messageId);assert.notEqual(current.localId,old.localId);
  await f.engine.accept(callback(old));assert.equal(f.submits.length,0);
  await f.engine.accept(callback(current));assert.equal(f.submits.length,1);
  assert.equal(f.submits[0][0],'a');assert.equal(f.submits[0][2].restoreMessage.cwd,'C:/project-a');await f.close();
});
test('desktop answer while bridge is stopped closes the same card after restart',async t=>{
  const f=await fixture(t);await f.tick();const id=question(f).messageId;
  f.states.set('a',state({answer:'电脑已经处理',status:'completed'}));await f.restart();await f.tick();
  assert.equal(f.sends.filter(s=>s.card.header.title.content==='Codex 需要你回答').length,1);
  assert.equal(question(f).status,'closed');assert.equal(question(f).desiredStatus,'该任务已在电脑端处理');
  assert.equal(f.patches.filter(p=>p.id===id).at(-1).card.header.title.content,'该任务已在电脑端处理');await f.close();
});
test('uncertain native submission is persisted and never replayed after restart',async t=>{
  const f=await fixture(t);f.transports.submit=async(...args)=>{f.submits.push(args);throw Error('timeout');};await f.restart();await f.tick();
  await f.engine.accept(callback(question(f)));const clientId=question(f).clientMessageId;
  assert.equal(f.submits.length,1);await f.restart();await f.tick();
  assert.equal(f.submits.length,1);assert.equal(question(f).status,'submitting');
  f.states.set('a',state({answer:'完整可读',clientId,status:'completed'}));await f.tick();
  assert.equal(question(f).desiredStatus,'已通过飞书处理');assert.equal(f.submits.length,1);await f.close();
});
test('simultaneous duplicate callback performs one native submission',async t=>{
  const f=await fixture(t);await f.tick();const raw=callback(question(f));
  await Promise.all([f.engine.accept(raw),f.engine.accept(raw)]);assert.equal(f.submits.length,1);await f.close();
});
test('same native question IDs in different projects remain bound to their original tasks',async t=>{
  const f=await fixture(t);f.states.set('b',state({title:'Project B',cwd:'D:/project-b'}));await f.tick('a');await f.tick('b');
  assert.equal(f.sends.length,2);const a=question(f,'a'),b=question(f,'b');
  await f.engine.accept(callback(a,{message_id:b.messageId}));assert.equal(f.submits.length,0);
  await f.engine.accept(callback(b));assert.equal(f.submits.length,1);assert.equal(f.submits[0][0],'b');
  assert.equal(f.submits[0][2].restoreMessage.cwd,'D:/project-b');await f.close();
});
test('pause disables old card controls and restart recovers the same pending card',async t=>{
  const f=await fixture(t);await f.tick();const id=question(f).messageId;
  await f.engine.pause('暂时离线');assert.equal(question(f).status,'pending');
  assert.equal(f.patches.at(-1).card.header.title.content,'暂时离线');
  await f.restart();await f.tick();assert.equal(question(f).messageId,id);assert.equal(f.sends.length,1);
  assert.equal(f.patches.at(-1).card.header.title.content,'Codex 需要你回答');await f.close();
});
test('completion observed before restart is delivered once after restart',async t=>{
  const f=await fixture(t);f.states.set('a',state({withQuestion:false}));await f.tick();
  f.states.set('a',state({status:'completed',withQuestion:false}));await f.restart();await f.tick();
  assert.equal(f.sends.length,1);assert.equal(f.sends[0].card.header.title.content,'Codex 有新结果');
  await f.restart();await f.tick();assert.equal(f.sends.length,1);await f.close();
});
test('already finished historical turns do not create completion notifications',async t=>{
  const f=await fixture(t);f.states.set('a',state({status:'completed',withQuestion:false}));await f.tick();await f.restart();await f.tick();
  assert.equal(f.sends.length,0);await f.close();
});
test('stop during card update prevents native submission',async t=>{
  const f=await fixture(t);await f.tick();let enteredResolve,release;
  const entered=new Promise(r=>enteredResolve=r),hold=new Promise(r=>release=r);
  f.engine.patchCard=async()=>{enteredResolve();await hold;};
  const accept=f.engine.accept(callback(question(f)));await entered;f.engine.stopping=true;release();await accept;
  assert.equal(f.submits.length,0);await f.restart();await f.tick();
  assert.equal(question(f).status,'pending');await f.engine.accept(callback(question(f)));
  assert.equal(f.submits.length,1);await f.close();
});
test('special approval reminder updates the original card when its request ends',async t=>{
  const f=await fixture(t);const current=state({withQuestion:false});
  current.requests=[{id:7,method:'item/fileChange/requestApproval',params:{}}];f.states.set('a',current);await f.tick();
  assert.equal(f.sends.length,1);current.requests[0].completed=true;await f.tick();
  assert.equal(f.sends.length,1);assert.equal(f.patches.at(-1).card.header.title.content,'该提示已结束');await f.close();
});
test('expired button refreshes the same card and the new binding can submit',async t=>{
  const f=await fixture(t);await f.tick();const old=structuredClone(question(f));f.advance(7*24*60*60*1000+1);
  await f.engine.accept(callback(old));assert.equal(f.submits.length,0);await f.engine.tick();
  assert.equal(f.sends.length,1);assert.equal(question(f).messageId,old.messageId);assert.notEqual(question(f).localId,old.localId);
  await f.engine.accept(callback(question(f)));assert.equal(f.submits.length,1);await f.close();
});
test('ambiguous card delivery is recovered with the same UUID even after desktop answered',async t=>{
  const f=await fixture(t);const send=f.engine.sendCard;let first=true;
  f.engine.sendCard=async(...args)=>{const id=await send(...args);if(first){first=false;throw Error('response_timeout');}return id;};
  await f.tick();assert.equal(f.sends.length,1);assert.equal(question(f).messageId,null);
  f.states.set('a',state({answer:'电脑已答'}));f.advance(11000);await f.tick();
  assert.equal(f.sends.length,1);assert.equal(question(f).messageId,f.sends[0].id);
  assert.equal(f.patches.at(-1).card.header.title.content,'该任务已在电脑端处理');await f.close();
});

test('new question is urgently notified once and same-card updates and restart do not repeat it',async t=>{
  const f=await fixture(t);await f.tick();
  const q=question(f),id=q.messageId;
  assert.deepEqual(f.urgents,[id]);assert.equal(q.urgency.status,'sent');
  assert.equal(q.urgency.messageId,id);assert.equal(q.urgency.attempts,1);
  await f.tick();await f.restart();await f.tick();
  f.states.set('a',state({answer:'电脑已处理'}));await f.tick();
  assert.equal(f.sends.length,1);assert.deepEqual(f.urgents,[id]);await f.close();
});
test('new attention and completion notifications each receive their own urgent notification',async t=>{
  const f=await fixture(t),current=state({withQuestion:false});
  current.requests=[{id:8,method:'item/permissions/requestApproval',params:{}}];
  f.states.set('a',current);await f.tick();
  const completed=state({withQuestion:false,status:'completed'});completed.requests=current.requests;
  f.states.set('a',completed);await f.tick();
  assert.equal(f.sends.length,2);assert.deepEqual(f.urgents,f.sends.map(s=>s.id));
  assert.deepEqual(Object.values(f.store.data.outbox).map(e=>(e.urgency??e.resultDelivery.parts[0].urgency).status),['sent','sent']);
  await f.tick();assert.equal(f.urgents.length,2);await f.close();
});
test('urgent failure retries only urgency and never resends the original question card',async t=>{
  const f=await fixture(t);let calls=0;
  f.engine.urgentCard=async id=>{f.urgents.push(id);if(++calls===1)throw Error('urgent_temporarily_unavailable');};
  await f.tick();const q=question(f);
  assert.equal(f.sends.length,1);assert.equal(q.status,'pending');assert.equal(q.urgency.status,'pending');
  assert.equal(q.urgency.attempts,1);await f.tick();assert.equal(calls,1);
  f.advance(2000);await f.engine.tick();
  assert.equal(calls,2);assert.equal(f.sends.length,1);assert.equal(q.urgency.status,'sent');
  assert.deepEqual(f.urgents,[q.messageId,q.messageId]);await f.close();
});
test('pending urgency survives restart with the original message binding',async t=>{
  const f=await fixture(t);
  f.engine.urgentCard=async id=>{f.urgents.push(id);throw Error('urgent_timeout');};
  await f.tick();const id=question(f).messageId;
  assert.equal(question(f).urgency.status,'pending');
  await f.restart();await f.tick();assert.equal(f.urgents.length,1);
  f.advance(2000);await f.engine.tick();
  assert.equal(f.sends.length,1);assert.deepEqual(f.urgents,[id,id]);
  assert.equal(question(f).urgency.status,'sent');assert.equal(question(f).urgency.attempts,2);
  await f.close();
});
test('already-sent legacy records without urgency are not urgently notified on restart',async t=>{
  const f=await fixture(t);await f.tick();delete question(f).urgency;f.urgents.length=0;
  f.store.data.outbox.legacy={id:'legacy-event',kind:'completion',threadId:'a',turnId:'old',
    status:'completed',summary:'old',taskTitle:'old',createdAt:1,deliveryStatus:'sent',messageId:'legacy-message'};
  await f.store.save();await f.restart();await f.tick();
  assert.equal(f.sends.length,1);assert.deepEqual(f.urgents,[]);
  assert.equal(question(f).urgency,undefined);assert.equal(f.store.data.outbox.legacy.urgency,undefined);
  await f.close();
});
test('closed questions skip their pending urgency instead of retrying stale reminders',async t=>{
  const f=await fixture(t);
  f.engine.urgentCard=async id=>{f.urgents.push(id);throw Error('urgent_failed');};
  await f.tick();const id=question(f).messageId;
  f.states.set('a',state({answer:'已在电脑回答'}));await f.tick();
  assert.equal(question(f).status,'closed');assert.equal(question(f).urgency.status,'skipped');
  f.advance(60000);await f.restart();await f.tick();
  assert.equal(f.sends.length,1);assert.deepEqual(f.urgents,[id]);await f.close();
});
test('resolved attention skips pending urgency while preserving original card status updates',async t=>{
  const f=await fixture(t),current=state({withQuestion:false});
  current.requests=[{id:9,method:'item/fileChange/requestApproval',params:{}}];
  f.states.set('a',current);
  f.engine.urgentCard=async id=>{f.urgents.push(id);throw Error('urgent_failed');};
  await f.tick();current.requests=[];await f.tick();
  const entry=Object.values(f.store.data.outbox)[0];
  assert.equal(entry.resolved,true);assert.equal(entry.urgency.status,'skipped');
  assert.equal(f.patches.at(-1).card.header.title.content,'该提示已结束');
  assert.equal(f.urgents.length,1);assert.equal(f.sends.length,1);await f.close();
});
test('completion urgency failure recovers after restart without repeating completion card',async t=>{
  const f=await fixture(t);f.states.set('a',state({withQuestion:false}));await f.tick();
  f.engine.urgentCard=async id=>{f.urgents.push(id);throw Error('urgent_failed');};
  f.states.set('a',state({withQuestion:false,status:'completed'}));await f.tick();
  const entry=Object.values(f.store.data.outbox)[0],id=entry.messageId;
  assert.equal(entry.deliveryStatus,'sent');assert.equal(entry.resultDelivery.parts[0].urgency.status,'pending');
  await f.restart();f.advance(2000);await f.tick();
  assert.equal(f.sends.length,1);assert.deepEqual(f.urgents,[id,id]);
  assert.equal(Object.values(f.store.data.outbox)[0].resultDelivery.parts[0].urgency.status,'sent');await f.close();
});
test('stop after card delivery defers urgency until restart without another card send',async t=>{
  const f=await fixture(t),send=f.engine.sendCard;
  f.engine.sendCard=async(...args)=>{const id=await send(...args);f.engine.stopping=true;return id;};
  await f.tick();
  assert.equal(f.sends.length,1);assert.equal(f.urgents.length,0);assert.equal(question(f).urgency.status,'pending');
  await f.restart();await f.tick();
  assert.equal(f.sends.length,1);assert.deepEqual(f.urgents,[question(f).messageId]);await f.close();
});


test('normal default keeps question, answer and result delivery with zero urgent calls',async t=>{
 const f=await fixture(t);delete f.transports.urgentEnabled;await f.restart();await f.tick();
 const q=question(f);assert.equal(q.urgency.status,'skipped');assert.equal(f.sends.length,1);
 await f.engine.accept(callback(q));assert.equal(f.submits.length,1);
 f.states.set('a',state({status:'completed',answer:'完整可读',clientId:q.clientMessageId}));await f.tick();
 assert.equal(question(f).desiredStatus,'已通过飞书处理');assert.equal(f.sends.length,2);
 assert.equal(f.urgents.length,0);await f.restart();await f.tick();assert.equal(f.sends.length,2);assert.equal(f.urgents.length,0);await f.close();
});

test('normal mode cancels old pending urgency before retry without resending question',async t=>{
 const f=await fixture(t);let calls=0;f.engine.urgentCard=async()=>{calls++;throw Error('temporary');};
 await f.tick();assert.equal(question(f).urgency.status,'pending');assert.equal(calls,1);
 f.transports.urgentEnabled=false;await f.restart();await f.tick();
 assert.equal(question(f).urgency.status,'skipped');assert.equal(f.urgents.length,0);assert.equal(f.sends.length,1);await f.close();
});
