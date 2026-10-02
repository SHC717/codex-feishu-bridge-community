export function destination(value){
  if(!value||!['user','chat'].includes(value.type)||typeof value.id!=='string'||
    !(value.type==='user'?/^ou_[a-zA-Z0-9]+$/:/^oc_[a-zA-Z0-9]+$/).test(value.id))throw Error('invalid_message_destination');
  return {type:value.type,id:value.id};
}
export function messageRoutes(recipient,interactionChatId='',resultChatId=''){
  const legacy=destination({type:'user',id:recipient});
  if(Boolean(interactionChatId)!==Boolean(resultChatId))throw Error('both_classification_chats_required');
  if(interactionChatId&&interactionChatId===resultChatId)throw Error('classification_chats_must_differ');
  return {legacy,interaction:interactionChatId?destination({type:'chat',id:interactionChatId}):legacy,
    result:resultChatId?destination({type:'chat',id:resultChatId}):legacy};
}
export function destinationArgs(value){const d=destination(value);return [d.type==='chat'?'--chat-id':'--user-id',d.id];}
