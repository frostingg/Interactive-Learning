import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const CSS_MARKER='/* INLINE_QA_MATH_STYLE */';
const JS_MARKER='/* INLINE_QA_MATH_SCRIPT */';
let assetPromise;
async function mathAssets() {
  const [javascript,originalCss,renderer,license]=await Promise.all([
    readFile(new URL('node_modules/katex/dist/katex.min.js',root),'utf8'),
    readFile(new URL('node_modules/katex/dist/katex.min.css',root),'utf8'),
    readFile(new URL('public/math-renderer.js',root),'utf8'),
    readFile(new URL('node_modules/katex/LICENSE',root),'utf8')
  ]);
  const faces=[...originalCss.matchAll(/@font-face\s*\{[^}]*\}/g)];
  if(!faces.length)throw Error('KaTeX font faces were not found.');
  const replacements=await Promise.all(faces.map(async match=>{
    const source=/url\(["']?([^)"']+\.woff2)["']?\)/.exec(match[0])?.[1];
    if(!source||!/^fonts\/[A-Za-z0-9_-]+\.woff2$/.test(source))throw Error('KaTeX WOFF2 source is invalid.');
    const font=await readFile(new URL('node_modules/katex/dist/'+source,root));
    if(!/src:[^;}]+(?:;|(?=\}))/.test(match[0]))throw Error('KaTeX font face source is missing.');
    return match[0].replace(/src:[^;}]+(?:;|(?=\}))/,'src:url("data:font/woff2;base64,'+font.toString('base64')+'") format("woff2");');
  }));
  let css='',cursor=0;
  faces.forEach((match,index)=>{
    css+=originalCss.slice(cursor,match.index)+replacements[index];
    cursor=match.index+match[0].length;
  });
  css+=originalCss.slice(cursor);
  const urls=[...css.matchAll(/url\(([^)]+)\)/gi)].map(x=>x[1].trim().replace(/^["']|["']$/g,''));
  if(urls.some(url=>!url.startsWith('data:')))throw Error('External KaTeX resource URL remains.');
  const script=('/* KaTeX license\n'+license.replace(/\*\//g,'* /')+'\n*/\n'+javascript+'\n;\n'+renderer+'\n').replace(/<\/script/gi,'<\\/script');
  return {css:css.replace(/<\/style/gi,'<\\/style'),script};
}
export async function loadUiHtml(filename='widget.html') {
  if(!['widget.html','demo.html','ui-check.html'].includes(filename))throw Error('Unknown UI asset.');
  const html=await readFile(new URL('public/'+filename,root),'utf8');
  if(filename==='ui-check.html')return html;
  if(html.split(CSS_MARKER).length!==2||html.split(JS_MARKER).length!==2)throw Error('Math asset marker is missing or repeated.');
  assetPromise??=mathAssets();
  const {css,script}=await assetPromise;
  return html.replace(CSS_MARKER,()=>css).replace(JS_MARKER,()=>script);
}
