import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { NativeTree } from '../plugin/codex-conversation-tree/server/native.mjs';

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tree-management-'));
 const settings={dataDir:path.join(root,'data'),codexHome:root,codexBinary:'unused'};
 const native=new NativeTree(settings);clearInterval(native.timer);clearInterval(native.apiTimer);
 const instances=[native];t.after(()=>{for(const item of instances)item.close();fs.rmSync(root,{recursive:true,force:true});});
 const a=native.store.createTree('Current tree'),b=native.store.createTree('Other tree');
 a.updatedAt='2026-01-01T00:00:00Z';b.updatedAt='2026-02-01T00:00:00Z';
 a.native={rootThreadId:'current-root-thread',forks:[{threadId:'current-child-thread',parentThreadId:'current-root-thread',sourceNodeId:'prompt',title:'Child'}]};b.native={rootThreadId:'other-root-thread'};
 native.sessions().push({treeId:a.id,threadId:'current-root-thread',recording:false},{treeId:a.id,threadId:'current-child-thread',parentThreadId:'current-root-thread',recording:true},{treeId:b.id,threadId:'other-root-thread',recording:false});
 a.nodes=[{id:'prompt',title:'Question',question:'Question',answer:'Answer',status:'completed',nativeThreadId:'current-root-thread',bindings:[{threadId:'current-root-thread',turnId:'t1'},{threadId:'current-child-thread',turnId:'t1'}],memoryVersion:1,forkable:true}];
 native.store.addMemory(a,{content:'Shared conclusion',sourceNodeIds:['prompt']});
 native.engine.connect=async()=>{};
 return {native,a,b,settings,instances};
}
test('custom node names survive prompt normalization and restart; reset restores the latest question title',t=>{
 const {native,a,settings,instances}=fixture(t),node=a.nodes[0],memory=structuredClone(a.memories);
 native.pin({treeId:a.id,nodeId:node.id,title:'Question'});
 native.updatePrompt(node,'Normalized question');assert.equal(node.title,'Question');assert.equal(node.question,'Normalized question');
 native.pin({treeId:a.id,nodeId:node.id,title:'My short name'});
 assert.throws(()=>native.pin({treeId:a.id,nodeId:node.id,title:'   ',pinned:true}),/不能为空/);assert.equal(node.pinned,undefined);
 assert.throws(()=>native.pin({treeId:a.id,nodeId:node.id,title:'名'.repeat(101)}),/100/);
 native.close();const restarted=new NativeTree(settings);clearInterval(restarted.timer);clearInterval(restarted.apiTimer);instances.push(restarted);
 assert.equal(restarted.store.tree(a.id).nodes[0].title,'My short name');
 restarted.pin({treeId:a.id,nodeId:node.id,resetTitle:true});assert.equal(restarted.store.tree(a.id).nodes[0].title,'Normalized question');
 assert.deepEqual(restarted.store.tree(a.id).memories,memory);
});
test('tree and empty-branch rename change only local display names',async t=>{
 const {native,a}=fixture(t),memory=structuredClone(a.memories),parents=native.sessions().map(s=>s.parentThreadId);
 native.engine.rpc=async()=>{throw Error('Rename must not call native APIs');};
 native.branch({treeId:a.id,operation:'rename',threadId:'current-child-thread',title:'Candidate route'});
 assert.equal(native.paths(a).find(p=>p.threadId==='current-child-thread').title,'Candidate route');
 await native.management.manage({treeId:a.id,operation:'rename',title:'Research',contextThreadId:'current-root-thread'});
 assert.equal(a.title,'Research');assert.equal(a.nodes[0].question,'Question');assert.deepEqual(a.memories,memory);assert.deepEqual(native.sessions().map(s=>s.parentThreadId),parents);
});
test('current conversation wins over a newer tree while explicit browsing keeps its return context',t=>{
 const {native,a,b}=fixture(t);
 const current=native.state(undefined,{threadId:'current-root-thread'});
 assert.equal(current.tree.id,a.id);assert.equal(current.trees[0].id,a.id);assert.equal(current.context.treeId,a.id);
 assert.equal(native.state(undefined,{threadId:'current-child-thread'}).tree.id,a.id);
 const other=native.state(b.id,{threadId:'current-root-thread'});assert.equal(other.tree.id,b.id);assert.equal(other.context.treeId,a.id);assert.ok(other.sessions.every(s=>s.treeId===b.id));
 const unlinked=native.state(undefined,{threadId:'unlinked-current-thread'});assert.equal(unlinked.tree,null);assert.equal(unlinked.context.status,'unlinked');assert.equal(native.sessions().length,3);
});
test('forking a shared node uses the current conversation binding when it owns that history',async t=>{
 const {native,a}=fixture(t),calls=[];
 native.newEngine=()=>({connect:async()=>{},rpc:async(method,args)=>{calls.push({method,args});return method==='thread/fork'?{thread:{id:'new-context-fork-thread'}}:{};},stop:()=>{}});
 native.link=async id=>{native.sessions().push({treeId:a.id,threadId:id,parentThreadId:'current-child-thread',recording:false});};
 const result=await native.fork({treeId:a.id,nodeId:'prompt',contextThreadId:'current-child-thread'});
 assert.equal(calls.find(c=>c.method==='thread/fork').args.threadId,'current-child-thread');assert.equal(result.parentThreadId,'current-child-thread');assert.equal(result.context.threadId,'current-child-thread');assert.equal(native.forkingTrees.size,0);
});
test('whole-tree deletion is recoverable, persistent, stops syncing and cannot be undone by re-linking',async t=>{
 const {native,a,b,settings,instances}=fixture(t),memory=structuredClone(a.memories),nodes=structuredClone(a.nodes);
 const result=await native.management.manage({treeId:a.id,operation:'delete',contextThreadId:'current-root-thread'});
 assert.equal(result.tree,null);assert.equal(result.context.status,'deleted');assert.ok(!result.trees.some(t=>t.id===a.id));assert.ok(result.treeCatalog.find(t=>t.id===a.id).deletedAt);
 assert.ok(native.sessions().filter(s=>s.treeId===a.id).every(s=>!s.recording));
 await assert.rejects(native.link('current-root-thread'),/已删除/);
 assert.throws(()=>native.pin({treeId:a.id,nodeId:'prompt',title:'Unexpected'}),/已删除/);
 await assert.rejects(native.deletion.preview({treeId:a.id,threadId:'current-child-thread'}),/已删除/);
 native.close();const restarted=new NativeTree(settings);clearInterval(restarted.timer);clearInterval(restarted.apiTimer);instances.push(restarted);
 assert.equal(restarted.state(undefined,{threadId:'current-root-thread'}).context.status,'deleted');
 await restarted.management.manage({treeId:a.id,operation:'restore',contextThreadId:'current-root-thread'});
 assert.equal(restarted.state(undefined,{threadId:'current-root-thread'}).tree.id,a.id);
 assert.deepEqual(restarted.store.tree(a.id).memories,memory);assert.deepEqual(restarted.store.tree(a.id).nodes,nodes);
 assert.equal(restarted.sessions().find(s=>s.threadId==='current-root-thread').recording,false);assert.equal(restarted.sessions().find(s=>s.threadId==='current-child-thread').recording,true);
 assert.equal(restarted.store.tree(b.id).title,'Other tree');
});
test('in-flight transcript reads cannot re-import a deleted tree',async t=>{
 const {native,a}=fixture(t),session=native.sessions().find(s=>s.threadId==='current-child-thread');let finish,entered;
 const started=new Promise(resolve=>entered=resolve);
 native.engine.rpc=async()=>{entered();return new Promise(resolve=>finish=resolve);};
 const reading=native.syncApi(session);await started;
 await native.management.manage({treeId:a.id,operation:'delete'});
 finish({data:[{id:'t2',status:'completed',items:[{type:'userMessage',id:'new',content:[{type:'text',text:'Do not import'}]}]}],nextCursor:null});await reading;
 assert.equal(a.nodes.length,1);assert.equal(native.state(a.id).tree,null);
});
test('tree deletion waits for branch creation and pending native deletion',async t=>{
 const {native,a}=fixture(t);
 native.forkingTrees.set(a.id,1);await assert.rejects(native.management.manage({treeId:a.id,operation:'delete'}),/创建原生分支/);native.forkingTrees.clear();
 a.native.deletions=[{status:'pending'}];await assert.rejects(native.management.manage({treeId:a.id,operation:'delete'}),/待核验/);assert.equal(a.deletedAt,undefined);
});
test('metadata checks hide fully missing trees without deleting local records or treating timeouts as deletion',async t=>{
 const {native,a,b}=fixture(t),calls=[],before=structuredClone(a.memories);
 native.engine.rpc=async(method,args)=>{calls.push({method,args});if(args.threadId.startsWith('current-'))throw Error('thread not found');throw Error('request timed out');};
 const result=await native.management.manage({operation:'check_sources',contextThreadId:'other-root-thread'});
 assert.equal(result.sourceCheck.checked,3);assert.ok(!result.trees.some(t=>t.id===a.id));assert.ok(result.trees.some(t=>t.id===b.id));assert.equal(result.treeCatalog.find(t=>t.id===a.id).sourceStatus,'missing');assert.equal(a.deletedAt,undefined);
 assert.deepEqual(a.memories,before);assert.equal(native.state(a.id).tree.nodes.length,1);
 assert.ok(calls.every(c=>c.method==='thread/read'&&c.args.includeTurns===false));assert.deepEqual(new Set(calls.map(c=>c.args.threadId)),new Set(native.sessions().map(s=>s.threadId)));
});
test('available archived or returned sources resume only previously recording, unpruned, undeleted paths',async t=>{
 const {native,a}=fixture(t),child=native.sessions().find(s=>s.threadId==='current-child-thread');
 native.management.setSource(child,'missing');assert.equal(child.recording,false);
 native.engine.rpc=async(_method,args)=>({thread:{id:args.threadId,archived:true}});
 await native.management.checkSources(a.id);assert.equal(child.recording,true);
 native.branch({treeId:a.id,operation:'prune',threadId:child.threadId});native.management.setSource(child,'missing');await native.management.checkSources(a.id);assert.equal(child.recording,false);
 await native.management.manage({treeId:a.id,operation:'delete'});await native.management.checkSources(a.id);assert.ok(native.sessions().filter(s=>s.treeId===a.id).every(s=>!s.recording));
});
test('an unloaded or temporarily unreadable source is not classified as missing',async t=>{
 const {native,a}=fixture(t),session=native.sessions().find(s=>s.threadId==='current-child-thread');
 native.engine.rpc=async(method)=>{throw Error(method==='thread/turns/list'?'no rollout found':'thread not loaded');};
 await assert.rejects(native.syncApi(session));assert.equal(session.sourceStatus,'unknown');assert.equal(session.recording,true);assert.ok(native.state().trees.some(t=>t.id===a.id));
});
test('CLI panel URLs bind their current thread and reopening a deleted tree does not silently relink it',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tree-context-cli-')),calls=[];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET'){res.end(JSON.stringify({app:'codex-conversation-tree-plugin',apiVersion:1}));return;}
  let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);calls.push(data);res.end(JSON.stringify({tree:null,context:{threadId:data.args.threadId,treeId:'deleted-tree',status:'deleted'},trees:[],sessions:[]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.close();fs.rmSync(root,{recursive:true,force:true});});
 const child=spawn(process.execPath,[path.resolve('plugin/codex-conversation-tree/server/cli.mjs'),'open','--thread-id','current-thread-context'],{env:{...process.env,TREE_NATIVE_DATA_DIR:root,TREE_NATIVE_PORT:String(server.address().port)},stdio:['ignore','pipe','pipe']});
 let output='',error='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);
 const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,0,error);assert.equal(new URL(JSON.parse(output).panelUrl).searchParams.get('threadId'),'current-thread-context');assert.ok(calls.every(c=>c.name==='state'));
});
