import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/store.mjs';
import {createService,createMcpHandler,UI_URI,LEGACY_UI_URI,UI_CHECK_URI,VERSION} from '../src/core.mjs';

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
  assert.equal(VERSION,'0.3.4');
  const unavailable=setup({status:()=>({storageReady:false})}).service;
  assert.equal((await unavailable.call('service_status',{},'alice')).status.storageReady,false);
});


test('MCP discovery supports 2026-07-28 and exposes host follow-up tools without another component',async()=>{
  const {service}=setup();const handler=createMcpHandler(service,'<html>widget</html>');
  const request=(method,params)=>new Request('http://localhost/mcp',{
    method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  });
  const rpc=async(method,params,owner=null)=>(await handler(request(method,params),owner)).json();
  const discovery=await rpc('server/discover');
  assert.deepEqual(discovery.result.supportedVersions,['2026-07-28']);
  assert.deepEqual(discovery.result.capabilities,{tools:{},resources:{}});
  assert.equal(discovery.result.resultType,'complete');
  const initialized=await rpc('initialize',{protocolVersion:'2026-07-28'});
  assert.equal(initialized.result.protocolVersion,'2026-07-28');
  assert.equal(initialized.result.serverInfo.version,'0.3.4');
  const listed=await rpc('tools/list');
  assert.equal(listed.result.resultType,'complete');
  const tools=listed.result.tools;
  assert.deepEqual(tools.map(tool=>tool.name).sort(),[
    'ask_card','check_ui','create_board','get_board','get_card_request','open_board','report_ui_stage','service_status','submit_card_answer'
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
  assert.equal(resources.result.resultType,'complete');
  assert.equal(resources.result.resources[0].uri,UI_URI);
  const resource=await rpc('resources/read',{uri:UI_URI});
  assert.equal(resource.result.resultType,'complete');
  assert.equal(resource.result.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.equal(resource.result.contents[0].text,'<html>widget</html>');
  assert.deepEqual(resource.result.contents[0]._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
  assert.deepEqual(resource.result.contents[0]._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
  assert.equal((await handler(request('tools/call',{name:'get_board',arguments:{boardId:'missing'}}),null)).status,401);
  const error=await rpc('tools/call',{name:'get_board',arguments:{boardId:'missing'}},'alice');
  assert.equal(error.result.resultType,'complete');
  assert.equal(error.result.isError,true);
  const status=await rpc('tools/call',{name:'service_status',arguments:{}},'alice');
  assert.equal(status.result.resultType,'complete');
  assert.equal(status.result.structuredContent.status.requiresApiKey,false);
  assert.equal(status.result.isError,undefined);
});


test('MCP tool failure preserves the request and returns a retryable tool error',async()=>{
  const {service}=setup();const b=await board(service);const args=ids(b);
  await queue(service,args,'我的问题');
  const handler=createMcpHandler(service,'<html/>');
  const request=new Request('http://localhost/mcp',{
    method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28'},
    body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'submit_card_answer',arguments:{...args,answer:''}}})
  });
  const response=await (await handler(request,'alice')).json();
  assert.equal(response.result.resultType,'complete');
  assert.equal(response.result.isError,true);
  assert.match(response.result.content[0].text,/不符合要求/);
  assert.equal((await readRequest(service,args)).request.state,'queued');
});


// Validate the JSON Schema keywords used by this dependency-free server.
// Fail on an unsupported keyword rather than silently ignoring a constraint.
function assertOutputSchema(schema,value,path='$') {
  assert.ok(schema&&typeof schema==='object',path+': schema is required');
  const allowed=new Set(['type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','enum','const','minimum','maximum','pattern','description','title','$schema']);
  for(const key of Object.keys(schema))assert.ok(allowed.has(key),path+': unsupported schema keyword '+key);
  if(schema.enum)assert.ok(schema.enum.some(item=>Object.is(item,value)),path+': enum');
  if('const' in schema)assert.deepEqual(value,schema.const,path+': const');
  if(schema.type==='object') {
    assert.ok(value&&typeof value==='object'&&!Array.isArray(value),path+': object');
    const properties=schema.properties??{};
    for(const key of schema.required??[])assert.ok(Object.hasOwn(value,key),path+'.'+key+': required');
    for(const[key,item]of Object.entries(value)) {
      if(properties[key])assertOutputSchema(properties[key],item,path+'.'+key);
      else if(schema.additionalProperties===false)assert.fail(path+'.'+key+': unexpected property');
      else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')assertOutputSchema(schema.additionalProperties,item,path+'.'+key);
    }
  }else if(schema.type==='array') {
    assert.ok(Array.isArray(value),path+': array');
    if(schema.minItems!==undefined)assert.ok(value.length>=schema.minItems,path+': minItems');
    if(schema.maxItems!==undefined)assert.ok(value.length<=schema.maxItems,path+': maxItems');
    if(schema.items)value.forEach((item,index)=>assertOutputSchema(schema.items,item,path+'['+index+']'));
  }else if(schema.type==='integer') {
    assert.ok(Number.isInteger(value),path+': integer');
  }else if(schema.type==='number') {
    assert.equal(typeof value,'number',path+': number');assert.ok(Number.isFinite(value),path+': finite number');
  }else if(schema.type==='string'||schema.type==='boolean') {
    assert.equal(typeof value,schema.type,path+': '+schema.type);
  }else if(schema.type==='null') {
    assert.equal(value,null,path+': null');
  }else {
    assert.fail(path+': missing or unsupported schema type '+schema.type);
  }
  if(typeof value==='string') {
    const length=Array.from(value).length;
    if(schema.minLength!==undefined)assert.ok(length>=schema.minLength,path+': minLength');
    if(schema.maxLength!==undefined)assert.ok(length<=schema.maxLength,path+': maxLength');
    if(schema.pattern!==undefined)assert.match(value,new RegExp(schema.pattern),path+': pattern');
  }
  if(typeof value==='number') {
    if(schema.minimum!==undefined)assert.ok(value>=schema.minimum,path+': minimum');
    if(schema.maximum!==undefined)assert.ok(value<=schema.maximum,path+': maximum');
  }
}


test('all nine tools return complete results conforming to their declared output schemas and JSON fallback',async()=>{
  const {service}=setup();const handler=createMcpHandler(service,'<html>widget</html>');
  let rpcId=0;
  const rpc=async(method,params)=>{
    const response=await handler(new Request('http://localhost/mcp',{
      method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28'},
      body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})
    }),'alice');
    assert.equal(response.status,200);
    const envelope=await response.json();
    assert.equal(envelope.error,undefined);
    assert.equal(envelope.result.resultType,'complete',method+': complete result');
    return envelope.result;
  };
  const listed=await rpc('tools/list');
  const definitions=new Map(listed.tools.map(tool=>[tool.name,tool]));
  const required={
    check_ui:['uiCheck'],report_ui_stage:['recorded'],service_status:['status'],create_board:['board'],open_board:['board'],get_board:['board'],
    ask_card:['boardId','cardId','request'],get_card_request:['boardId','cardId','request','card'],
    submit_card_answer:['boardId','cardId','followup']
  };
  for(const[name,keys]of Object.entries(required)) {
    const schema=definitions.get(name)?.outputSchema;
    assert.equal(schema?.type,'object',name+': outputSchema object');
    for(const key of keys)assert.ok(schema.required?.includes(key),name+': outputSchema requires '+key);
  }
  const called=new Set();
  const call=async(name,args)=>{
    const result=await rpc('tools/call',{name,arguments:args});
    assert.equal(result.isError,undefined,name+': successful result');
    if(['create_board','open_board'].includes(name)){
      assert.match(result.content[0].text,/工具成功不代表客户端显示成功/);
      assert.match(definitions.get(name).description,/Do not claim it is visible without UI evidence/);
    }
    assertOutputSchema(definitions.get(name).outputSchema,result.structuredContent,name);
    const serialized=result.content.find(item=>item.type==='text'&&item.annotations?.audience?.includes('assistant')&&item.text.trim().startsWith('{'));
    assert.ok(serialized,name+': assistant-visible JSON fallback');
    assert.deepEqual(JSON.parse(serialized.text),result.structuredContent,name+': fallback matches structuredContent');
    called.add(name);
    return result.structuredContent;
  };
  assert.deepEqual(await call('check_ui',{}),{uiCheck:{version:VERSION}});
  assert.deepEqual(await call('report_ui_stage',{phase:'bridge_initialized'}),{recorded:true});
  const status=await call('service_status',{});
  assert.equal(status.status.version,'0.3.4');
  const created=await call('create_board',{title:'真实返回结构',cards});
  const b=created.board,args=ids(b,1,'schema-followup');
  assert.equal(b.cards.length,2);
  assert.ok(b.cards.every(card=>!('pending' in card)));
  await call('open_board',{boardId:b.id});
  await call('get_board',{boardId:b.id});
  assert.equal((await call('ask_card',{...args,question:'请解释这一步'})).request.state,'queued');
  assert.equal((await call('get_card_request',args)).request.state,'queued');
  const answer=await call('submit_card_answer',{...args,answer:'完整解答写回第二题。'});
  assert.equal(answer.followup.answer,'完整解答写回第二题。');
  const completed=await call('get_card_request',args);
  assert.equal(completed.request.state,'completed');
  assert.deepEqual(completed.followup,answer.followup);
  const cached=await call('ask_card',{...args,question:'请解释这一步'});
  assert.equal(cached.request.state,'completed');
  assert.deepEqual(cached.followup,answer.followup);
  const restored=await call('open_board',{boardId:b.id});
  assert.deepEqual(restored.board.cards[1].followups,[answer.followup]);
  assert.deepEqual([...called].sort(),Object.keys(required).sort());
  await rpc('resources/read',{uri:UI_URI});
  await rpc('resources/list');
  await rpc('resources/templates/list');
  await rpc('prompts/list');
  await rpc('ping');
});



