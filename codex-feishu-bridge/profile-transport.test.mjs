import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileTransport} from './profile-transport.mjs';
for (const profileName of [undefined,'','--profile','name with spaces','x\nother']) {
  test(`invalid profile ${JSON.stringify(profileName)} never starts a process`,()=>{
    let started=false;
    assert.throws(()=>createProfileTransport({profileName,invoke:()=>started=true,spawnChild:()=>started=true}),/explicit_feishu_profile_required/);
    assert.equal(started,false);
  });
}
test('send, urgency, patch and consumer are scoped to the same explicit app',async()=>{
  const calls=[],spawns=[],env={MARKER:'fixture'};
  const transport=createProfileTransport({executable:'fixture-cli',profileName:'notebook-bot',env,
    invoke:async(...values)=>{calls.push(values);return {ok:true};},
    spawnChild:(...values)=>{spawns.push(values);return 'consumer';}});
  const body={user_id_list:['ou_fixture']};
  await transport.call(['im','+messages-send','--as','bot']);
  await transport.call(['im','messages','urgent_app','--as','bot'],body);
  await transport.call(['im','messages','patch','--as','bot'],{content:'fixture'});
  assert.equal(transport.consume(),'consumer');
  for (const [executable,argv,options] of [...calls,...spawns]) {
    assert.equal(executable,'fixture-cli');assert.deepEqual(argv.slice(0,2),['--profile','notebook-bot']);
    assert.equal(argv[argv.indexOf('--as')+1],'bot');assert.equal(options.env,env);
  }
  assert.equal(calls[1][2].input,body);
  assert.deepEqual(spawns[0][1].slice(2),['event','consume','card.action.trigger','--as','bot']);
  assert.equal(spawns[0][2].shell,false);assert.equal(spawns[0][2].windowsHide,true);
});
test('different local profiles do not share a mutable global default',async()=>{
  const apps=[];const invoke=async(executable,argv)=>apps.push(argv[1]);
  const desktop=createProfileTransport({profileName:'desktop-bot',invoke});
  const notebook=createProfileTransport({profileName:'notebook-bot',invoke});
  await desktop.call(['fixture']);await notebook.call(['fixture']);await desktop.call(['fixture']);
  assert.deepEqual(apps,['desktop-bot','notebook-bot','desktop-bot']);
});
test('a nested profile override is rejected before CLI invocation',()=>{
  const transport=createProfileTransport({profileName:'owned-app',invoke:()=>assert.fail('must not run')});
  for(const argv of [['--profile','other'],['--profile=other']])assert.throws(()=>transport.call(argv),/profile_override_refused/);
});

test('file upload keeps explicit bot profile and exact UTF-8 bytes on stdin',async()=>{
 let actual;
 const transport=createProfileTransport({executable:'cli',profileName:'local-app',invoke:async(...args)=>{actual=args;return {ok:true,data:{file_key:'file_ok'}};}});
 await transport.uploadText('完整结果.md','中文😀\r\n');
 assert.deepEqual(actual[1].slice(0,7),['--profile','local-app','im','files','create','--as','bot']);
 assert.deepEqual(actual[1].slice(-2),['--file','file=-']);assert.equal(actual[2].inputBytes.toString(),'中文😀\r\n');
});
