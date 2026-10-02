// Deterministic local formatting only. No model, network or filesystem calls.
import {createHash} from 'node:crypto';
export const CARD_BYTES=10000,MAX_RESULT_CARDS=3,FILE_BYTES=20*1024*1024;
const escape=s=>String(s).replace(/[&<>*~\[\]#_`]/g,c=>`&#${c.charCodeAt(0)};`);
const hash=s=>createHash('sha256').update(s).digest('hex');
const plain=content=>({tag:'plain_text',content:String(content)});

function linkAt(s,start){
  const image=s[start]==='!',begin=start+(image?1:0);
  if(s[begin]!=='[')return null;
  const close=s.indexOf('](',begin+1);if(close<0)return null;
  let end=close+2,depth=1,angle=s[end]==='<';
  if(angle){end=s.indexOf('>)',end+1);if(end<0)return null;end++;}
  else{for(;end<s.length;end++){if(s[end]==='(')depth++;if(s[end]===')'&&!--depth)break;}if(end>=s.length)return null;}
  let url=s.slice(close+2,end);if(angle)url=url.slice(1,-1);
  const label=s.slice(begin+1,close);let safe=null;
  try{const u=new URL(url);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)safe=u.href.replace(/[()\[\]<>]/g,c=>'%'+c.charCodeAt(0).toString(16));}catch{}
  const prefix=image?'图片：':'';
  return {end:end+1,text:safe?`${prefix}[${escape(label)}](${safe})`:`${prefix}${escape(label)}（${escape(url)}）`};
}
export function renderInline(text){
  const s=String(text);let out='',literal='';const flush=()=>{out+=escape(literal);literal='';};
  for(let i=0;i<s.length;){
    const link=(s[i]==='['||s.startsWith('![',i))?linkAt(s,i):null;
    if(link){flush();out+=link.text;i=link.end;continue;}
    if(s.startsWith('**',i)){const end=s.indexOf('**',i+2);if(end>i+2){flush();out+='**'+escape(s.slice(i+2,end))+'**';i=end+2;continue;}}
    if(s[i]==='`'){const end=s.indexOf('`',i+1);if(end>i+1){flush();out+='`'+s.slice(i+1,end).replace(/[&<>]/g,c=>`&#${c.charCodeAt(0)};`)+'`';i=end+1;continue;}}
    literal+=s[i++];
  }
  flush();return out;
}
function cells(line){
  let s=line.trim();if(s.startsWith('|'))s=s.slice(1);if(s.endsWith('|')&&!s.endsWith('\\|'))s=s.slice(0,-1);
  const result=[];let current='',code=false;
  for(let i=0;i<s.length;i++){
    if(s[i]==='\\'&&s[i+1]==='|'){current+='|';i++;continue;}
    if(s[i]==='`')code=!code;
    if(s[i]==='|'&&!code){result.push(current.trim());current='';}else current+=s[i];
  }
  result.push(current.trim());return result;
}
export function renderBlocks(text){
  const lines=String(text).replace(/\r\n?/g,'\n').split('\n'),blocks=[];
  for(let i=0;i<lines.length;){
    if(!lines[i].trim()){i++;continue;}
    const fence=lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if(fence){
      const body=[],mark=fence[1],language=fence[2].trim();i++;
      while(i<lines.length&&!new RegExp('^\\s*'+mark[0]+'{'+mark.length+',}\\s*$').test(lines[i]))body.push(lines[i++]);
      if(i<lines.length)i++;
      // Inline code per line works on mobile clients without fenced-code support.
      const code=body.map(line=>line.includes('`')?escape(line):'`'+line.replace(/[&<>]/g,c=>`&#${c.charCodeAt(0)};`)+'`').join('\n');
      blocks.push('**代码'+(language?'（'+escape(language)+'）':'')+'**\n'+code);continue;
    }
    if(i+1<lines.length&&lines[i].includes('|')&&cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c))){
      const headings=cells(lines[i]);i+=2;let row=0;
      while(i<lines.length&&lines[i].trim()&&lines[i].includes('|')){
        const values=cells(lines[i++]);row++;
        blocks.push('**第 '+row+' 行**\n'+Array.from({length:Math.max(headings.length,values.length)},(_,n)=>
          (headings[n]?renderInline(headings[n]):'列 '+(n+1))+'：'+renderInline(values[n]??'')).join('\n'));
      }
      if(!row)blocks.push(headings.map(renderInline).join(' / '));continue;
    }
    if(/^\s*#{1,6}\s+/.test(lines[i])){blocks.push('**'+escape(lines[i++].replace(/^\s*#{1,6}\s+/,''))+'**');continue;}
    const paragraph=[];
    while(i<lines.length&&lines[i].trim()){
      if(paragraph.length&&(/^\s*(`{3,}|~{3,}|#{1,6}\s)/.test(lines[i])||(i+1<lines.length&&lines[i].includes('|')&&cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c)))))break;
      const line=lines[i++];
      paragraph.push(renderInline(line.replace(/^(\s*)[-*+]\s+/,'$1• ').replace(/^>\s?/,'▎')));
    }
    blocks.push(paragraph.join('\n'));
  }
  return blocks;
}
export function makeResultCard(entry,content,page=1,total=1){
  const title=entry.status==='completed'?'Codex 有新结果':entry.status==='failed'?'Codex 任务遇到问题':'Codex 任务已中断';
  return {schema:'2.0',config:{update_multi:true,enable_forward:false,summary:{content:`${title}：${entry.taskTitle}`}},
    header:{title:plain(title+(total>1?` · ${page}/${total}`:'')),subtitle:plain(entry.taskTitle),template:entry.status==='completed'?'green':'orange'},
    body:{elements:[{tag:'markdown',content:content||'请查看电脑端的任务状态。'}]}};
}
export const cardBytes=card=>Buffer.byteLength(JSON.stringify(card),'utf8');
export function utf8Ranges(text,limit=FILE_BYTES){
  if(!Number.isInteger(limit)||limit<4)throw Error('invalid_file_budget');
  const ranges=[];let start=0,end=0,bytes=0;
  for(const ch of text){const n=Buffer.byteLength(ch,'utf8');if(bytes+n>limit){ranges.push({start,end});start=end;bytes=0;}bytes+=n;end+=ch.length;}
  if(end>start)ranges.push({start,end});return ranges;
}
export function planResult(entry,{cardLimit=CARD_BYTES,maxCards=MAX_RESULT_CARDS,fileLimit=FILE_BYTES}={}){
  const text=typeof entry.fullText==='string'?entry.fullText:(entry.summary||'');
  const sourceBytes=Buffer.byteLength(text,'utf8'),sourceSha256=hash(text);
  const key=i=>hash(entry.id+'|result-v1|'+i).slice(0,32);
  let pages=[],current='',oversize=sourceBytes>cardLimit*maxCards;
  if(!oversize){
    for(const block of renderBlocks(text)){
      if(cardBytes(makeResultCard(entry,block,maxCards,maxCards))>cardLimit){oversize=true;break;}
      const next=current?current+'\n\n'+block:block;
      if(cardBytes(makeResultCard(entry,next,maxCards,maxCards))>cardLimit){pages.push(current);current=block;}else current=next;
      if(pages.length>=maxCards){oversize=true;break;}
    }
    if(current)pages.push(current);
  }
  if(!pages.length&&!oversize)pages=['请查看电脑端的任务状态。'];
  let parts;
  if(oversize||pages.length>maxCards){
    const ranges=utf8Ranges(text,fileLimit);
    const notice=`完整结果较长，正文已保存为 ${ranges.length} 个附件，按编号阅读即可。\n\n正文共 ${sourceBytes.toLocaleString('en-US')} 字节；附件保留原始文字、换行和代码。`;
    parts=[{kind:'card',card:makeResultCard(entry,notice)},...ranges.map((r,i)=>({kind:'file',...r,
      fileName:`Codex完整结果-${hash(entry.id).slice(0,8)}-${i+1}of${ranges.length}.md`}))];
  }else parts=pages.map((content,i)=>({kind:'card',card:makeResultCard(entry,content,i+1,pages.length)}));
  for(const [i,part] of parts.entries()){
    part.id=key(i);part.threadId=entry.threadId;
    if(part.card&&cardBytes(part.card)>cardLimit)throw Error('result_card_budget_exceeded');
  }
  return {version:1,sourceBytes,sourceSha256,mode:parts.some(p=>p.kind==='file')?'file':'cards',parts};
}
