import test from 'node:test';
import assert from 'node:assert/strict';
import {createHealthDelivery} from './supervisor.mjs';
const config={larkCliPath:'fixture',profileName:'fixture',recipient:'ou_fixture',interactionChatId:'oc_input',resultChatId:'oc_result'};
test('health delivery sends one ordinary result message without exposing an urgency transport',async()=>{
 const calls=[];let settings;
 const delivery=createHealthDelivery(config,{createTransport:value=>{settings=value;return {call:async(...args)=>{calls.push(args);return {data:{message_id:'om_fixture'}};}};}});
 assert.equal(await delivery.sendCard({schema:'2.0'},'stable-id'),'om_fixture');assert.equal(delivery.urgentCard,undefined);
 assert.equal(settings.profileName,'fixture');assert.ok(calls[0][0].includes('oc_result'));assert.ok(!calls[0][0].includes('oc_input'));
 assert.ok(calls[0][0].includes('--as'));assert.equal(calls[0][0].at(-1),'stable-id');
 assert.equal(calls.length,1);assert.ok(!calls[0][0].includes('urgent_app'));
});
test('unconfirmed ordinary fault send cannot be recorded as successful',async()=>{
 const delivery=createHealthDelivery(config,{createTransport:()=>({call:async()=>({data:{}})})});
 await assert.rejects(()=>delivery.sendCard({},'id'),/unconfirmed/);
});
