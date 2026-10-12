import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/store.mjs';
import {createService,createMcpHandler,tools,VERSION,UI_URI,LEGACY_UI_URI,UI_CHECK_URI,LEGACY_UI_CHECK_URI} from '../src/core.mjs';

const cacheableMethods=['server/discover','tools/list','prompts/list','resources/list','resources/templates/list','resources/read'];
function request(method,params={},mode='body-only',headerVersion='2026-07-28',bodyVersion='2026-07-28') {
  const headers={'Content-Type':'application/json'};
  if(mode==='both'||mode==='header-only')headers['MCP-Protocol-Version']=headerVersion;
  const enveloped=mode==='body-only'||mode==='both';
  return new Request('https://test.invalid/mcp',{
    method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,...(enveloped?{_meta:{
      'io.modelcontextprotocol/protocolVersion':bodyVersion,'io.modelcontextprotocol/clientCapabilities':{}
    }}:{})}})
  });
}
function setup(options={}) {
  const store=new MemoryStore();
  return {store,handler:createMcpHandler(createService(store),'<html>normal static</html>',{uiCheckHtml:'<html>check static</html>',...options})};
}
async function rpc(handler,method,params={},mode='body-only',header,body,owner='alice') {
  const response=await handler(request(method,params,mode,header,body),owner);
  return {status:response.status,envelope:await response.json()};
}
function modernResult(envelope) {
  assert.equal(envelope.jsonrpc,'2.0');assert.equal(envelope.id,1);assert.equal(envelope.error,undefined);
  assert.equal(envelope.result.resultType,'complete');
  assert.deepEqual(envelope.result._meta['io.modelcontextprotocol/serverInfo'],{name:'inline-qa',version:VERSION});
  return envelope.result;
}
function noCacheFields(result) {
  assert.equal(Object.hasOwn(result,'ttlMs'),false);assert.equal(Object.hasOwn(result,'cacheScope'),false);
}

test('six cacheable operations encode modern results with private zero-TTL hints across supported request forms',async()=>{
  const {handler}=setup();
  for(const mode of ['body-only','both','header-only']) {
    for(const method of cacheableMethods) {
      const {status,envelope}=await rpc(handler,method,method==='resources/read'?{uri:UI_URI}:{},mode);
      assert.equal(status,200);const result=modernResult(envelope);
      assert.equal(result.ttlMs,0,method+': ttlMs');assert.equal(result.cacheScope,'private',method+': cacheScope');
      if(method==='server/discover')assert.deepEqual(result.supportedVersions,['2026-07-28']);
      if(method==='tools/list')assert.ok(result.tools.some(tool=>tool.name==='create_board'));
      if(method==='prompts/list')assert.deepEqual(result.prompts,[]);
      if(method==='resources/list')assert.deepEqual(result.resources.map(item=>item.uri),[UI_URI,UI_CHECK_URI]);
      if(method==='resources/templates/list')assert.deepEqual(result.resourceTemplates,[]);
      if(method==='resources/read')assert.equal(result.contents[0].uri,UI_URI);
    }
  }
});

test('modern tool successes, tool failures and ping carry server identity without cache fields',async()=>{
  const {handler}=setup();
  for(const mode of ['body-only','both','header-only']) {
    for(const[method,params]of [
      ['tools/call',{name:'service_status',arguments:{}}],
      ['tools/call',{name:'get_board',arguments:{boardId:'missing'}}],['ping',{}]
    ]) {
      const {status,envelope}=await rpc(handler,method,params,mode);assert.equal(status,200);
      const result=modernResult(envelope);noCacheFields(result);
      if(method==='tools/call'&&params.name==='service_status')assert.equal(result.structuredContent.status.requiresApiKey,false);
      if(method==='tools/call'&&params.name==='get_board')assert.equal(result.isError,true);
    }
  }
});

