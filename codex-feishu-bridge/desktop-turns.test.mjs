import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedTurns, activeTurn, turnCompletion, createCompletionTracker, SUMMARY_LIMIT} from './desktop-turns.mjs';

const turn = (turnId, status = 'inProgress', items = []) => ({turnId, status, items});
const final = (text, extra = {}) => ({type:'agentMessage', id:'answer', phase:'final_answer', text, ...extra});
const state = (...turns) => ({turns});
const canonical = (entitiesByKey, values, extra = {}) => ({
  turns: [],
  turnHistory: {kind:'canonical', history:{
    entitiesByKey, isComplete:true, generation:0,
    islands:[{id:'tail:0', entries:values.map(value => ({key:value,value})),
      newerBoundary:{status:'exhausted'}, olderBoundary:{status:'exhausted'}}],
    ...extra,
  }},
});

test('canonical ordering follows island references, not object insertion order or orphan cache', () => {
  const s = canonical({b:turn('b'), orphan:turn('orphan'), a:turn('a')}, ['a','missing','b']);
  s.turns = [turn('legacy-mirror')];
  const before = JSON.stringify(s);
  assert.deepEqual(orderedTurns(s).map(t => t.turnId), ['a','b']);
  assert.equal(JSON.stringify(s), before);
});

test('multiple islands retain their declared chronology', () => {
  const s = canonical({a:turn('a'),b:turn('b'),c:turn('c')}, [], {
    islands:[
      {entries:[{value:'a'},{value:'b'}],newerBoundary:{status:'gap'}},
      {entries:[{value:'c'}],newerBoundary:{status:'exhausted'}},
    ],
  });
  assert.deepEqual(orderedTurns(s).map(t=>t.turnId), ['a','b','c']);
  assert.equal(activeTurn(s).turnId, 'c');
});

test('turn IDs deduplicate with latest data in first chronological position', () => {
  const s = canonical({a:turn('a'),b:turn('b'),copy:turn('a','completed',[final('done')])}, ['a','b','copy']);
  assert.deepEqual(orderedTurns(s).map(t=>[t.turnId,t.status]), [['a','completed'],['b','inProgress']]);
  assert.deepEqual(orderedTurns(state(turn('a'),turn('a','failed'))).map(t=>t.status), ['failed']);
});

test('malformed canonical history fails closed; legacy arrays remain supported', () => {
  assert.deepEqual(orderedTurns(null), []);
  assert.deepEqual(orderedTurns({turns:[turn('old')],turnHistory:{kind:'canonical',history:{}}}), []);
  assert.equal(activeTurn(state(null,turn('current'))).turnId, 'current');
});

test('activeTurn never resurrects older running turns after newer completed or pending placeholders', () => {
  assert.equal(activeTurn(state(turn('old'),turn('latest','completed'))), null);
  assert.equal(activeTurn(state(turn('old'),{status:'inProgress',items:[]})), null);
  assert.equal(activeTurn(state(turn('old'),turn('latest'))).turnId, 'latest');
});

test('canonical activeTurn requires an exhausted newest boundary', () => {
  const s = canonical({a:turn('a')}, ['a']);
  s.turnHistory.history.islands[0].newerBoundary.status = 'gap';
  assert.equal(activeTurn(s), null);
});

test('completion selects only explicit final answer text and caps Unicode characters', () => {
  const s = state(turn('a','completed',[
    {type:'reasoning',text:'REASONING MUST NOT LEAK'},
    {type:'toolCall',text:'TOOL MUST NOT LEAK'},
    final('中'.repeat(325) + '😀'),
    {type:'agentMessage',phase:'commentary',text:'COMMENTARY MUST NOT LEAK'},
  ]));
  const c = turnCompletion(s,'a');
  assert.equal(c.status,'completed');
  assert.equal(c.summarySource,'explicit_final');
  assert.equal(Array.from(c.summary).length,SUMMARY_LIMIT);
  assert.equal(c.summaryTruncated,true);
  assert.equal(c.summary.endsWith('…'),true);
  assert.equal(c.summary.includes('LEAK'),false);
});

test('unphased terminal last agentMessage supports ordinary final replies', () => {
  const c = turnCompletion(state(turn('a','completed',[
    {type:'agentMessage',phase:'commentary',text:'Earlier progress'},
    {type:'agentMessage',id:'plain',text:'  最后结果\n已经完成。  '},
  ])),'a');
  assert.equal(c.summary,'最后结果 已经完成。');
  assert.equal(c.summarySource,'terminal_last_agent_message');
  assert.equal(c.agentMessageId,'plain');
});

