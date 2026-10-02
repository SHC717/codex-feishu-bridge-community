import {spawn} from 'node:child_process';
import {invokeJson} from './cli-transport.mjs';

// Every API call AND the long-lived callback consumer use the same local app.
// Never change the user's active CLI profile or silently fall back to it.
export function createProfileTransport({executable,profileName,env=process.env,invoke=invokeJson,spawnChild=spawn}) {
  if(typeof profileName!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileName))
    throw new Error('explicit_feishu_profile_required');
  const scoped=argv=>{
    if(argv.some(x=>x==='--profile'||x.startsWith('--profile=')))throw new Error('profile_override_refused');
    return ['--profile',profileName,...argv];
  };
  return {
    call:(argv,input)=>invoke(executable,scoped(argv),{input,env}),
    uploadText:(fileName,text)=>invoke(executable,scoped(['im','files','create','--as','bot','--data',JSON.stringify({file_type:'stream',file_name:fileName}),'--file','file=-']),{inputBytes:Buffer.from(text,'utf8'),env,timeoutMs:120000}),
    consume:()=>spawnChild(executable,scoped(['event','consume','card.action.trigger','--as','bot']),
      {env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']})
  };
}