test('legacy MCP initialize and resource access stay compatible without a modern result discriminator',async()=>{
  const {service}=setup();const handler=createMcpHandler(service,'<html>legacy widget</html>');
  const rpc=async(method,params)=>{
    const response=await handler(new Request('http://localhost/mcp',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
    }),'alice');
    assert.equal(response.status,200);
    const result=(await response.json()).result;
    assert.equal(result.resultType,undefined,method+': legacy response');
    return result;
  };
  const initialized=await rpc('initialize',{protocolVersion:'2025-03-26'});
  assert.equal(initialized.protocolVersion,'2025-03-26');
  assert.equal(initialized.serverInfo.version,'0.3.4');
  const resource=await rpc('resources/read',{uri:UI_URI});
  assert.equal(resource.contents[0].text,'<html>legacy widget</html>');
  const status=await rpc('tools/call',{name:'service_status',arguments:{}});
  assert.equal(status.structuredContent.status.version,'0.3.4');
  assert.equal(status.isError,undefined);
});

function resourceTestRequest(method,params={},headerVersion='2026-07-28',extraHeaders={}) {
  const headers={'Content-Type':'application/json',...extraHeaders};
  if(headerVersion!==null)headers['MCP-Protocol-Version']=headerVersion;
  return new Request('https://test.invalid/mcp',{
    method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:77,method,params})
  });
}