test('commentary, non-string text, async question messages and unknown phases never become summaries', () => {
  for (const item of [
    {type:'agentMessage',phase:'commentary',text:'not final'},
    {type:'agentMessage',phase:'analysis',text:'private reasoning'},
    {type:'agentMessage',text:{secret:'not text'}},
    {type:'agentMessage',text:'question',questions:[{title:'question'}]},
    {type:'agentMessage',text:'async update',delivery:'async'},
    {type:'agentMessage',phase:'final',text:'unverified phase'},
  ]) assert.equal(turnCompletion(state(turn('a','completed',[item])),'a').summary,'');
  assert.equal(turnCompletion(state(turn('a')),'a'),null);
  assert.equal(turnCompletion(state(turn('a','completed')),'missing'),null);
});

test('failed and interrupted return status only, with no final or tool detail', () => {
  for(const status of ['failed','interrupted']) {
    const c = turnCompletion(state(turn('a',status,[final('do not forward on failure')])),'a');
    assert.equal(c.status,status);
    assert.equal(c.summary,'');
    assert.equal(c.agentMessageId,null);
  }
});

test('initial terminal snapshots are baselines; observed running completion emits exactly once', () => {
  const tracker=createCompletionTracker();
  assert.deepEqual(tracker.observe('thread',state(turn('old','completed',[final('old')]),turn('active'))),[]);
  const next=state(turn('old','completed',[final('old')]),turn('active','completed',[final('new')]));
  const events=tracker.observe('thread',next);
  assert.equal(events.length,1);
  assert.equal(events[0].threadId,'thread');
  assert.equal(events[0].turnId,'active');
  assert.equal(events[0].summary,'new');
  assert.deepEqual(tracker.observe('thread',next),[]);
});

test('a terminal turn first discovered later is still a baseline', () => {
  const tracker=createCompletionTracker();
  tracker.observe('thread',state(turn('active')));
  assert.deepEqual(tracker.observe('thread',state(turn('active'),turn('missed','completed',[final('old')]))),[]);
  assert.deepEqual(tracker.flushPending(),[]);
});

test('threadId and turnId both participate in deduplication', () => {
  const tracker=createCompletionTracker();
  for(const id of ['one','two']) tracker.observe(id,state(turn('same')));
  for(const id of ['one','two']) assert.equal(tracker.observe(id,state(turn('same','completed',[final(id)])))[0].threadId,id);
});

test('completed before final text remains pending and emits on a later text patch', () => {
  const tracker=createCompletionTracker();
  tracker.observe('thread',state(turn('a')));
  assert.deepEqual(tracker.observe('thread',state(turn('a','completed'))),[]);
  assert.equal(tracker.snapshot().pending.length,1);
  const events=tracker.observe('thread',state(turn('a','completed',[final('late text')])));
  assert.equal(events.length,1);
  assert.equal(events[0].summary,'late text');
  assert.equal(tracker.snapshot().pending.length,0);
  assert.deepEqual(tracker.flushPending(),[]);
});

test('explicit pending flush emits status once and can be scoped to a thread', () => {
  const tracker=createCompletionTracker();
  for(const id of ['one','two']) {
    tracker.observe(id,state(turn('a')));
    tracker.observe(id,state(turn('a','completed')));
  }
  assert.deepEqual(tracker.flushPending('one').map(e=>[e.threadId,e.summary]),[['one','']]);
  assert.deepEqual(tracker.flushPending('one'),[]);
  assert.equal(tracker.snapshot().pending.length,1);
  assert.equal(tracker.flushPending()[0].threadId,'two');
  assert.deepEqual(tracker.observe('one',state(turn('a','completed',[final('late after fallback')]))),[]);
});

test('failed and interrupted transitions emit immediately without waiting for text', () => {
  const tracker=createCompletionTracker();
  tracker.observe('thread',state(turn('a'),turn('b')));
  assert.deepEqual(tracker.observe('thread',state(turn('a','failed'),turn('b','interrupted'))).map(e=>e.status),['failed','interrupted']);
  assert.equal(tracker.snapshot().pending.length,0);
});

test('snapshots are detached metadata and text is never executed', () => {
  const tracker=createCompletionTracker();
  tracker.observe('thread',state(turn('a')));
  tracker.observe('thread',state(turn('a','completed')));
  const view=tracker.snapshot();
  view.pending[0].summary='tampered';
  assert.equal(tracker.snapshot().pending[0].summary,'');
  const text='process.exit(99); $([malicious])';
  assert.equal(tracker.observe('thread',state(turn('a','completed',[final(text)])))[0].summary,text);
  assert.throws(()=>tracker.observe('',state()),/threadId/);
});
