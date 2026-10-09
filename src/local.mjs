import http from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MemoryStore} from './store.mjs';
import {createService,createMcpHandler,answerWithOpenAI} from './core.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const dataPath=path.join(root,'.local-data','boards.json');
class FileStore extends MemoryStore {
  async persist(records) {
    await mkdir(path.dirname(dataPath),{recursive:true});
    await writeFile(dataPath+'.tmp',JSON.stringify([...records]),'utf8');
    await rename(dataPath+'.tmp',dataPath);
  }
  constructor(){ super(); this.queue=Promise.resolve(); }
  async serial(operation) {
    const result=this.queue.then(operation);
    this.queue=result.catch(()=>{});
    return result;
  }
  async create(owner,board){ return this.serial(async()=>{const next=new Map(this.records);next.set(owner+':'+board.id,{board:structuredClone(board),version:0});await this.persist(next);this.records=next;}); }
  async compareAndSwap(owner,id,version,board){return this.serial(async()=>{const key=owner+':'+id;if(this.records.get(key)?.version!==version)return false;const next=new Map(this.records);next.set(key,{board:structuredClone(board),version:version+1});await this.persist(next);this.records=next;return true;});}
}
const store=new FileStore();
try{store.records=new Map(JSON.parse(await readFile(dataPath,'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}
const widget=await readFile(path.join(root,'public','widget.html'),'utf8');
const service=createService(store,(card,question)=>answerWithOpenAI(card,question,process.env));
const mcp=createMcpHandler(service,widget);
const port=Number(process.env.PORT||8787);
http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1:'+port);
    // This development server binds to loopback and does not trust incoming
    // identity headers. It is intentionally not a public authentication server.
    if(req.headers.origin && req.headers.origin!=='http://127.0.0.1:'+port && req.headers.origin!=='http://localhost:'+port){res.writeHead(403);res.end('Origin rejected');return;}
    if(url.pathname==='/mcp'){
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>250000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const body=Buffer.concat(chunks).toString('utf8');
      const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='GET'||req.method==='HEAD'?{}:{body})});
      const response=await mcp(request,'local-user');
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(await response.text());return;
    }
    const filename=url.pathname==='/widget.html'?'widget.html':url.pathname==='/'||url.pathname==='/demo.html'?'demo.html':null;
    if(!filename){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    res.end(await readFile(path.join(root,'public',filename),'utf8'));
  }catch{res.writeHead(500);res.end('Service unavailable');}
}).listen(port,'127.0.0.1',()=>console.log('Interactive QA development preview: http://127.0.0.1:'+port));