test('versioned renderer pointers and old-resource alias keep existing boards unchanged',async()=>{
  assert.equal(UI_URI,'ui://inline-qa/widget-v0.3.3.html');
  assert.equal(LEGACY_UI_URI,'ui://inline-qa/widget.html');
  const {store,service}=setup();const b=await board(service);
  const before=await store.read('alice',b.id);
  const html='<!doctype html><html><body>共享静态题卡</body></html>';
  const handler=createMcpHandler(service,html);
  const rpc=async(method,params,version)=>(await handler(resourceTestRequest(method,params,version),'alice')).json();
  const listed=await rpc('tools/list',{});
  for(const name of ['create_board','open_board']) {
    const descriptor=listed.result.tools.find(tool=>tool.name===name);
    assert.equal(descriptor._meta.ui.resourceUri,UI_URI);
    assert.equal(descriptor._meta['openai/outputTemplate'],UI_URI);
  }
  const resources=await rpc('resources/list',{});
  assert.deepEqual(resources.result.resources.map(resource=>resource.uri),[UI_URI,UI_CHECK_URI]);
  for(const version of ['2026-07-28','2025-11-25']) {
    for(const uri of [UI_URI,LEGACY_UI_URI]) {
      const response=await rpc('resources/read',{uri},version);
      assert.equal(response.error,undefined);
      assert.equal(response.result.resultType,version==='2026-07-28'?'complete':undefined);
      assert.equal(response.result.contents[0].uri,uri);
      assert.equal(response.result.contents[0].mimeType,'text/html;profile=mcp-app');
      assert.equal(response.result.contents[0].text,html);
    }
  }
  assert.deepEqual((await service.call('get_board',{boardId:b.id},'alice')).board,b);
  assert.deepEqual(await store.read('alice',b.id),before);
});


