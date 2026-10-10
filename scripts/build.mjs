import {readFile,mkdir,writeFile,copyFile,cp} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const source=new URL('src/',root);
const out=new URL('dist/server/',root);
await mkdir(out,{recursive:true});
const widgetHtml=await readFile(new URL('public/widget.html',root),'utf8');
const demoHtml=await readFile(new URL('public/demo.html',root),'utf8');
await writeFile(new URL('generated-ui.mjs',out),'export const widgetHtml='+JSON.stringify(widgetHtml)+';\nexport const demoHtml='+JSON.stringify(demoHtml)+';\n');
await copyFile(new URL('worker.mjs',source),new URL('index.js',out));
await copyFile(new URL('core.mjs',source),new URL('core.mjs',out));
await copyFile(new URL('store.mjs',source),new URL('store.mjs',out));
console.log('Worker entrypoint: dist/server/index.js');

let hosting;try{hosting=await readFile(new URL('.openai/hosting.json',root),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(hosting!==undefined){await mkdir(new URL('dist/.openai/',root),{recursive:true});await writeFile(new URL('dist/.openai/hosting.json',root),hosting);await cp(new URL('drizzle/',root),new URL('dist/.openai/drizzle/',root),{recursive:true});}
