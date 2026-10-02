import {randomUUID} from 'node:crypto';
import {QuestionBridge} from './bridge-core.mjs';
import {orderedTurns,activeTurn} from './desktop-turns.mjs';
import {extractDesktopQuestions} from './desktop-state.mjs';
import {updateCompletionObservation} from './durable-state.mjs';
import {questionCard,resultCard,attentionCard} from './feishu-cards.mjs';
import {planResult} from './result-format.mjs';
import {messageRoutes,destination} from './message-routing.mjs';

const keyFor=(threadId,nativeId)=>JSON.stringify([threadId,nativeId]);
const HUMAN_REQUESTS=new Set(['item/tool/requestUserInput','item/tool/requestOptionPicker',
  'item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval',
  'mcpServer/elicitation/request','item/plan/requestImplementation']);

// All transports are injected. This class never starts threads or runs answer text.
export class BridgeEngine {
  constructor({store,recipient,getState,submit,sendCard,sendFile,uploadText,patchCard,urgentCard,urgentEnabled=false,interactionChatId='',resultChatId='',emit=()=>{},now=Date.now}) {
    Object.assign(this,{store,recipient,getState,submit,sendCard,sendFile,uploadText,patchCard,urgentCard,urgentEnabled,emit,now});
    this.routes=messageRoutes(recipient,interactionChatId,resultChatId);
    this.bindings=new QuestionBridge({clock:now});this.runtime=new Map();this.byMessage=new Map();
    this.dirty=new Set();this.stopping=false;this.draining=false;
  }
  observe(threadId,state) {
    if(this.stopping)return;
    this.dirty.add(threadId);
    updateCompletionObservation(this.store.data,threadId,state,{now:this.now(),taskTitle:state.title??'Codex 任务'});
  }
  runtimeFor(q){let r=this.runtime.get(q.key);if(!r){r={};this.runtime.set(q.key,r);}return r;}
  status(q,status,answer=null){q.desiredStatus=status;q.desiredAnswer=answer;q.updatedAt=this.now();}
  async save(){await this.store.save();}
  route(entry,channel){
    if(entry.destination)return destination(entry.destination);
    // Existing requests/uncertain sends remain in their original direct chat.
    const legacy=entry.sendAttempted||entry.messageId||(!Object.hasOwn(entry,'fullText')&&entry.kind);
    entry.destination={...(legacy?this.routes.legacy:this.routes[channel])};return entry.destination;
  }
  async deliverResult(entry){
    if(!entry.resultDelivery){
      this.route(entry,'result');entry.resultDelivery=planResult(entry);await this.save();
    }
    const plan=entry.resultDelivery;
    if(plan.version!==1)throw Error('unsupported_result_delivery_version');
    for(const part of plan.parts){
      if(this.stopping)return;
      if(!part.messageId){
        part.sendAttempted=true;await this.save();
        if(this.stopping)return;
        if(part.kind==='file'){
          if(!part.fileKey){
            if(typeof entry.fullText!=='string')throw Error('full_result_source_missing');
            part.fileKey=await this.uploadText(part.fileName,entry.fullText.slice(part.start,part.end));
            if(typeof part.fileKey!=='string'||!part.fileKey.startsWith('file_'))throw Error('missing_file_key');
            await this.save();
          }
          if(this.stopping)return;
          part.messageId=await this.sendFile(part.fileKey,part.id,entry.destination);
        }else part.messageId=await this.sendCard(part.card,part.id,entry.destination);
        if(!part.messageId)throw Error('missing_message_id');
        part.sentAt=this.now();this.armUrgency(part);delete part.card;await this.save();
        this.emit({stage:'result_part_sent',threadId:entry.threadId,turnId:entry.turnId,messageId:part.messageId,
          kind:part.kind,part:plan.parts.indexOf(part)+1,total:plan.parts.length});
      }
      await this.syncUrgency(part);
    }
    entry.messageId=plan.parts[0].messageId;entry.deliveryStatus='sent';entry.sentAt=this.now();
    // Full payload is needed only until all receipts persist. Keep bounded audit metadata.
    delete entry.fullText;await this.save();
    this.emit({stage:'completion_forwarded',threadId:entry.threadId,turnId:entry.turnId,
      messageId:entry.messageId,status:entry.status,parts:plan.parts.length,bytes:plan.sourceBytes,mode:plan.mode});
  }