test('resource diagnostics whitelist fixed fields and sanitize protocol metadata',async()=>{
  const {service}=setup();const events=[];
  const html='<!doctype html><html><body>静态题卡 🧩</body></html>';
  const handler=createMcpHandler(service,html,{onResourceRead:diagnostic=>events.push(diagnostic)});
  const request=resourceTestRequest('resources/read',{
    uri:UI_URI,question:'private-question-marker',answer:'private-answer-marker',
    _meta:{
      'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      privateOwner:'private-owner-marker',privatePayload:'private-payload-marker'
    }
  },'2026-07-28',{'Authorization':'Bearer private-auth-marker'});
  const response=await (await handler(request,'private-owner-marker')).json();
  assert.equal(response.result.contents[0].uri,UI_URI);
  assert.deepEqual(events[0],{
    event:'inline-qa.resource-read',templateUri:UI_URI,requestedUri:UI_URI,version:'0.3.4',
    mimeType:'text/html;profile=mcp-app',htmlBytes:new TextEncoder().encode(html).length,
    headerProtocolVersion:'2026-07-28',bodyProtocolVersion:'2026-07-28'
  });
  await handler(resourceTestRequest('resources/read',{
    uri:LEGACY_UI_URI,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-02-30'}
  },'private-header-marker'),'private-owner-marker');
  assert.equal(events[1].requestedUri,LEGACY_UI_URI);
  assert.equal(events[1].templateUri,UI_URI);
  assert.equal(events[1].headerProtocolVersion,null);
  assert.equal(events[1].bodyProtocolVersion,null);
  await handler(resourceTestRequest('resources/read',{
    uri:LEGACY_UI_URI,_meta:{'io.modelcontextprotocol/protocolVersion':'private-body-marker'}
  },'2025-11-25'),'private-owner-marker');
  assert.equal(events[2].headerProtocolVersion,'2025-11-25');
  assert.equal(events[2].bodyProtocolVersion,null);
  await handler(resourceTestRequest('resources/read',{
    uri:UI_URI,_meta:{'io.modelcontextprotocol/protocolVersion':{secret:'private-object-marker'}}
  },null),'private-owner-marker');
  assert.equal(events[3].headerProtocolVersion,null);
  assert.equal(events[3].bodyProtocolVersion,null);
  const keys=['event','templateUri','requestedUri','version','mimeType','htmlBytes','headerProtocolVersion','bodyProtocolVersion'].sort();
  for(const event of events)assert.deepEqual(Object.keys(event).sort(),keys);
  const serialized=JSON.stringify(events);
  for(const privateValue of ['private-question-marker','private-answer-marker','private-owner-marker','private-payload-marker','private-auth-marker','private-header-marker','private-body-marker','private-object-marker',html]) {
    assert.equal(serialized.includes(privateValue),false);
  }
  await handler(resourceTestRequest('tools/list',{}),'alice');
  await handler(resourceTestRequest('tools/call',{name:'service_status',arguments:{}}),'alice');
  await handler(resourceTestRequest('resources/read',{uri:'ui://unrecognized/private-resource-marker'}),'alice');
  assert.equal(events.length,4,'only recognized resource reads produce diagnostics');
});


test('throwing, rejecting or pending resource diagnostic callbacks cannot break resource delivery',async()=>{
  const {service}=setup();const html='<html>still available</html>';
  const callbacks=[
    ()=>{throw Error('private-logger-error')},
    async()=>{throw Error('private-async-logger-error')},
    ()=>new Promise(()=>{})
  ];
  for(const onResourceRead of callbacks) {
    const handler=createMcpHandler(service,html,{onResourceRead});
    const response=await handler(resourceTestRequest('resources/read',{uri:UI_URI}),'alice');
    assert.equal(response.status,200);
    const envelope=await response.json();
    assert.equal(envelope.error,undefined);
    assert.equal(envelope.result.resultType,'complete');
    assert.equal(envelope.result.contents[0].text,html);
    assert.equal(JSON.stringify(envelope).includes('private-'),false);
  }
  await Promise.resolve();
});



