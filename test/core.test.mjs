import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/store.mjs';
import {createService,createMcpHandler,UI_URI,VERSION} from '../src/core.mjs';

const TTL=30*60*1000;
const cards=[
  {question:'第一题：为什么会发生变化？',answer:'答案 A'},
  {question:'第二题独有内容',answer:'答案 B：本题专属解释'}
];
function setup(options={},store=new MemoryStore()) {
  return {store,service:createService(store,options)};
}
async function board(service,owner='alice') {
  return (await service.call('create_board',{title:'两题测试',cards},owner)).board;
}
function ids(b,index=0,requestId='request-1') {
  return {boardId:b.id,cardId:b.cards[index].id,requestId};
}
const queue=(service,args,question='为什么',owner='alice')=>service.call('ask_card',{...args,question},owner);
const submit=(service,args,answer='完整解释',owner='alice')=>service.call('submit_card_answer',{...args,answer},owner);
const readRequest=(service,args,owner='alice')=>service.call('get_card_request',args,owner);


test('native ChatGPT flow queues, reads one card and saves only to that card',async()=>{
  const {service}=setup();const b=await board(service);const args=ids(b,1);
  const queued=await queue(service,args,'能举例吗？');
  assert.equal(queued.request.state,'queued');
  assert.equal(queued.request.question,'能举例吗？');
  assert.equal(queued.followup,undefined);
  assert.match(queued.request.prompt,/get_card_request/);
  assert.match(queued.request.prompt,/submit_card_answer/);
  assert.ok(queued.request.prompt.includes(JSON.stringify(args)));
  const context=await readRequest(service,args);
  assert.equal(context.card.question,cards[1].question);
  assert.equal(context.card.answer,cards[1].answer);
  assert.deepEqual(context.card.followups,[]);
  assert.equal('pending' in context.card,false);
  assert.equal(JSON.stringify(context).includes(cards[0].question),false);
  const saved=await submit(service,args,'例如温度升高时，可以观察到变化。');
  assert.equal(saved.followup.question,'能举例吗？');
  const restored=(await service.call('get_board',{boardId:b.id},'alice')).board;
  assert.equal(restored.cards[0].followups.length,0);
  assert.deepEqual(restored.cards[1].followups,[saved.followup]);
  assert.ok(restored.cards.every(card=>!('pending' in card)));
  const completed=await readRequest(service,args);
  assert.equal(completed.request.state,'completed');
  assert.deepEqual(completed.followup,saved.followup);
  assert.deepEqual((await service.call('open_board',{boardId:b.id},'alice')).board,restored);
});


test('all saved board and request operations are isolated by signed-in owner',async()=>{
  const {service}=setup();const b=await board(service);const args=ids(b);
  await queue(service,args);
  for(const name of ['get_board','open_board']) {
    await assert.rejects(service.call(name,{boardId:b.id},'bob'),/无权/);
  }
  await assert.rejects(queue(service,args,'为什么','bob'),/无权/);
  await assert.rejects(readRequest(service,args,'bob'),/无权/);
  await assert.rejects(submit(service,args,'篡改答案','bob'),/无权/);
  await assert.rejects(service.call('service_status',{},''),/登录/);
  const own=await readRequest(service,args);
  assert.equal(own.request.state,'queued');
  assert.equal((await service.call('get_board',{boardId:b.id},'alice')).board.cards[0].followups.length,0);
});


