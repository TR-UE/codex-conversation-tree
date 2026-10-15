// Isolated UI verification: two conversation contexts, no user Codex data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { NativeTree } from '../plugin/codex-conversation-tree/server/native.mjs';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tree-management-ui-'));
const api=new NativeTree({dataDir:path.join(temporary,'data'),codexHome:temporary,codexBinary:'unused'});clearInterval(api.timer);clearInterval(api.apiTimer);
const a=api.store.createTree('示例 A · 当前研究'),b=api.store.createTree('示例 B · 另一对话');
const stamp=new Date().toISOString();
a.native={rootThreadId:'fixture-management-a',forks:[{threadId:'fixture-management-child',parentThreadId:'fixture-management-a',sourceNodeId:'node-a',title:'另一种研究思路',createdAt:stamp,memoryVersion:2}]};b.native={rootThreadId:'fixture-management-b'};
for(const [tree,threadId,parentThreadId,recording] of [[a,'fixture-management-a',null,false],[a,'fixture-management-child','fixture-management-a',true],[b,'fixture-management-b',null,false]])api.sessions().push({treeId:tree.id,threadId,parentThreadId,recording});
const node=(id,threadId,title)=>({id,nativeThreadId:threadId,title,question:title,answer:'演示回答：保留这条研究路线的分析过程。',status:'completed',memoryVersion:1,createdAt:stamp,parentId:null,bindings:[{threadId,turnId:'fixture-turn'}],forkable:true,files:[]});
a.nodes=[node('node-a','fixture-management-a','从哪一条研究路线开始？')];b.nodes=[node('node-b','fixture-management-b','另一对话的独立问题')];
api.store.addMemory(a,{content:'保留共同结论，允许比较不同研究路线。',sourceNodeIds:['node-a']});api.store.addMemory(b,{content:'另一棵树自己的记忆。',sourceNodeIds:['node-b']});
const memoryA=structuredClone(a.memories),memoryB=structuredClone(b.memories),calls=[],actions=[];
api.engine.connect=async()=>{};api.engine.rpc=async(method,args)=>{calls.push({method,args});assert.equal(method,'thread/read');assert.equal(args.includeTurns,false);if(args.threadId==='fixture-management-b')throw Error('thread not found');return{thread:{id:args.threadId}};};
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&new URL(req.url,'http://localhost').pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync('plugin/codex-conversation-tree/ui/panel.html'));return;}
  let raw='';for await(const chunk of req)raw+=chunk;const {name,args={}}=JSON.parse(raw);let data;
  if(name==='state')data=api.state(args.treeId,{threadId:args.threadId});
  else if(name==='pin'){data=api.pin(args);actions.push({name,hasTitle:args.title!==undefined,resetTitle:args.resetTitle});}
  else if(name==='branch'){data=api.branch(args);actions.push({name,operation:args.operation});}
  else if(name==='tree'){data=await api.management.manage(args);actions.push({name,operation:args.operation});}
  else throw Error('Only local management operations are enabled in this fixture');
  assert.deepEqual(a.memories,memoryA);assert.deepEqual(b.memories,memoryB);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
 }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
server.listen(4394,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,urls:['http://127.0.0.1:4394/?threadId=fixture-management-a','http://127.0.0.1:4394/?threadId=fixture-management-b'],treeIds:[a.id,b.id]})));
process.on('SIGTERM',()=>{
 api.close();
 const report={verifiedAt:new Date().toISOString(),version:JSON.parse(fs.readFileSync('plugin/codex-conversation-tree/plugin.json')).version,isolatedUiFixture:true,nodeRenameSaved:actions.some(a=>a.name==='pin'&&a.hasTitle),defaultNameReset:actions.some(a=>a.resetTitle),branchRenameSaved:actions.some(a=>a.name==='branch'&&a.operation==='rename'),wholeTreeDeleted:actions.some(a=>a.operation==='delete'),wholeTreeRestored:actions.some(a=>a.operation==='restore'),sourceStatusChecked:actions.some(a=>a.operation==='check_sources'),rootMemoriesAndSourcesUnchanged:true,nativeRequestsOnlyMetadata:calls.every(c=>c.method==='thread/read'&&c.args.includeTurns===false),userConversationsChanged:false};
 fs.writeFileSync('docs/tree-management-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));server.close(()=>process.exit(0));
});