test('independent UI check uses its own resource and leaves a saved 29-card board unchanged',async()=>{
  assert.equal(UI_CHECK_URI,'ui://inline-qa/ui-check-v0.3.4.html');
  assert.equal(UI_URI,'ui://inline-qa/widget-v0.3.3.html');
  assert.equal(LEGACY_UI_URI,'ui://inline-qa/widget.html');
  const {service,store}=setup();
  const saved=(await service.call('create_board',{
    title:'已保存的 29 道概率题',
    cards:Array.from({length:29},(_,index)=>({question:'概率题 '+(index+1),answer:'原答案 '+(index+1)}))
  },'alice')).board;
  await queue(service,ids(saved,4,'keep-pending'),'保留已有的待回答问题');
  const before=await store.read('alice',saved.id);
  const normalHtml='<html>normal board</html>',checkHtml='<html>独立检测 🧩</html>',resources=[];
  const handler=createMcpHandler(service,normalHtml,{uiCheckHtml:checkHtml,onResourceRead:entry=>resources.push(entry)});
  const rpc=async(method,params,version='2026-07-28')=>(await handler(resourceTestRequest(method,params,version),'alice')).json();
  const listed=(await rpc('tools/list',{})).result.tools;
  const check=listed.find(tool=>tool.name==='check_ui'),stage=listed.find(tool=>tool.name==='report_ui_stage');
  assert.equal(check._meta.ui.resourceUri,UI_CHECK_URI);
  assert.equal(check._meta['openai/outputTemplate'],UI_CHECK_URI);
  assert.deepEqual(check._meta.ui.visibility,['model','app']);
  assert.deepEqual(check.inputSchema,{type:'object',properties:{},required:[],additionalProperties:false});
  assert.deepEqual(stage._meta.ui.visibility,['app']);
  assert.equal(stage._meta.ui.resourceUri,undefined);
  assert.equal(stage._meta['openai/outputTemplate'],undefined);
  assert.equal(stage.inputSchema.additionalProperties,false);
  assert.deepEqual(stage.inputSchema.properties.phase.enum,['script_started','bridge_initialized','tool_result_received','view_ready']);
  for(const name of ['create_board','open_board']){
    const tool=listed.find(item=>item.name===name);
    assert.equal(tool._meta.ui.resourceUri,UI_URI);
    assert.equal(tool._meta['openai/outputTemplate'],UI_URI);
  }
  assert.deepEqual((await rpc('tools/call',{name:'check_ui',arguments:{}})).result.structuredContent,{uiCheck:{version:VERSION}});
  for(const phase of stage.inputSchema.properties.phase.enum){
    assert.deepEqual((await rpc('tools/call',{name:'report_ui_stage',arguments:{phase}})).result.structuredContent,{recorded:true});
  }
  for(const version of ['2026-07-28','2025-11-25']){
    const result=(await rpc('resources/read',{uri:UI_CHECK_URI},version)).result;
    assert.equal(result.resultType,version==='2026-07-28'?'complete':undefined);
    assert.equal(result.contents[0].uri,UI_CHECK_URI);
    assert.equal(result.contents[0].text,checkHtml);
    assert.equal(result.contents[0].mimeType,'text/html;profile=mcp-app');
    assert.deepEqual(result.contents[0]._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
    assert.deepEqual(result.contents[0]._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
  }
  for(const uri of [UI_URI,LEGACY_UI_URI]){
    assert.equal((await rpc('resources/read',{uri})).result.contents[0].text,normalHtml);
  }
  assert.equal(resources[0].templateUri,UI_CHECK_URI);
  assert.equal(resources[0].requestedUri,UI_CHECK_URI);
  assert.equal(resources[0].htmlBytes,new TextEncoder().encode(checkHtml).length);
  assert.equal(resources[2].templateUri,UI_URI);
  assert.deepEqual(await store.read('alice',saved.id),before);
  const refreshed=(await service.call('open_board',{boardId:saved.id},'alice')).board;
  assert.equal(refreshed.cards.length,29);
  assert.equal(refreshed.id,saved.id);
  assert.equal(refreshed.cards[4].question,saved.cards[4].question);
});


test('UI diagnostics require an owner, strictly validate arguments and never access board storage',async()=>{
  let dbCalls=0;const bomb=()=>{dbCalls++;throw new Error('diagnostics must not access storage')};
  const service=createService({read:bomb,create:bomb,compareAndSwap:bomb});
  const stages=[];const handler=createMcpHandler(service,'<html>board</html>',{
    uiCheckHtml:'<html>check</html>',onUiStage:entry=>stages.push(entry)
  });
  const invoke=async(name,args,owner='alice')=>handler(resourceTestRequest('tools/call',{name,arguments:args}),owner);
  assert.deepEqual(await service.call('check_ui',{},'alice'),{uiCheck:{version:VERSION}});
  assert.deepEqual(await service.call('report_ui_stage',{phase:'script_started'},'alice'),{recorded:true});
  for(const [name,args]of [['check_ui',{}],['report_ui_stage',{phase:'view_ready'}]]){
    await assert.rejects(service.call(name,args,''),/登录/);
    assert.equal((await invoke(name,args,null)).status,401);
  }
  const invalid=[
    ['check_ui',{question:'private-question-marker'}],['check_ui',null],['check_ui',[]],['check_ui','value'],
    ['report_ui_stage',{}],['report_ui_stage',{phase:'not-a-stage'}],['report_ui_stage',{phase:7}],
    ['report_ui_stage',{phase:['view_ready']}],['report_ui_stage',{phase:'view_ready',answer:'private-answer-marker'}],
    ['report_ui_stage',null],['report_ui_stage',[]]
  ];
  for(const[name,args]of invalid){
    await assert.rejects(service.call(name,args,'alice'),/参数无效|阶段无效/);
    const result=await (await invoke(name,args)).json();
    assert.equal(result.result.isError,true);
    assert.equal(result.result.structuredContent,undefined);
  }
  await assert.rejects(service.call('report_ui_stage',Object.create({phase:'view_ready'}),'alice'),/阶段无效/);
  assert.equal(dbCalls,0);
  assert.deepEqual(stages,[]);
  const unconfigured=createMcpHandler(service,'<html>board</html>');
  const missing=await (await unconfigured(resourceTestRequest('resources/read',{uri:UI_CHECK_URI}),'alice')).json();
  assert.equal(missing.error.code,-32601,'an absent diagnostic asset must not become an empty or undefined HTML resource');
});


test('UI stage callbacks expose only a validated fixed phase and never request or identity data',async()=>{
  const {service}=setup();const events=[];
  const handler=createMcpHandler(service,'<html>board</html>',{uiCheckHtml:'<html>check</html>',onUiStage:event=>events.push(event)});
  const phases=['script_started','bridge_initialized','tool_result_received','view_ready'];
  for(const phase of phases){
    const request=resourceTestRequest('tools/call',{
      name:'report_ui_stage',arguments:{phase},
      _meta:{privateQuestion:'private-question-marker',privatePayload:'private-payload-marker'}
    },'2026-07-28',{'Authorization':'Bearer private-auth-marker'});
    const result=await (await handler(request,'private-owner-marker')).json();
    assert.deepEqual(result.result.structuredContent,{recorded:true});
  }
  assert.deepEqual(events,phases.map(phase=>({event:'inline-qa.ui-stage',version:VERSION,templateUri:UI_CHECK_URI,phase})));
  for(const event of events){assert.deepEqual(Object.keys(event).sort(),['event','phase','templateUri','version']);assert.ok(Object.isFrozen(event));}
  const serialized=JSON.stringify(events);
  for(const marker of ['private-question-marker','private-payload-marker','private-auth-marker','private-owner-marker','boardId','requestId','id']){
    assert.equal(serialized.includes('"'+marker+'"'),false);
  }
  assert.equal(serialized.includes('private-'),false);
  await handler(resourceTestRequest('tools/call',{name:'check_ui',arguments:{}}),'alice');
  await handler(resourceTestRequest('resources/read',{uri:UI_CHECK_URI}),'alice');
  await handler(resourceTestRequest('tools/call',{name:'service_status',arguments:{}}),'alice');
  assert.equal(events.length,4,'other calls and reads do not report a stage');
});


test('UI stage callback failures and pending callbacks do not prevent a successful diagnostic reply',async()=>{
  const {service}=setup();
  const callbacks=[()=>{throw Error('private-stage-error')},async()=>{throw Error('private-async-stage-error')},()=>new Promise(()=>{})];
  for(const onUiStage of callbacks){
    const handler=createMcpHandler(service,'<html>board</html>',{uiCheckHtml:'<html>check</html>',onUiStage});
    const response=await handler(resourceTestRequest('tools/call',{name:'report_ui_stage',arguments:{phase:'bridge_initialized'}}),'alice');
    assert.equal(response.status,200);
    const envelope=await response.json();
    assert.equal(envelope.result.isError,undefined);
    assert.equal(envelope.result.resultType,'complete');
    assert.deepEqual(envelope.result.structuredContent,{recorded:true});
    assert.equal(JSON.stringify(envelope).includes('private-'),false);
  }
  await Promise.resolve();
});
