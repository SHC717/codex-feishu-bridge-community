import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableState} from './durable-state.mjs';
import {BridgeEngine} from './bridge-engine.mjs';
async function setup(t,text){
 const dir=await mkdtemp(join(tmpdir(),'feishu-full-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let store=await DurableState.open(join(dir,'state.json')),now=10000;
 const sends=[],uploads=[],urgent=[],attempts=[];
 const transport={urgentEnabled:true,recipient:'ou_test',interactionChatId:'oc_interaction',resultChatId:'oc_result',getState:()=>null,
 now:()=>now,patchCard:async()=>{},submit:async()=>{},urgentCard:async id=>urgent.push(id),
 sendCard:async(card,id,target)=>send({card,id,target}),sendFile:async(fileKey,id,target)=>send({fileKey,id,target}),
 uploadText:async(name,text)=>{uploads.push({name,text});return 'file_uploaded';}};
 function send(msg){attempts.push(msg);let found=sends.find(x=>x.id===msg.id);if(!found){found={...msg,messageId:'om_'+sends.length};sends.push(found);}return found.messageId;}
 store.data.outbox.result={id:'stable-result',kind:'completion',threadId:'task',turnId:'turn',taskTitle:'任务',status:'completed',fullText:text,summary:'旧摘要',deliveryStatus:'pending'};
 let engine=new BridgeEngine({store,...transport});
 t.after(()=>store.close());
 return {get engine(){return engine;},get entry(){return store.data.outbox.result;},get store(){return store;},sends,uploads,urgent,attempts,transport,
 restart:async()=>{await store.close();store=await DurableState.open(join(dir,'state.json'));engine=new BridgeEngine({store,...transport});now+=60001;}};
}
const pages=()=>Array.from({length:7},(_,i)=>`段落 ${i}\n`+'文字'.repeat(400)).join('\n\n');
test('partial two-page delivery resumes remaining page only and applies urgency per page',async t=>{
 const f=await setup(t,pages()),send=f.engine.sendCard;
 f.engine.sendCard=async(...args)=>{const id=await send(...args);f.engine.stopping=true;return id;};
 await f.engine.tick();assert.equal(f.sends.length,1);assert.equal(typeof f.entry.fullText,'string');
 await f.restart();await f.engine.tick();assert.equal(f.sends.length,2);assert.equal(f.attempts.length,2);
 assert.equal(f.entry.deliveryStatus,'sent');assert.ok(!Object.hasOwn(f.entry,'fullText'));
 assert.deepEqual(f.urgent,f.sends.map(x=>x.messageId));assert.ok(f.sends.every(x=>x.target.id==='oc_result'));
 await f.restart();await f.engine.tick();assert.equal(f.sends.length,2);assert.equal(f.urgent.length,2);
});
test('ambiguous file-message send reuses upload receipt and stable message ID after restart',async t=>{
 const raw='完整😀\r\n'.repeat(6000),f=await setup(t,raw),send=f.engine.sendFile;
 f.engine.sendFile=async(...args)=>{await send(...args);throw Error('response_timeout');};
 await f.engine.tick();assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].text,raw);
 assert.equal(typeof f.entry.fullText,'string');assert.equal(f.sends.length,2);
 await f.restart();await f.engine.tick();assert.equal(f.sends.length,2);assert.equal(f.uploads.length,1);
 assert.equal(f.attempts.at(-1).id,f.sends[1].id);assert.equal(f.entry.deliveryStatus,'sent');
 assert.deepEqual(f.urgent,f.sends.map(x=>x.messageId));
});
test('urgency retry after full payload compaction never resends any result part',async t=>{
 const f=await setup(t,pages());f.engine.urgentCard=async()=>{throw Error('temporary');};
 await f.engine.tick();assert.equal(f.entry.deliveryStatus,'sent');assert.equal(f.sends.length,2);
 await f.restart();await f.engine.tick();assert.equal(f.sends.length,2);assert.equal(f.urgent.length,2);
});
test('pending legacy direct-chat delivery and previously frozen routes remain unchanged',async t=>{
 const f=await setup(t,'text');delete f.entry.fullText;await f.engine.tick();assert.equal(f.sends[0].target.id,'ou_test');
 assert.deepEqual(f.engine.route({destination:{type:'chat',id:'oc_previous'}},'result'),{type:'chat',id:'oc_previous'});
 assert.equal(f.engine.route({sendAttempted:true},'interaction').id,'ou_test');
 assert.equal(f.engine.route({},'interaction').id,'oc_interaction');
});


test('normal mode delivers all result pages without urgency calls',async t=>{
 const f=await setup(t,pages());f.engine.urgentEnabled=false;await f.engine.tick();
 assert.equal(f.entry.deliveryStatus,'sent');assert.equal(f.sends.length,2);assert.equal(f.urgent.length,0);
 assert.ok(f.entry.resultDelivery.parts.every(part=>part.urgency.status==='skipped'));
});