test('current and legacy resource URIs return the requested URI, unchanged UI metadata and correct HTML',async()=>{
  const events=[];const {handler}=setup({onResourceRead:entry=>events.push(entry)});
  assert.equal(LEGACY_UI_CHECK_URI,'ui://inline-qa/ui-check-v0.3.4.html');
  for(const mode of ['body-only','both','header-only','legacy']) {
    for(const uri of [UI_URI,LEGACY_UI_URI,UI_CHECK_URI,LEGACY_UI_CHECK_URI]) {
      const {status,envelope}=await rpc(handler,'resources/read',{uri},mode);assert.equal(status,200);
      const result=mode==='legacy'?envelope.result:modernResult(envelope),content=result.contents[0];
      const diagnostic=[UI_CHECK_URI,LEGACY_UI_CHECK_URI].includes(uri);
      assert.equal(content.uri,uri);assert.equal(content.mimeType,'text/html;profile=mcp-app');
      assert.equal(content.text,diagnostic?'<html>check static</html>':'<html>normal static</html>');
      assert.deepEqual(content._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
      assert.deepEqual(content._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
      assert.equal(content._meta['io.modelcontextprotocol/serverInfo'],undefined,'identity belongs on the result envelope');
      assert.equal(events.at(-1).requestedUri,uri);assert.equal(events.at(-1).templateUri,diagnostic?UI_CHECK_URI:UI_URI);
    }
  }
  const {envelope}=await rpc(handler,'tools/list');
  const check=envelope.result.tools.find(tool=>tool.name==='check_ui');
  assert.equal(check._meta.ui.resourceUri,UI_CHECK_URI);assert.equal(check._meta['openai/outputTemplate'],UI_CHECK_URI);
});

test('conflicting protocol declarations are rejected before board writes or resource diagnostics',async()=>{
  const events=[];const {store,handler}=setup({onResourceRead:entry=>events.push(entry)});
  for(const[header,body]of [['2025-11-25','2026-07-28'],['2026-07-28','2025-11-25']]) {
    for(const[method,params]of [
      ['resources/read',{uri:UI_URI}],
      ['tools/call',{name:'create_board',arguments:{title:'must not save',cards:[{question:'private-question',answer:'private-answer'}]}}]
    ]) {
      const {status,envelope}=await rpc(handler,method,params,'both',header,body);
      assert.equal(status,400);assert.equal(envelope.jsonrpc,'2.0');assert.equal(envelope.id,1);
      assert.equal(envelope.error.code,-32020);assert.equal(envelope.result,undefined);
      assert.equal(JSON.stringify(envelope).includes('private-'),false);
    }
  }
  assert.equal(store.records.size,0);assert.deepEqual(events,[]);
});

test('valid legacy requests retain their original result shapes without modern metadata or cache hints',async()=>{
  const {handler}=setup();
  const expected={ping:{},'tools/list':{tools},'prompts/list':{prompts:[]},'resources/templates/list':{resourceTemplates:[]}};
  for(const mode of ['legacy','header-only','both']) {
    for(const[method,result]of Object.entries(expected)) {
      const {status,envelope}=await rpc(handler,method,{},mode,'2025-11-25','2025-11-25');
      assert.equal(status,200);assert.deepEqual(envelope,{jsonrpc:'2.0',id:1,result});
    }
    for(const method of ['resources/list','resources/read','tools/call']) {
      const params=method==='resources/read'?{uri:UI_URI}:method==='tools/call'?{name:'service_status',arguments:{}}:{};
      const {status,envelope}=await rpc(handler,method,params,mode,'2025-11-25','2025-11-25');assert.equal(status,200);
      assert.equal(envelope.result.resultType,undefined);assert.equal(envelope.result._meta,undefined);noCacheFields(envelope.result);
      if(method==='tools/call')assert.equal(envelope.result.structuredContent.status.version,VERSION);
    }
  }
  const {envelope}=await rpc(handler,'initialize',{protocolVersion:'2025-03-26'},'legacy');
  assert.equal(envelope.result.protocolVersion,'2025-03-26');assert.equal(envelope.result.serverInfo.version,VERSION);
  assert.equal(envelope.result.resultType,undefined);assert.equal(envelope.result._meta,undefined);noCacheFields(envelope.result);
});

test('body-only modern requests complete the card follow-up flow and keep board ownership isolated',async()=>{
  const {handler}=setup();
  const call=async(name,args,owner='alice')=>{
    const {status,envelope}=await rpc(handler,'tools/call',{name,arguments:args},'body-only',undefined,undefined,owner);
    assert.equal(status,200);const result=modernResult(envelope);noCacheFields(result);return result;
  };
  const created=await call('create_board',{title:'两题',cards:[{question:'第一题',answer:'初始答案一'},{question:'第二题',answer:'初始答案二'}]});
  const board=created.structuredContent.board,args={boardId:board.id,cardId:board.cards[1].id,requestId:'body-only-followup'};
  const queued=await call('ask_card',{...args,question:'请解释第二题'});assert.equal(queued.structuredContent.request.state,'queued');
  const denied=await call('get_card_request',args,'bob');assert.equal(denied.isError,true);assert.equal(denied.structuredContent,undefined);
  const context=await call('get_card_request',args);assert.equal(context.structuredContent.card.question,'第二题');
  const saved=await call('submit_card_answer',{...args,answer:'第二题的完整解释'});assert.equal(saved.structuredContent.followup.answer,'第二题的完整解释');
  const restored=(await call('get_board',{boardId:board.id})).structuredContent.board;
  assert.equal(restored.cards[0].followups.length,0);assert.deepEqual(restored.cards[1].followups,[saved.structuredContent.followup]);
});
