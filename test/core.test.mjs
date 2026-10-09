import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/store.mjs';
import {createService,createMcpHandler,answerWithOpenAI,UI_URI} from '../src/core.mjs';
const cards=[{question:'第一题',answer:'答案 A'},{question:'第二题',answer:'答案 B'}];
const setup=generate=>createService(new MemoryStore(),generate||(async(card,q)=>card.answer+':'+q));
async function board(service,owner='alice'){return (await service.call('create_board',{title:'两题测试',cards},owner)).board;}
test('follow-ups stay in their card and user namespace',async()=>{
 const service=setup(); const b=await board(service);
 await service.call('ask_card',{boardId:b.id,cardId:b.cards[1].id,question:'为什么',requestId:'r1'},'alice');
 const restored=(await service.call('get_board',{boardId:b.id},'alice')).board;
 assert.equal(restored.cards[0].followups.length,0);
 assert.equal(restored.cards[1].followups[0].answer,'答案 B:为什么');
 assert.equal('pending' in restored.cards[1],false);
 await assert.rejects(service.call('get_board',{boardId:b.id},'bob'),/无权/);
 await assert.rejects(service.call('get_board',{boardId:b.id},''),/登录/);
});
test('duplicate calls return the existing answer without new inference',async()=>{
 let count=0;const service=setup(async()=>{count++;return '回答';});const b=await board(service);
 const args={boardId:b.id,cardId:b.cards[0].id,question:'追问',requestId:'same'};
 assert.deepEqual(await service.call('ask_card',args,'alice'),await service.call('ask_card',args,'alice'));
 assert.equal(count,1);
 await assert.rejects(service.call('ask_card',{...args,question:'另一个问题'},'alice'),/原请求不同/);
});
test('different cards can finish concurrently without losing either result',async()=>{
 const service=setup(async(_,q)=>{await new Promise(resolve=>setTimeout(resolve,5));return q;});const b=await board(service);
 await Promise.all(b.cards.map((c,i)=>service.call('ask_card',{boardId:b.id,cardId:c.id,question:'问题'+i,requestId:'r'+i},'alice')));
 const result=(await service.call('get_board',{boardId:b.id},'alice')).board;
 assert.deepEqual(result.cards.map(c=>c.followups.length),[1,1]);
});
test('same-card requests are serialized and errors release a retry',async()=>{
 let release;let fail=true;
 const service=setup(async()=>{if(fail){await new Promise(resolve=>{release=resolve;});throw Error('provider error');}return '已恢复';});
 const b=await board(service);const args={boardId:b.id,cardId:b.cards[0].id,question:'问题',requestId:'one'};
 const first=service.call('ask_card',args,'alice');
 while(!release)await new Promise(resolve=>setTimeout(resolve,1));
 await assert.rejects(service.call('ask_card',{...args,requestId:'two'},'alice'),/解答中/);
 const failed=assert.rejects(first,/provider error/);release();await failed;fail=false;
 assert.equal((await service.call('ask_card',args,'alice')).followup.answer,'已恢复');
});
test('model receives this card history only and credentials never enter input',async()=>{
 let sent;
 const answer=await answerWithOpenAI({question:'本题',answer:'原答',followups:[{question:'旧问',answer:'旧答'}]},'新问',{OPENAI_API_KEY:'test-secret',OPENAI_MODEL:'test-model'},async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'局部解答'}]}]});
 });
 assert.equal(answer,'局部解答');assert.equal(sent.store,false);
 assert.deepEqual(sent.input.map(v=>v.content),['当前题目：\n本题','原答','旧问','旧答','新问']);
 assert.equal(JSON.stringify(sent).includes('test-secret'),false);
 await assert.rejects(answerWithOpenAI({},'问',{}),/尚未配置/);
});
test('MCP discovery, embedded resource, authentication and tool errors',async()=>{
 const handler=createMcpHandler(setup(),'<html>widget</html>');
 const request=(method,params)=>new Request('http://localhost/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const listed=await (await handler(request('tools/list'),null)).json();
 assert.equal(listed.result.tools.length,3);
 const ask=listed.result.tools.find(t=>t.name==='ask_card');assert.deepEqual(ask._meta.ui.visibility,['app']);
 assert.equal(ask._meta.ui.resourceUri,undefined);
 const resource=await (await handler(request('resources/read',{uri:UI_URI}),null)).json();
 assert.equal(resource.result.contents[0].mimeType,'text/html;profile=mcp-app');
 assert.equal((await handler(request('tools/call',{name:'get_board',arguments:{boardId:'missing'}}),null)).status,401);
 const error=await (await handler(request('tools/call',{name:'get_board',arguments:{boardId:'missing'}}),'alice')).json();
 assert.equal(error.result.isError,true);
});
test('reject invalid card IDs and oversized initial boards',async()=>{
 const service=setup();const b=await board(service);
 await assert.rejects(service.call('ask_card',{boardId:b.id,cardId:'missing',question:'问',requestId:'id'},'alice'),/题目不存在/);
 await assert.rejects(service.call('create_board',{title:'测试',cards:[]},'alice'),/1–30/);
});

test('capacity is checked before paying for another generation',async()=>{
 let count=0;const store=new MemoryStore();
 const service=createService(store,async()=>{count++;return 'reply';});
 const b=await board(service);
 const record=await store.read('alice',b.id);
 record.board.cards[0].answer='汉'.repeat(580000);
 await store.compareAndSwap('alice',b.id,record.version,record.board);
 await assert.rejects(service.call('ask_card',{boardId:b.id,cardId:b.cards[0].id,question:'容量测试',requestId:'capacity'},'alice'),/空间不足/);
 assert.equal(count,0);
});

test('an expired request cannot clear a newer retry lease',async()=>{
 let clock=0,releaseOld,finishNew,count=0;
 const service=createService(new MemoryStore(),async()=>{
  count++;
  if(count===1){await new Promise(resolve=>{releaseOld=resolve;});throw Error('old failure');}
  await new Promise(resolve=>{finishNew=resolve;});return 'new answer';
 },{now:()=>clock});
 const b=await board(service);const args={boardId:b.id,cardId:b.cards[0].id,question:'原追问',requestId:'retry'};
 const old=service.call('ask_card',args,'alice');
 while(!releaseOld)await new Promise(resolve=>setTimeout(resolve,1));
 clock=120001;
 await assert.rejects(service.call('ask_card',{...args,question:'不同追问'},'alice'),/原请求不同/);
 const newer=service.call('ask_card',args,'alice');
 while(!finishNew)await new Promise(resolve=>setTimeout(resolve,1));
 const rejected=assert.rejects(old,/old failure/);releaseOld();await rejected;
 finishNew();assert.equal((await newer).followup.answer,'new answer');
});
