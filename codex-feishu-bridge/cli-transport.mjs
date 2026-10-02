import {spawn} from 'node:child_process';
export function invokeJson(executable, argv, {input, inputBytes, env=process.env, timeoutMs=30000}={}) {
  return new Promise((resolve,reject)=>{
    const p=spawn(executable,argv,{env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
    let out='',err='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;p.kill();},timeoutMs);
    p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
    p.on('error',()=>{clearTimeout(timer);reject(new Error('cli_start_failed'));});
    p.stdin.on('error',()=>{});
    p.on('close',code=>{
      clearTimeout(timer);
      if(timedOut){reject(new Error('cli_timeout'));return;}
      let parsed;try{parsed=JSON.parse(code===0?out:err);}catch{}
      if(code!==0||parsed?.ok!==true){
        const e=new Error(parsed?'cli_call_failed':'cli_invalid_json_response');
        e.detail={exitCode:code,type:parsed?.error?.type,subtype:parsed?.error?.subtype,code:parsed?.error?.code,message:parsed?.error?.message,missingScopes:parsed?.error?.missing_scopes};
        reject(e);
      }else resolve(parsed);
    });
    p.stdin.end(inputBytes??(input===undefined?undefined:JSON.stringify(input)));
  });
}