test('queue retries and answer submissions are idempotent, including concurrent duplicates',async()=>{
  const {service}=setup();const b=await board(service);const args=ids(b);
  const queued=await Promise.all([queue(service,args,'原追问'),queue(service,args,'原追问')]);
  assert.deepEqual(queued[0],queued[1]);
  await assert.rejects(queue(service,args,'改过的追问'),/原请求不同/);
  const answers=await Promise.all([submit(service,args,'先保存的答案'),submit(service,args,'并发重复答案')]);
  assert.deepEqual(answers[0],answers[1]);
  assert.ok(['先保存的答案','并发重复答案'].includes(answers[0].followup.answer));
  assert.deepEqual(await submit(service,args,'之后的不同答案'),answers[0]);
  const cached=await queue(service,args,'原追问');
  assert.equal(cached.request.state,'completed');
  assert.deepEqual(cached.followup,answers[0].followup);
  await assert.rejects(queue(service,args,'改过的追问'),/原请求不同/);
  const saved=(await service.call('get_board',{boardId:b.id},'alice')).board;
  assert.equal(saved.cards[0].followups.length,1);
});


test('the same card accepts one active request while different cards save concurrently',async()=>{
  const {service}=setup();const b=await board(service);
  const args=b.cards.map((_,index)=>ids(b,index,'parallel-'+index));
  await Promise.all(args.map((arg,index)=>queue(service,arg,'问题 '+index)));
  await assert.rejects(queue(service,ids(b,0,'another'),'第二个活跃追问'),/等待 ChatGPT/);
  await Promise.all(args.map((arg,index)=>submit(service,arg,'解答 '+index)));
  const result=(await service.call('get_board',{boardId:b.id},'alice')).board;
  assert.deepEqual(result.cards.map(card=>card.followups.map(f=>f.answer)),[['解答 0'],['解答 1']]);
  const next=await queue(service,ids(b,0,'after-completion'),'完成后继续追问');
  assert.equal(next.request.state,'queued');
});


test('concurrent users can reuse request IDs without sharing answers or context',async()=>{
  const {service}=setup();
  const [alice,bob]=await Promise.all([board(service,'alice'),board(service,'bob')]);
  const a=ids(alice,0,'shared-request-id'),b=ids(bob,0,'shared-request-id');
  await Promise.all([queue(service,a,'Alice 的疑问','alice'),queue(service,b,'Bob 的疑问','bob')]);
  await Promise.all([submit(service,a,'Alice 的解答','alice'),submit(service,b,'Bob 的解答','bob')]);
  assert.equal((await readRequest(service,a,'alice')).followup.answer,'Alice 的解答');
  assert.equal((await readRequest(service,b,'bob')).followup.answer,'Bob 的解答');
  await assert.rejects(readRequest(service,a,'bob'),/无权/);
});


test('follow-up context includes this card history and excludes other cards',async()=>{
  const {service}=setup();const b=await board(service);const previous=ids(b,0,'previous');
  await queue(service,previous,'旧问');await submit(service,previous,'旧答');
  const current=ids(b,0,'current');await queue(service,current,'新问');
  const context=await readRequest(service,current);
  assert.deepEqual(context.card.followups,[{requestId:'previous',question:'旧问',answer:'旧答'}]);
  assert.equal(context.request.question,'新问');
  assert.equal(JSON.stringify(context).includes(cards[1].question),false);
  assert.equal(JSON.stringify(context).includes(cards[1].answer),false);
});


test('failed answer validation or storage leaves the queued request available for retry',async()=>{
  class FailingStore extends MemoryStore {
    failNext=false;
    async compareAndSwap(...args) {
      if(this.failNext){this.failNext=false;throw Error('disk unavailable');}
      return super.compareAndSwap(...args);
    }
  }
  const store=new FailingStore();const {service}=setup({},store);const b=await board(service);const args=ids(b);
  await queue(service,args,'请再解释一次');
  await assert.rejects(submit(service,args,'  '),/不符合要求/);
  store.failNext=true;
  await assert.rejects(submit(service,args,'尚未保存的答案'),/disk unavailable/);
  const pending=await readRequest(service,args);
  assert.equal(pending.request.state,'queued');
  assert.equal(pending.request.question,'请再解释一次');
  assert.deepEqual(pending.card.followups,[]);
  assert.equal((await submit(service,args,'恢复后保存的答案')).followup.answer,'恢复后保存的答案');
});


