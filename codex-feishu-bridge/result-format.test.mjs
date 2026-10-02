import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renderInline,renderBlocks,planResult,cardBytes,utf8Ranges} from './result-format.mjs';
import {messageRoutes,destinationArgs} from './message-routing.mjs';
const entry=text=>({id:'result-id',threadId:'task',taskTitle:'格式检查',status:'completed',fullText:text});
test('bold, web links, local paths and unsafe markup stay readable without fetching resources',()=>{
 const text=renderInline('**CPU / GPU** [官网](https://example.com/a(b)) [文件](<D:/folder/a.md>) <at id=all> ![图](https://example.com/a.png)');
 assert.match(text,/\*\*CPU \/ GPU\*\*/);assert.match(text,/https:\/\/example.com\/a%28b%29/);
 assert.match(text,/文件（D:\/folder\/a.md）/);assert.ok(!text.includes('<at'));assert.match(text,/图片：/);
 assert.ok(!renderInline('[x](javascript:alert(1))').includes('](javascript:'));
});
test('paragraphs, headings, lists, tables and code preserve meaningful text',()=>{
 const blocks=renderBlocks('# 标题\n\n- **加粗**\n- 第二项\n\n| 列 A | 列 B |\n| --- | --- |\n| 左 | 右 |\n\n```js\nconst a = 1;\n```');
 assert.deepEqual(blocks,['**标题**','• **加粗**\n• 第二项','**第 1 行**\n列 A：左\n列 B：右','**代码（js）**\n`const a = 1;`']);
});
test('complete text longer than the old summary is sent including its last paragraph',()=>{
 const raw='中文'.repeat(400)+'\n\n最后一段';const p=planResult(entry(raw));
 assert.equal(p.mode,'cards');assert.match(p.parts[0].card.body.elements[0].content,/最后一段$/);
 assert.equal(p.sourceSha256,createHash('sha256').update(raw).digest('hex'));
});
test('structural pagination preserves every block and stays below serialized UTF-8 card budget',()=>{
 const raw=Array.from({length:7},(_,i)=>`**段落 ${i}**\n`+'内容'.repeat(400)).join('\n\n');
 const p=planResult(entry(raw));assert.equal(p.mode,'cards');assert.equal(p.parts.length,3);
 assert.ok(p.parts.every(x=>cardBytes(x.card)<=10000));
 assert.deepEqual(p.parts.flatMap(x=>x.card.body.elements[0].content.split('\n\n')),renderBlocks(raw));
 assert.deepEqual(p.parts.map(x=>x.id),planResult(entry(raw)).parts.map(x=>x.id));
});
test('too many pages and large indivisible code blocks retain exact original in file ranges',()=>{
 for(const raw of ['中文😀\r\n'.repeat(6000),'```\n'+'a'.repeat(10000)+'\n```']){
 const p=planResult(entry(raw),{fileLimit:12000});assert.equal(p.mode,'file');
 const files=p.parts.filter(x=>x.kind==='file');assert.equal(files.map(x=>raw.slice(x.start,x.end)).join(''),raw);
 assert.ok(files.every(x=>Buffer.byteLength(raw.slice(x.start,x.end))<=12000));
 }
});
test('Unicode file boundaries do not split a supplementary code point',()=>{
 const raw='a😀中文'.repeat(100);const spans=utf8Ranges(raw,7);
 assert.equal(spans.map(r=>raw.slice(r.start,r.end)).join(''),raw);
 for(const r of spans)assert.equal(Buffer.from(raw.slice(r.start,r.end)).toString(),raw.slice(r.start,r.end));
});
test('routing supports exact two groups, keeps legacy direct chat and rejects half setup',()=>{
 const r=messageRoutes('ou_test','oc_interaction','oc_result');assert.deepEqual(destinationArgs(r.result),['--chat-id','oc_result']);
 assert.equal(r.legacy.id,'ou_test');assert.throws(()=>messageRoutes('ou_test','oc_same','oc_same'));
 assert.throws(()=>messageRoutes('ou_test','oc_only',''));assert.throws(()=>messageRoutes('ou_test','--oops','oc_result'));
});
