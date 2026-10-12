(function (global) {
'use strict';
const rawSources = new WeakMap();
const tick = String.fromCharCode(96);
const delimiters = [
  {left:'$$',right:'$$',display:true},
  {left:'\\[',right:'\\]',display:true},
  {left:'\\(',right:'\\)',display:false},
  {left:'$',right:'$',display:false}
];
function escaped(text,index) {
  let count=0;
  for(let i=index-1;i>=0&&text[i]==='\\';i--)count++;
  return count%2===1;
}
function add(tokens,type,text,extra) {
  if(!text)return;
  const last=tokens[tokens.length-1];
  if(type==='text'&&last?.type==='text')last.text+=text;
  else tokens.push({type,text,...extra});
}
function splitCode(text) {
  const tokens=[];
  let index=0,start=0;
  while(index<text.length) {
    const lineStart=index===0||text[index-1]==='\n';
    if(lineStart) {
      const lineEnd=text.indexOf('\n',index);
      const first=text.slice(index,lineEnd<0?text.length:lineEnd);
      const match=/^ {0,3}([\x60~])\1{2,}/.exec(first);
      if(match&&!escaped(text,index+first.indexOf(match[1]))) {
        const marker=match[1],length=match[0].trimStart().length;
        const info=first.slice(match[0].length);
        if(marker!==tick||!info.includes(tick)) {
          let next=lineEnd<0?text.length:lineEnd+1,end=text.length;
          while(next<text.length) {
            const newline=text.indexOf('\n',next);
            const line=text.slice(next,newline<0?text.length:newline);
            const close=/^ {0,3}([\x60~]+)[ \t\r]*$/.exec(line);
            if(close&&close[1][0]===marker&&close[1].length>=length&&
              [...close[1]].every(c=>c===marker)) {
              end=newline<0?text.length:newline+1;break;
            }
            next=newline<0?text.length:newline+1;
          }
          add(tokens,'text',text.slice(start,index));
          add(tokens,'code',text.slice(index,end));
          index=end;start=end;continue;
        }
      }
    }
    if(text[index]===tick&&!escaped(text,index)) {
      let runEnd=index+1;
      while(text[runEnd]===tick)runEnd++;
      const length=runEnd-index;
      let next=runEnd,end=-1;
      while(next<text.length) {
        const candidate=text.indexOf(tick,next);
        if(candidate<0)break;
        let candidateEnd=candidate+1;
        while(text[candidateEnd]===tick)candidateEnd++;
        if(candidateEnd-candidate===length){end=candidateEnd;break;}
        next=candidateEnd;
      }
      if(end>=0) {
        add(tokens,'text',text.slice(start,index));
        add(tokens,'code',text.slice(index,end));
        index=end;start=end;continue;
      }
      index=runEnd;continue;
    }
    index++;
  }
  add(tokens,'text',text.slice(start));
  return tokens;
}
function mathEnd(text,start,delimiter) {
  let depth=0;
  for(let i=start;i<text.length;i++) {
    if(delimiter.left==='$'&&(text[i]==='\n'||text[i]==='\r'))return -1;
    if(text[i]==='{'&&!escaped(text,i)){depth++;continue;}
    if(text[i]==='}'&&!escaped(text,i)){depth=Math.max(0,depth-1);continue;}
    if(depth!==0||escaped(text,i)||!text.startsWith(delimiter.right,i))continue;
    if(delimiter.left==='$') {
      if(text[i-1]==='$'||text[i+1]==='$'||/\s/.test(text[i-1]??'')||
        /[0-9]/.test(text[i+1]??''))continue;
    }
    return i;
  }
  return -1;
}
function splitPlainMath(text) {
  const tokens=[];
  let index=0,start=0;
  while(index<text.length) {
    if(escaped(text,index)){index++;continue;}
    let found=false;
    for(const delimiter of delimiters) {
      if(!text.startsWith(delimiter.left,index))continue;
      const contentStart=index+delimiter.left.length;
      if(delimiter.left==='$'&&
        (text[index-1]==='$'||text[contentStart]==='$'||/\s/.test(text[contentStart]??'')))continue;
      const end=mathEnd(text,contentStart,delimiter);
      if(end<0||end===contentStart)continue;
      const content=text.slice(contentStart,end);
      if(!content.trim())continue;
      const stop=end+delimiter.right.length;
      add(tokens,'text',text.slice(start,index));
      add(tokens,'math',content,{raw:text.slice(index,stop),display:delimiter.display});
      index=stop;start=stop;found=true;break;
    }
    if(!found)index++;
  }
  add(tokens,'text',text.slice(start));
  return tokens;
}
function splitMathText(value) {
  const tokens=[];
  for(const part of splitCode(String(value??''))) {
    if(part.type==='code')add(tokens,'code',part.text);
    else for(const token of splitPlainMath(part.text)) {
      if(token.type==='math')tokens.push(token);
      else add(tokens,'text',token.text);
    }
  }
  return tokens;
}
function renderText(node,value,options={}) {
  const source=String(value??''),doc=node.ownerDocument??global.document;
  const renderer=options.katex??global.katex;
  const fragment=doc.createDocumentFragment();
  for(const token of splitMathText(source)) {
    if(token.type!=='math'||!renderer?.render||token.text.length>10000) {
      const text=token.type==='math'?token.raw:token.text;
      if(token.type==='code') {
        const code=doc.createElement('span');code.className='qa-code';code.textContent=text;
        fragment.appendChild(code);
      } else fragment.appendChild(doc.createTextNode(text));
      continue;
    }
    const math=doc.createElement('span');
    math.className=token.display?'qa-math qa-math-block':'qa-math qa-math-inline';
    math.setAttribute('data-math-source',token.raw);
    try {
      renderer.render(token.text,math,{
        displayMode:token.display,output:'htmlAndMathml',throwOnError:true,
        trust:false,maxExpand:1000,maxSize:20,macros:{},globalGroup:false,strict:'warn'
      });
      fragment.appendChild(math);
    } catch {
      fragment.appendChild(doc.createTextNode(token.raw));
    }
  }
  node.replaceChildren(fragment);
  return node;
}
function putMath(node,value) {
  const source=String(value??'');
  if(rawSources.get(node)===source)return false;
  renderText(node,source);
  rawSources.set(node,source);
  return true;
}
function selectionText(selection) {
  if(!selection||!selection.rangeCount)return '';
  const range=selection.getRangeAt(0);
  const element=node=>node?.nodeType===1?node:node?.parentElement;
  const start=element(range.startContainer)?.closest?.('[data-math-source]');
  const end=element(range.endContainer)?.closest?.('[data-math-source]');
  if(start&&start===end)return start.getAttribute('data-math-source')??'';
  const clone=range.cloneContents();
  for(const math of clone.querySelectorAll('[data-math-source]')) {
    math.replaceWith(math.ownerDocument.createTextNode(math.getAttribute('data-math-source')??''));
  }
  for(const hidden of clone.querySelectorAll('.katex-mathml'))hidden.remove();
  return clone.textContent??'';
}
global.InlineQAMath=Object.freeze({
  splitMathText,renderText,putMath,selectionText,getSource:node=>rawSources.get(node)
});
})(globalThis);
