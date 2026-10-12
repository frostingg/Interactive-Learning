import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import katex from 'katex';
import {loadUiHtml} from '../scripts/ui-assets.mjs';
import {MemoryStore} from '../src/store.mjs';
import {createService,createMcpHandler,tools,UI_URI,PREVIOUS_UI_URI,UI_CHECK_URI,PREVIOUS_UI_CHECK_URI} from '../src/core.mjs';

const rendererSource=await readFile(new URL('../public/math-renderer.js',import.meta.url),'utf8');
// Text-only DOM seam; actual KaTeX output is checked separately.
function dom() {
  const document={};
  class Node {
    constructor(type,text='',tag='') {this.nodeType=type;this.value=text;this.tagName=tag.toUpperCase();this.ownerDocument=document;this.childNodes=[];this.attributes={};this.replacements=0;}
    get textContent(){return this.nodeType===3?this.value:this.childNodes.map(node=>node.textContent).join('');}
    set textContent(value){if(this.nodeType===3)this.value=String(value);else this.replaceChildren(document.createTextNode(String(value)));}
    get children(){return this.childNodes.filter(node=>node.nodeType===1);}
    appendChild(node){if(node.nodeType===11){for(const child of [...node.childNodes])this.appendChild(child);node.childNodes=[];}else{node.parentElement=this.nodeType===1?this:null;this.childNodes.push(node);}return node;}
    replaceChildren(...nodes){this.replacements++;this.childNodes=[];for(const node of nodes)this.appendChild(node);}
    setAttribute(name,value){this.attributes[name]=String(value);}
    getAttribute(name){return this.attributes[name]??null;}
    set innerHTML(_){throw Error('User text must not be parsed as HTML');}
  }
  document.createTextNode=text=>new Node(3,String(text));
  document.createElement=tag=>new Node(1,'',tag);
  document.createDocumentFragment=()=>new Node(11);
  return document;
}
function renderer(stub) {
  const document=dom(),context=createContext({document,katex:stub,console});
  runInContext(rendererSource,context,{filename:'math-renderer.js'});
  return {math:context.InlineQAMath,document,node:document.createElement('p')};
}
const copy=value=>JSON.parse(JSON.stringify(value));
const maths=(math,source)=>copy(math.splitMathText(source)).filter(token=>token.type==='math');
const sourceOf=tokens=>tokens.map(token=>token.type==='math'?token.raw:token.text).join('');


test('math scanner preserves prose and recognizes four standard delimiters in the correct order',()=>{
  const {math}=renderer();
  const source=String.raw`前文 \(\frac{1}{2}\)；$x^2$；\[\int_0^1 x^2\,dx\]；$$a+b$$ 后文`;
  const tokens=copy(math.splitMathText(source)),expressions=tokens.filter(token=>token.type==='math');
  assert.deepEqual(expressions.map(token=>({text:token.text,display:token.display})),[
    {text:String.raw`\frac{1}{2}`,display:false},{text:'x^2',display:false},
    {text:String.raw`\int_0^1 x^2\,dx`,display:true},{text:'a+b',display:true}
  ]);
  assert.equal(sourceOf(tokens),source);
  assert.ok(tokens.some(token=>token.type==='text'&&token.text.includes('前文')));
});


test('escaped dollars, currency, code and unmatched delimiters remain literal text',()=>{
  const {math}=renderer(),tick=String.fromCharCode(96);
  const samples=[
    String.raw`金额 \$5，价格 $5 和 $10；孤立美元 $；未闭合 \(x`,
    tick+'$x^2$'+tick,
    tick.repeat(3)+'tex\n$$\\frac{1}{2}$$\n'+tick.repeat(3),
    '~~~tex\n\\(x^2\\)\n~~~',
    '<img src=x onerror="globalThis.attack=1"><script>attack()</script>'
  ];
  for(const source of samples){const tokens=copy(math.splitMathText(source));assert.equal(maths(math,source).length,0,source);assert.equal(sourceOf(tokens),source);}
  const mixed=tick+'$literal$'+tick+' and $x$';
  assert.equal(maths(math,mixed).length,1);assert.equal(maths(math,mixed)[0].text,'x');
  assert.ok(copy(math.splitMathText(mixed)).some(token=>token.type==='code'));
});


