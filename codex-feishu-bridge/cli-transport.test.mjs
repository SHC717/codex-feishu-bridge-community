import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeJson} from './cli-transport.mjs';
test('accepts explicit CLI success',async()=>{const r=await invokeJson(process.execPath,['-e','console.log(JSON.stringify({ok:true,data:{value:1}}))']);assert.equal(r.data.value,1);});
test('rejects exit zero with malformed or non-success output',async()=>{
  await assert.rejects(invokeJson(process.execPath,['-e','console.log("not json")']),/invalid_json/);
  await assert.rejects(invokeJson(process.execPath,['-e','console.log("{}")']),/call_failed/);
});
test('bounds hung helper and terminates only its own subprocess',async()=>{
  const start=Date.now();await assert.rejects(invokeJson(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:200}),/cli_timeout/);
  assert.ok(Date.now()-start<5000);
});

test('raw UTF-8 upload stdin is byte exact rather than JSON quoted',async()=>{
 const raw='中文😀\r\n**完整原文**\n';
 const result=await invokeJson(process.execPath,['-e',"const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,data:{base64:Buffer.concat(b).toString('base64')}})));"],{inputBytes:Buffer.from(raw)});
 assert.equal(result.data.base64,Buffer.from(raw).toString('base64'));
});
