const plain = content => ({tag:'plain_text', content:String(content)});
export const escapeCardText = value => String(value ?? '').replace(/[&<>*~\[\]#_]/g,c=>`&#${c.charCodeAt(0)};`);
export function questionCard(q, status='等待回答', answer=null) {
  const pending=status==='等待回答', md=escapeCardText;
  return {schema:'2.0',config:{update_multi:true,enable_forward:false,width_mode:'default',summary:{content:pending?'Codex 需要你回答':status}},
    header:{title:plain(pending?'Codex 需要你回答':status),subtitle:plain(q.taskTitle),template:pending?'blue':status.includes('未')?'orange':'green'},
    body:{padding:'12px',vertical_spacing:'12px',elements:[
      {tag:'markdown',content:`**${md(q.title)}**`},
      ...(answer?[{tag:'markdown',content:`回答：${md(answer)}`}]:[]),
      ...(pending?[
        ...q.options.flatMap((choice,i)=>[
          {tag:'markdown',content:`**${String.fromCharCode(65+i)}.** ${md(choice)}`},
          {tag:'button',text:plain(`选择 ${String.fromCharCode(65+i)}`),type:i===0?'primary_filled':'default',width:'fill',
            behaviors:[{type:'callback',value:{question_id:q.localId,choice}}]}
        ]),
        {tag:'form',name:`reply_${q.localId}`,elements:[
          {tag:'input',name:'answer',required:true,max_length:500,placeholder:plain('也可以填写自己的回答'),label:plain('文字回答')},
          {tag:'button',name:`submit_${q.localId}`,form_action_type:'submit',text:plain('提交文字回答'),type:'default',width:'fill'}]}
      ]:[{tag:'markdown',text_size:'notation',content:'此问题的回答入口已关闭。'}])
    ]}};
}
export function resultCard({taskTitle,status,summary}) {
  const title=status==='completed'?'Codex 有新结果':status==='failed'?'Codex 任务遇到问题':'Codex 任务已中断';
  return {schema:'2.0',config:{update_multi:true,enable_forward:false,summary:{content:`${title}：${taskTitle}`}},
    header:{title:plain(title),subtitle:plain(taskTitle),template:status==='completed'?'green':'orange'},
    body:{elements:[{tag:'markdown',content:escapeCardText(summary||'请查看电脑端的任务状态。')}]}};
}
export function attentionCard({taskTitle,resolved=false,desktopHandled=false}) {
  const title=desktopHandled?'该任务已在电脑端处理':resolved?'该提示已结束':'Codex 等待你处理';
  return {schema:'2.0',config:{update_multi:true,enable_forward:false,summary:{content:`${title}：${taskTitle}`}},
    header:{title:plain(title),subtitle:plain(taskTitle),template:resolved?'green':'orange'},
    body:{elements:[{tag:'markdown',content:desktopHandled?'电脑端已接受这个问题的回答。':resolved?
      '原来的待处理提示已经结束，具体结果请查看电脑端任务。':'这个任务正在等待电脑端的授权或其他操作，请查看电脑端提示。'}]}};
}