test('rendering keeps HTML inert and malformed or unavailable math readable without aborting the text',()=>{
  const plain='<img src=x onerror="attack()"><script>attack()</script>',{math,node}=renderer();
  math.renderText(node,plain);assert.equal(node.textContent,plain);assert.equal(node.children.length,0);
  const source=String.raw`前 \(\frac{1}\) 后 \(x\)`;
  math.renderText(node,source);assert.equal(node.textContent,source,'missing library keeps all original content');
  const calls=[];
  math.renderText(node,source,{katex:{render(tex,target,options){calls.push(tex);const output=katex.renderToString(tex,options);target.appendChild(target.ownerDocument.createTextNode(output));}}});
  assert.deepEqual(calls,[String.raw`\frac{1}`,'x']);
  assert.ok(node.textContent.includes(String.raw`\(\frac{1}\)`),'invalid formula remains the original text');
  assert.ok(node.textContent.includes('前 '));assert.ok(node.textContent.includes(' 后 '));
  assert.equal(node.children.length,1,'one invalid expression must not hide the next valid expression');
});


test('actual KaTeX renders fractions, integrals, matrices and cases with accessible MathML',()=>{
  for(const[source,pattern]of [
    [String.raw`\frac{1}{2}`,/<mfrac>/],
    [String.raw`\int_0^1 x^2\,dx`,/<msubsup>/],
    [String.raw`\begin{bmatrix}1&2\\3&4\end{bmatrix}`,/<mtable[\s>]/],
    [String.raw`\begin{cases}x&x>0\\0&x\le 0\end{cases}`,/<mtable[\s>]/]
  ]) {
    const html=katex.renderToString(source,{displayMode:true,output:'htmlAndMathml',trust:false,throwOnError:true,maxExpand:1000,maxSize:20,macros:{}});
    assert.match(html,pattern);assert.match(html,/class="katex-html"/);assert.match(html,/class="katex-mathml"/);assert.doesNotMatch(html,/katex-error/);
  }
});


test('untrusted commands cannot create active elements and macro expansion and visual sizes stay bounded',()=>{
  const calls=[],{math,node}=renderer();
  const stub={render(tex,target,options){calls.push({tex,options});const html=katex.renderToString(tex,options);target.appendChild(target.ownerDocument.createTextNode(html));}};
  for(const tex of [
    String.raw`\href{javascript:alert(1)}{x}`,String.raw`\includegraphics{https://example.invalid/probe.png}`,
    String.raw`\htmlStyle{position:fixed;inset:0}{x}`,String.raw`\text{<img src=x onerror=attack()>}`
  ]) {
    math.renderText(node,'\\('+tex+'\\)',{katex:stub});
    assert.doesNotMatch(node.textContent,/<(?:a|img|script)\b/i);
  }
  const loop=String.raw`\(\def\loop{\loop}\loop\)`;
  math.renderText(node,loop,{katex:stub});assert.equal(node.textContent,loop,'expansion limit returns readable original text');
  math.renderText(node,String.raw`\(\rule{99999em}{99999em}\)`,{katex:stub});
  assert.match(node.textContent,/width:20em/);assert.doesNotMatch(node.textContent,/(?:width|height):99999em/);
  for(const{options}of calls){assert.equal(options.trust,false);assert.equal(options.maxExpand,1000);assert.equal(options.maxSize,20);}
});


