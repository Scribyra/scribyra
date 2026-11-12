import {createRequire} from 'node:module';
export const S='<scratch>',P='<scratch>/plugin';
const tools=createRequire(S+'/tools/');
export const {Client}=tools('@modelcontextprotocol/sdk/client/index.js');
export const {StdioClientTransport}=tools('@modelcontextprotocol/sdk/client/stdio.js');
const cl=await import(S+'/tools/node_modules/gpt-tokenizer/esm/encoding/cl100k_base.js');
export const cl100k=t=>cl.encode(String(t),{disallowedSpecial:new Set()}).length;
export const CHROMIUM='/nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium';
export const PW=S+'/tools/node_modules/@playwright/mcp/cli.js';
export const DT=S+'/tools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js';
export const BASE='http://127.0.0.1:5192/app/';
export async function mcpClient(cli,args,{cwd=P+'/measure/out'}={}){
  const transport=new StdioClientTransport({command:process.execPath,args:[cli,...args],cwd,stderr:'ignore',env:{...process.env,HOME:P+'/measure/home',CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS:'1'}});
  const client=new Client({name:'plugin-measure',version:'1'});await client.connect(transport);
  const call=async(name,a={},timeout=600000)=>{const t=performance.now();const r=await client.callTool({name,arguments:a},undefined,{timeout});const ms=performance.now()-t;
    const text=(r.content||[]).map(c=>c.type==='text'?c.text:'['+c.type+':'+(c.data||'').length+']').join('\n');
    return{text,ms,bytes:Buffer.byteLength(text),req:Buffer.byteLength(JSON.stringify({name,arguments:a})),isError:!!r.isError};};
  return{client,call,close:()=>client.close()};
}
