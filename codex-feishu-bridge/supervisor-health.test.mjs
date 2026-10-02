import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerHealthMonitor,failureCode} from './supervisor-health.mjs';
function fixture() {
 let time=100000;const m=new WorkerHealthMonitor({now:()=>time,settleMs:10000});
 const arg={pid:123,instanceId:'current',health:{pid:123,instanceId:'current',status:'running',updatedAt:time,
 health:{running:true,connected:true,metadataUpdatedAt:time,unfreshSubscribedCount:0,freshStateCount:2,codexVersion:'99.1.0.0'}}};
 return {m,arg,advance(ms){time+=ms;arg.health.updatedAt=time;arg.health.health.metadataUpdatedAt=time;}};
}
test('new application version with actual fresh state becomes healthy after settling',()=>{const f=fixture();assert.equal(f.m.inspect(f.arg).mode,'settling');f.advance(10000);assert.deepEqual(f.m.inspect(f.arg),{mode:'healthy',healthy:true,details:{codexVersion:'99.1.0.0'}});});
test('stale heartbeat, old worker and old supervisor cannot announce recovery',()=>{for (const field of ['pid','instanceId','updatedAt']) {const f=fixture();f.arg.health[field]=field==='instanceId'?'old':1;assert.equal(f.m.inspect(f.arg).healthy,false);}});
test('connected with no loaded task waits without false failure or recovery',()=>{const f=fixture();f.arg.health.health.freshStateCount=0;assert.equal(f.m.inspect(f.arg).mode,'waiting_for_task');});
test('snapshot and metadata failures cannot be called ready',()=>{for (const [key,value,reason] of [['unfreshSubscribedCount',1,'state_unavailable'],['metadataUpdatedAt',1,'metadata_unavailable']]) {const f=fixture();f.arg.health.health[key]=value;assert.equal(f.m.inspect(f.arg).reason,reason);}});
test('explicit protocol incompatibility is immediate and survives stale running heartbeat',()=>{const f=fixture();f.m.observe({stage:'connection_failed',code:'protocol_incompatible'});assert.deepEqual(f.m.inspect(f.arg),{mode:'unhealthy',healthy:false,reason:'protocol_incompatible',immediate:true});});
test('unknown diagnostics never leave classifier; callback errors get useful fixed cause',()=>{assert.equal(failureCode('private arbitrary text'),'connection_unavailable');assert.equal(failureCode('listener_disconnected'),'listener_unavailable');});
test('worker restart requires new continuous healthy interval',()=>{const f=fixture();f.m.inspect(f.arg);f.advance(10000);assert.equal(f.m.inspect(f.arg).mode,'healthy');f.m.reset();assert.equal(f.m.inspect(f.arg).mode,'settling');});