test('queued requests expire at 30 minutes and an identical retry renews them',async()=>{
  let clock=0;const {service}=setup({now:()=>clock});const b=await board(service);const args=ids(b);
  await queue(service,args,'保持同一个问题');
  clock=TTL-1;
  assert.equal((await readRequest(service,args)).request.state,'queued');
  clock=TTL;
  await assert.rejects(readRequest(service,args),/过期/);
  await assert.rejects(submit(service,args,'过期答案'),/过期/);
  await assert.rejects(queue(service,args,'换成另一个问题'),/原请求不同/);
  assert.equal((await queue(service,args,'保持同一个问题')).request.state,'queued');
  clock=TTL*2-1;
  assert.equal((await readRequest(service,args)).request.state,'queued');
  await submit(service,args,'续期后完成');
  clock=TTL*3;
  assert.equal((await readRequest(service,args)).request.state,'completed');
});


test('a retry before expiry does not keep an abandoned request alive indefinitely',async()=>{
  let clock=0;const {service}=setup({now:()=>clock});const b=await board(service);const args=ids(b);
  await queue(service,args);
  clock=TTL-1;await queue(service,args);
  clock=TTL;
  await assert.rejects(readRequest(service,args),/过期/);
});


test('a new request can replace an expired request, and the expired request cannot write back',async()=>{
  let clock=0;const {service}=setup({now:()=>clock});const b=await board(service);
  const old=ids(b,0,'expired'),current=ids(b,0,'replacement');
  await queue(service,old,'旧问题');clock=TTL;
  await queue(service,current,'新问题');
  await assert.rejects(submit(service,old,'迟到的旧答案'),/过期/);
  assert.equal((await readRequest(service,current)).request.question,'新问题');
  await submit(service,current,'新答案');
  const restored=(await service.call('get_board',{boardId:b.id},'alice')).board;
  assert.deepEqual(restored.cards[0].followups,[{requestId:'replacement',question:'新问题',answer:'新答案'}]);
});


test('capacity is reserved before queueing and protects concurrent card answers',async()=>{
  const {store,service}=setup();const b=await board(service);
  const record=await store.read('alice',b.id);
  record.board.cards[0].answer='汉'.repeat(550000);
  await store.compareAndSwap('alice',b.id,record.version,record.board);
  const first=ids(b,0,'capacity-first'),second=ids(b,1,'capacity-second');
  await queue(service,first,'容量测试一');
  await assert.rejects(queue(service,second,'容量测试二'),/空间不足/);
  await assert.rejects(readRequest(service,second),/不存在/);
  await submit(service,first,'汉'.repeat(20000));
  await queue(service,second,'容量测试二');
  await submit(service,second,'汉'.repeat(20000));
  await assert.rejects(queue(service,ids(b,0,'capacity-third'),'容量测试三'),/空间不足/);
  const saved=await store.read('alice',b.id);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved.board)).length<=1800000);
  assert.deepEqual(saved.board.cards.map(card=>card.followups.length),[1,1]);
});


test('the follow-up limit applies per card and completed requests remain retrievable',async()=>{
  const {service}=setup();const b=await board(service);
  for(let index=0;index<40;index++) {
    const args=ids(b,0,'limit-'+index);
    await queue(service,args,'问题 '+index);await submit(service,args,'答案 '+index);
  }
  await assert.rejects(queue(service,ids(b,0,'limit-40'),'第 41 个问题'),/40 次/);
  assert.equal((await readRequest(service,ids(b,0,'limit-0'))).request.state,'completed');
  assert.equal((await queue(service,ids(b,1,'other-card'),'另一题仍可追问')).request.state,'queued');
});


test('reject invalid identifiers, unknown requests and oversized initial boards',async()=>{
  const {service}=setup();const b=await board(service);
  await assert.rejects(queue(service,{...ids(b),cardId:'missing'}),/题目不存在/);
  await assert.rejects(queue(service,{...ids(b),requestId:'invalid/id'}),/标识无效/);
  await assert.rejects(readRequest(service,ids(b)),/不存在/);
  await assert.rejects(submit(service,ids(b)),/不存在/);
  await assert.rejects(service.call('create_board',{title:'测试',cards:[]},'alice'),/1–30/);
  await assert.rejects(service.call('create_board',{title:'测试',cards:Array.from({length:11},()=>({question:'问',answer:'答'.repeat(20000)}))},'alice'),/内容过长/);
});