test('each expression has fresh macros and unchanged source avoids redraw while new follow-ups render',()=>{
  const calls=[],stub={render(tex,target,options){calls.push({tex,options});target.appendChild(target.ownerDocument.createTextNode(katex.renderToString(tex,options)));}};
  const {math,node}=renderer(stub),source=String.raw`\(\gdef\poison{7}\) then \(\poison\)`;
  assert.equal(math.putMath(node,source),true);assert.equal(calls.length,2);
  assert.notEqual(calls[0].options.macros,calls[1].options.macros);
  assert.ok(Object.hasOwn(calls[0].options.macros,String.raw`\poison`));assert.equal(Object.hasOwn(calls[1].options.macros,String.raw`\poison`),false);
  assert.ok(node.textContent.includes(String.raw`\(\poison\)`));
  const first=node.childNodes[0],replacements=node.replacements;
  assert.equal(math.putMath(node,source),false);assert.equal(calls.length,2);assert.equal(node.childNodes[0],first);assert.equal(node.replacements,replacements);
  const updated=String.raw`追问解答：\(\frac{3}{4}\)`;
  assert.equal(math.putMath(node,updated),true);assert.equal(calls.length,3);assert.equal(math.getSource(node),updated);assert.match(node.textContent,/<mfrac>/);
});


test('widget and demo bundles embed executable KaTeX and valid WOFF2 fonts without remote asset URLs',async()=>{
  for(const filename of ['widget.html','demo.html']) {
    const html=await loadUiHtml(filename);assert.match(html,/<!doctype html>/i);assert.doesNotMatch(html,/INLINE_QA_MATH_(?:STYLE|SCRIPT)/);
    const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.some(match=>match[2].includes('InlineQAMath')));assert.ok(scripts.some(match=>match[2].includes('renderToString')));
    for(const match of scripts){assert.doesNotMatch(match[1],/\bsrc\s*=/i);new Function(match[2]);}
    assert.doesNotMatch(html,/<link\b[^>]*\bhref\s*=/i);
    const css=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>match[1]).join('\n');
    const urls=[...css.matchAll(/url\(([^)]+)\)/gi)].map(match=>match[1].trim().replace(/^["']|["']$/g,''));
    assert.ok(urls.length>0);assert.ok(urls.every(url=>url.startsWith('data:')));
    const fonts=urls.filter(url=>url.startsWith('data:font/woff2;base64,'));assert.ok(fonts.length>0);
    for(const url of fonts){const bytes=Buffer.from(url.slice(url.indexOf(',')+1),'base64');assert.equal(bytes.subarray(0,4).toString('ascii'),'wOF2');}
  }
});


test('previous widget and diagnostic URIs remain readable and generated-answer prompts use standard LaTeX delimiters',async()=>{
  const widgetHtml=await loadUiHtml('widget.html'),checkHtml=await loadUiHtml('ui-check.html');
  const service=createService(new MemoryStore()),handler=createMcpHandler(service,widgetHtml,{uiCheckHtml:checkHtml});
  for(const[uri,expected]of [[UI_URI,widgetHtml],[PREVIOUS_UI_URI,widgetHtml],[UI_CHECK_URI,checkHtml],[PREVIOUS_UI_CHECK_URI,checkHtml]]) {
    const response=await handler(new Request('https://test.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri}})}),'alice');
    assert.equal(response.status,200);const {result}=await response.json();assert.equal(result.contents[0].uri,uri);assert.equal(result.contents[0].text,expected);
  }
  const {board}=await service.call('create_board',{title:'公式提示检查',cards:[{question:'分式',answer:String.raw`\(\frac{1}{2}\)`}]},'alice');
  const {request}=await service.call('ask_card',{boardId:board.id,cardId:board.cards[0].id,requestId:'math-followup',question:'解释这个公式'},'alice');
  for(const name of ['create_board','get_card_request','submit_card_answer']) {
    const description=tools.find(tool=>tool.name===name).description;assert.match(description,/LaTeX/);assert.ok(description.includes(String.raw`\(`));assert.equal(description.includes(String.raw`\\(`),false);
  }
  assert.match(request.prompt,/LaTeX/);assert.ok(request.prompt.includes(String.raw`\(`));assert.ok(request.prompt.includes(String.raw`\[`));assert.equal(request.prompt.includes(String.raw`\\(`),false);
});