  armUrgency(entry){
    if(!entry.messageId||entry.urgency)return;
    const ended=!this.urgentEnabled||entry.status==='closed'||(entry.kind==='attention'&&entry.resolved===true);
    entry.urgency={messageId:entry.messageId,status:ended?'skipped':'pending',
      attempts:0,createdAt:this.now(),...(ended?{skippedAt:this.now()}:{} )};
  }
  async syncUrgency(entry){
    const urgency=entry.urgency;
    if(this.stopping||!urgency||urgency.status!=='pending')return;
    if(!entry.messageId||urgency.messageId!==entry.messageId)throw Error('urgent_message_binding_mismatch');
    const ended=()=>entry.status==='closed'||(entry.kind==='attention'&&entry.resolved===true);
    const skip=async()=>{
      urgency.status='skipped';urgency.skippedAt=this.now();delete urgency.retryAt;
      await this.save();
      this.emit({stage:'urgent_skipped',threadId:entry.threadId,messageId:entry.messageId});
    };
    if(!this.urgentEnabled||ended()){await skip();return;}
    if(urgency.retryAt>this.now())return;
    // Persist the independent attempt before invoking transport. No sendCard call
    // is made here, including retries and recovery after a process restart.
    urgency.attempts++;
    await this.save();
    if(this.stopping)return;
    if(!this.urgentEnabled||ended()){await skip();return;}
    try{
      if(typeof this.urgentCard!=='function')throw Error('urgent_transport_missing');
      await this.urgentCard(entry.messageId);
    }catch(error){
      urgency.retryAt=this.now()+Math.min(60000,2000*2**Math.min(urgency.attempts-1,5));
      await this.save();
      this.emit({stage:'urgent_retry',threadId:entry.threadId,messageId:entry.messageId,
        attempts:urgency.attempts,reason:error.message});
      return;
    }
    urgency.status='sent';urgency.sentAt=this.now();delete urgency.retryAt;
    await this.save();
    this.emit({stage:'urgent_sent',threadId:entry.threadId,messageId:entry.messageId,attempts:urgency.attempts});
  }
  async syncCard(q){
    const r=this.runtimeFor(q);if(r.syncing)return r.syncing;
    if(r.retryAt>this.now())return;
    r.syncing=(async()=>{
      while(q.messageId){
        const status=q.desiredStatus,answer=q.desiredAnswer;
        const signature=JSON.stringify([status,answer,q.localId]);
        if(q.syncedSignature===signature)return;
        await this.patchCard(q.messageId,questionCard(q,status,answer));
        q.syncedSignature=signature;await this.save();r.failures=0;r.retryAt=0;
        this.emit({stage:'card_updated',threadId:q.threadId,nativeId:q.nativeId,messageId:q.messageId,status});
      }
    })();
    try{await r.syncing;}catch(error){
      r.failures=(r.failures??0)+1;r.retryAt=this.now()+Math.min(60000,2000*2**Math.min(r.failures-1,5));
      throw error;
    }finally{r.syncing=null;}
  }
  bind(q){
    const r=this.runtimeFor(q);
    if(r.bound&&this.bindings.snapshot(q.localId)?.status!=='expired')return;
    const binding=this.bindings.createQuestion({prompt:q.title,expectedOperatorId:this.recipient,
      choices:q.options,ttlMs:7*24*60*60*1000});
    q.localId=binding.questionId;r.bound=true;q.syncedSignature=null;
    if(q.messageId){this.bindings.bindMessage(q.localId,q.messageId);this.byMessage.set(q.messageId,q.key);}
    this.status(q,'等待回答');
  }
  acceptEvidence(q,native,state){
    if(q.status==='closed')return;
    const items=orderedTurns(state).flatMap(t=>t.items??[]);
    const own=native.acceptedReplies.some(reply=>items.some(item=>item.id===reply.itemId&&q.clientMessageId
      &&[item.id,item.clientUserMessageId,item.clientMessageId].includes(q.clientMessageId)));
    q.status='closed';q.closedAt=this.now();
    this.status(q,own?'已通过飞书处理':native.status==='conflict'?'该问题已有多次回答，请查看电脑端':'该任务已在电脑端处理',native.answer??null);
    this.emit({stage:own?'native_answer_accepted':'desktop_answer_observed',threadId:q.threadId,
      nativeId:q.nativeId,messageId:q.messageId,clientMessageId:q.clientMessageId??null});
  }
  async reconcile(threadId){
    if(this.stopping)return;
    const state=this.getState(threadId);if(!state)return;
    this.observe(threadId,state);this.dirty.delete(threadId);
    const all=extractDesktopQuestions(state).questions,turn=activeTurn(state),items=new Set((turn?.items??[]).map(i=>i.id));
    for(const native of all){
      const key=keyFor(threadId,native.questionItemId);let q=this.store.data.questions[key];
      if(q&&['answered','conflict'].includes(native.status)){this.acceptEvidence(q,native,state);continue;}
      if(!items.has(native.itemId)||native.status!=='unanswered')continue;
      if(!q){
        if(!native.title||native.title.includes('\uFFFD')){this.emit({stage:'invalid_question_text',threadId});continue;}
        q={key,threadId,nativeId:native.questionItemId,turnId:turn.turnId,title:native.title,
          options:[...new Set(native.options.filter(x=>typeof x==='string'&&x.trim()))],taskTitle:state.title??'Codex 任务',
          status:'sending',messageId:null,localId:null,deliveryId:randomUUID(),createdAt:this.now()};
        this.store.data.questions[key]=q;
      }
      if(q.status==='closed')continue;
      if(q.status==='prepared'){
        if(this.runtimeFor(q).preparing)continue;
        q.status='pending';q.clientMessageId=null;this.runtimeFor(q).bound=false;
      }
      if(q.status==='submitting'){
        // An earlier process may have reached Codex before it stopped. Never replay.
        if(!this.runtimeFor(q).attemptedHere)this.status(q,'回答提交结果待核验，请在电脑查看');
        continue;
      }
      this.bind(q);await this.save();
      if(this.stopping)return;
      if(!q.messageId){
        const r=this.runtimeFor(q);if(r.sendRetryAt>this.now())continue;
        try{
          if(this.stopping)return;
          this.route(q,'interaction');q.sendAttempted=true;await this.save();
          if(this.stopping)return;
          q.messageId=await this.sendCard(questionCard(q),q.deliveryId,q.destination);if(!q.messageId)throw Error('missing_message_id');
          this.armUrgency(q);
          // Record delivery before subsequent card operations. Retries reuse deliveryId.
          await this.save();this.bindings.bindMessage(q.localId,q.messageId);this.byMessage.set(q.messageId,key);
          this.emit({stage:'native_question_forwarded',threadId,nativeId:q.nativeId,messageId:q.messageId,turnId:q.turnId});
        }catch(e){r.sendRetryAt=this.now()+10000;throw e;}
      }
      q.status='pending';await this.save();await this.syncUrgency(q);
    }
    const knownTurns=new Map(orderedTurns(state).filter(t=>t.turnId).map(t=>[t.turnId,t]));
    for(const q of Object.values(this.store.data.questions))if(q.threadId===threadId&&q.status!=='closed'){
      const original=knownTurns.get(q.turnId);
      if(original&&['completed','failed','interrupted'].includes(original.status)){
        q.status='closed';q.closedAt=this.now();this.status(q,'原回合已结束，请查看电脑端');
      }
    }
    for(const request of Array.isArray(state.requests)?state.requests:[]){
      if(!HUMAN_REQUESTS.has(request.method)||request.completed===true||request.params?.completed===true)continue;
      if(!['string','number'].includes(typeof request.id))continue;
      const key=JSON.stringify([threadId,'attention',request.method,typeof request.id,request.id]);
      if(!this.store.data.outbox[key])this.store.data.outbox[key]={id:randomUUID(),kind:'attention',threadId,
        requestId:request.id,method:request.method,taskTitle:state.title??'Codex 任务',createdAt:this.now(),deliveryStatus:'pending',destination:{...this.routes.interaction}};
    }
    // These special prompts are notification-only. Disappearance means ended, not necessarily answered.
    for(const entry of Object.values(this.store.data.outbox))if(entry.kind==='attention'&&entry.threadId===threadId&&!entry.resolved){
      if(!(state.requests??[]).some(r=>r.id===entry.requestId&&r.method===entry.method&&r.completed!==true&&r.params?.completed!==true)){
        entry.resolved=true;
        entry.desktopHandled=entry.method==='item/tool/requestUserInput'&&orderedTurns(state).flatMap(t=>t.items??[])
          .some(item=>item.type==='userInputResponse'&&item.requestId===entry.requestId&&item.completed===true);
      }
    }
    await this.save();
  }
  async tick(){
    if(this.stopping||this.draining)return;this.draining=true;
    try{
      for(const entry of Object.values(this.store.data.turns))if(entry.stage==='pending')this.dirty.add(entry.threadId);
      for(const threadId of [...this.dirty]){if(this.stopping)break;try{await this.reconcile(threadId);}catch(e){
        this.dirty.add(threadId);this.emit({stage:'reconcile_retry',threadId,reason:e.message});}
      }
      if(this.stopping)return;
      for(const q of Object.values(this.store.data.questions))try{
        if(this.stopping)break;
        const r=this.runtimeFor(q);
        if(q.status==='closed'&&!q.messageId&&q.sendAttempted&&!(r.sendRetryAt>this.now())){
          try{
            q.messageId=await this.sendCard(questionCard(q,q.desiredStatus,q.desiredAnswer),q.deliveryId,this.route(q,'interaction'));
            if(!q.messageId)throw Error('missing_message_id');this.armUrgency(q);await this.save();
            this.emit({stage:'closed_card_receipt_recovered',threadId:q.threadId,messageId:q.messageId});
          }catch(e){r.sendRetryAt=this.now()+10000;throw e;}
        }
        await this.syncCard(q);
      }catch(e){
        this.emit({stage:'card_sync_retry',threadId:q.threadId,reason:e.message});}
      for(const entry of Object.values(this.store.data.outbox)){
        if(this.stopping)break;
        if(entry.kind==='attention'&&entry.deliveryStatus==='sent'&&entry.messageId&&entry.resolved&&!entry.resolutionSynced&&!(entry.retryAt>this.now())){
          try{await this.patchCard(entry.messageId,attentionCard(entry));entry.resolutionSynced=true;await this.save();
            this.emit({stage:'attention_resolved',threadId:entry.threadId,messageId:entry.messageId,desktopHandled:entry.desktopHandled??false});}
          catch(e){entry.retryAt=this.now()+10000;this.emit({stage:'attention_sync_retry',threadId:entry.threadId,reason:e.message});}
        }
        if(entry.deliveryStatus==='sent'||entry.retryAt>this.now())continue;
        if(entry.resolved){entry.deliveryStatus='sent';entry.skipped=true;continue;}
        try{
          if(entry.kind==='completion'&&(Object.hasOwn(entry,'fullText')||entry.resultDelivery)){
            await this.deliverResult(entry);continue;
          }
          this.route(entry,entry.kind==='attention'?'interaction':'result');entry.sendAttempted=true;
          await this.save();
          if(this.stopping)break;
          const card=entry.kind==='attention'?attentionCard(entry):resultCard(entry);
          entry.messageId=await this.sendCard(card,entry.id,entry.destination);if(!entry.messageId)throw Error('missing_message_id');
          entry.deliveryStatus='sent';entry.sentAt=this.now();this.armUrgency(entry);await this.save();
          this.emit({stage:entry.kind==='attention'?'attention_forwarded':'completion_forwarded',threadId:entry.threadId,
            turnId:entry.turnId??null,messageId:entry.messageId,status:entry.status??null});
        }catch(e){entry.attempts=(entry.attempts??0)+1;entry.retryAt=this.now()+Math.min(60000,2000*2**Math.min(entry.attempts-1,5));
          await this.save();this.emit({stage:'notification_retry',threadId:entry.threadId,reason:e.message});}
        await this.syncUrgency(entry);
      }
      for(const entry of [...Object.values(this.store.data.questions),...Object.values(this.store.data.outbox),...Object.values(this.store.data.outbox).flatMap(e=>e.resultDelivery?.parts??[])]){
        if(this.stopping)break;
        await this.syncUrgency(entry);
      }
      await this.save();
    }finally{this.draining=false;}
  }
  async accept(raw){
    if(this.stopping)return;
    const q=this.store.data.questions[this.byMessage.get(raw.message_id)];if(!q||q.status!=='pending')return;
    const state=this.getState(q.threadId),native=extractDesktopQuestions(state).questions.find(n=>n.questionItemId===q.nativeId);
    if(activeTurn(state)?.turnId!==q.turnId||native?.status!=='unanswered'){this.dirty.add(q.threadId);return;}
    let action=raw.action_value;
    if(raw.action_name===`submit_${q.localId}`&&raw.action_tag==='button')action=JSON.stringify({question_id:q.localId});
    const accepted=this.bindings.receive({type:raw.type,event_id:raw.event_id,operator_id:raw.operator_id,message_id:raw.message_id,
      action_value:action,form_value:raw.form_value||undefined});
    if(!accepted.accepted){if(accepted.code==='expired')this.dirty.add(q.threadId);
      this.emit({stage:'phone_reply_rejected',code:accepted.code});return;}
    q.status='prepared';q.clientMessageId=randomUUID();this.runtimeFor(q).preparing=true;
    const answer=accepted.answer.text||accepted.answer.choice;this.status(q,'正在送回电脑');await this.save();
    await this.syncCard(q).catch(()=>{});
    try{
      if(this.stopping)return;
      const refreshed=this.getState(q.threadId),latest=extractDesktopQuestions(refreshed).questions.find(n=>n.questionItemId===q.nativeId);
      if(q.status==='closed'||activeTurn(refreshed)?.turnId!==q.turnId||latest?.status!=='unanswered'){this.dirty.add(q.threadId);return;}
      if(typeof refreshed.cwd!=='string'||!refreshed.cwd)throw Error('original_workspace_missing');
      const text='<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:q.nativeId,question:q.title,answer}])+'\n</send_user_message_question_reply>';
      const prompt=`${q.title}\n${answer}`,restoreMessage={id:q.clientMessageId,text:prompt,cwd:refreshed.cwd,createdAt:this.now(),
        context:{prompt,messageThreadId:q.threadId,turnTrigger:'send_user_message_async_question',addedFiles:[],fileAttachments:[],
          commentAttachments:[],ideContext:null,imageAttachments:[]},responsesapiClientMetadata:{}};
      if(this.stopping)return;
      q.status='submitting';this.runtimeFor(q).attemptedHere=true;await this.save();
      if(this.stopping){q.status='pending';q.clientMessageId=null;this.runtimeFor(q).bound=false;return;}
      const response=await this.submit(q.threadId,'thread-follower-steer-turn',{conversationId:q.threadId,
        input:[{type:'text',text,text_elements:[]}],attachments:[],clientUserMessageId:q.clientMessageId,restoreMessage},
        {version:1,timeoutMs:30000});
      if(response.resultType!=='success')throw Error('native_submit_failed');
      this.emit({stage:'native_submit_returned',threadId:q.threadId,nativeId:q.nativeId,clientMessageId:q.clientMessageId});
    }catch(e){this.status(q,'暂未确认电脑接受，请查看电脑端');
      this.emit({stage:'native_submit_uncertain',threadId:q.threadId,reason:e.message});}
    finally{
      this.runtimeFor(q).preparing=false;
      if(q.status==='prepared'){q.status='pending';q.clientMessageId=null;this.runtimeFor(q).bound=false;this.status(q,'等待回答');}
      this.dirty.add(q.threadId);await this.save();
    }
  }
  async pause(message='桥接暂时离线，恢复后可回答'){
    this.stopping=true;
    for(const q of Object.values(this.store.data.questions))if(q.messageId&&q.status!=='closed')this.status(q,message);
    await this.save();
    for(const q of Object.values(this.store.data.questions))if(q.messageId)await this.syncCard(q).catch(()=>{});
  }
}