test('service status reports the native host and never requires an independent API key',async()=>{
  const {service}=setup();
  assert.deepEqual((await service.call('service_status',{},'alice')).status,{
    version:VERSION,storageReady:true,answerProvider:'chatgpt-host',requiresApiKey:false
  });
  assert.equal(VERSION,'0.3.0');
  const unavailable=setup({status:()=>({storageReady:false})}).service;
  assert.equal((await unavailable.call('service_status',{},'alice')).status.storageReady,false);
});


test('MCP discovery supports 2026-07-28 and exposes host follow-up tools without another component',async()=>{
  const {service}=setup();const handler=createMcpHandler(service,'<html>widget</html>');
  const request=(method,params)=>new Request('http://localhost/mcp',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  });
  const rpc=async(method,params,owner=null)=>(await handler(request(method,params),owner)).json();
  const discovery=await rpc('server/discover');
  assert.deepEqual(discovery.result.supportedVersions,['2026-07-28']);
  assert.deepEqual(discovery.result.capabilities,{tools:{}});
  const initialized=await rpc('initialize',{protocolVersion:'2026-07-28'});
  assert.equal(initialized.result.protocolVersion,'2026-07-28');
  assert.equal(initialized.result.serverInfo.version,'0.3.0');
  const listed=await rpc('tools/list');
  const tools=listed.result.tools;
  assert.deepEqual(tools.map(tool=>tool.name).sort(),[
    'ask_card','create_board','get_board','get_card_request','open_board','service_status','submit_card_answer'
  ].sort());
  assert.deepEqual(tools.find(tool=>tool.name==='ask_card')._meta.ui.visibility,['app']);
  for(const name of ['get_card_request','submit_card_answer','get_board']) {
    const tool=tools.find(tool=>tool.name===name);
    assert.ok(tool._meta.ui.visibility.includes('model'));
    assert.equal(tool._meta.ui.resourceUri,undefined);
    assert.equal(tool._meta['openai/outputTemplate'],undefined);
  }
  for(const name of ['create_board','open_board']) {
    assert.equal(tools.find(tool=>tool.name===name)._meta.ui.resourceUri,UI_URI);
  }
  const resources=await rpc('resources/list');
  assert.equal(resources.result.resources[0].uri,UI_URI);
  const resource=await rpc('resources/read',{uri:UI_URI});
  assert.equal(resource.result.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.equal(resource.result.contents[0].text,'<html>widget</html>');
  assert.deepEqual(resource.result.contents[0]._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
  assert.equal((await handler(request('tools/call',{name:'get_board',arguments:{boardId:'missing'}}),null)).status,401);
  const error=await rpc('tools/call',{name:'get_board',arguments:{boardId:'missing'}},'alice');
  assert.equal(error.result.isError,true);
  const status=await rpc('tools/call',{name:'service_status',arguments:{}},'alice');
  assert.equal(status.result.structuredContent.status.requiresApiKey,false);
  assert.equal(status.result.isError,undefined);
});


test('MCP tool failure preserves the request and returns a retryable tool error',async()=>{
  const {service}=setup();const b=await board(service);const args=ids(b);
  await queue(service,args,'我的问题');
  const handler=createMcpHandler(service,'<html/>');
  const request=new Request('http://localhost/mcp',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'submit_card_answer',arguments:{...args,answer:''}}})
  });
  const response=await (await handler(request,'alice')).json();
  assert.equal(response.result.isError,true);
  assert.match(response.result.content[0].text,/不符合要求/);
  assert.equal((await readRequest(service,args)).request.state,'queued');
});
