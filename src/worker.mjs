import {D1Store} from './store.mjs';
import {createService,createMcpHandler} from './core.mjs';
// scripts/build.mjs embeds the self-contained HTML assets in this module.
import {widgetHtml,demoHtml} from './generated-ui.mjs';
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==='/health') return Response.json({service:'inline-qa',version:'0.3.2'});
    if(url.pathname==='/mcp') {
      const owner=request.headers.get('oai-authenticated-user-id');
      if(!env.DB) return Response.json({error:'Storage unavailable'},{status:503});
      // Trust this header only behind the Sites authenticated dispatch boundary.
      // Do not expose this Worker on a public origin without authentication.
      const service=createService(new D1Store(env.DB),{status:()=>({storageReady:!!env.DB})});
      return createMcpHandler(service,widgetHtml)(request,owner);
    }
    if(url.pathname==='/' || url.pathname==='/demo.html') return new Response(demoHtml,{headers:{'Content-Type':'text/html; charset=utf-8'}});
    return new Response('Not found',{status:404});
  }
};
