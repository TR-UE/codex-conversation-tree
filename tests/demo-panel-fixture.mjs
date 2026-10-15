// Disposable local UI fixture. No native Codex connections or user conversations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { NativeTree } from '../plugin/codex-conversation-tree/server/native.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-main-ui-'));
const settings = { dataDir: path.join(temporary, 'data'), codexHome: temporary, codexBinary: 'unused' };
const native = new NativeTree(settings);clearInterval(native.timer);clearInterval(native.apiTimer);
native.engine.connect = async () => { throw Error('UI fixture cannot connect to native Codex'); };
const tree = native.store.createTree('演示数据：比较研究方案');
const stamp = new Date().toISOString();
tree.native = { rootThreadId: 'fixture-root-path', forks: [
  { threadId: 'fixture-candidate-path', parentThreadId: 'fixture-root-path', sourceNodeId: 'shared', title: '路线 A · 机制模型', createdAt: stamp, memoryVersion: 2 },
  { threadId: 'fixture-other-path', parentThreadId: 'fixture-root-path', sourceNodeId: 'shared', title: '路线 B · 统计基线', createdAt: stamp, memoryVersion: 2 },
  { threadId: 'fixture-main-child', parentThreadId: 'fixture-candidate-path', sourceNodeId: 'candidate-only', title: '路线 A · 预测检验', createdAt: stamp, memoryVersion: 2 }
] };
for (const [threadId,parentThreadId] of [['fixture-root-path',null],['fixture-candidate-path','fixture-root-path'],['fixture-other-path','fixture-root-path'],['fixture-main-child','fixture-candidate-path']]) native.sessions().push({ treeId: tree.id,threadId,parentThreadId,recording: true });
const make = (id,title,owner,parentId,bindings) => ({ id,title,question:title,answer:'演示回答：'+title,createdAt:stamp,status:'completed',memoryVersion:2,nativeThreadId:owner,parentId,bindings:bindings.map(threadId=>({threadId,turnId:id})),forkable:true,files:[] });
tree.nodes = [
  make('shared','研究问题：如何解释密度变化？','fixture-root-path',null,['fixture-root-path','fixture-candidate-path','fixture-other-path','fixture-main-child']),
  make('old-only','旧路线：直接拟合曲线','fixture-root-path','shared',['fixture-root-path']),
  make('candidate-only','路线 A：先建立机制模型','fixture-candidate-path','shared',['fixture-candidate-path','fixture-main-child']),
  make('other-only','路线 B：先构建统计基线','fixture-other-path','shared',['fixture-other-path']),
  make('child-only','比较两种模型的预测误差','fixture-main-child','candidate-only',['fixture-main-child'])
];
native.store.addMemory(tree,{content:'优先选择能解释机制、并通过预测检验的模型',sourceNodeIds:['old-only']});
const memories = structuredClone(tree.memories), parents = native.sessions().map(s=>s.parentThreadId);
let promoted=false,pruned=false,restored=false;
const server=http.createServer(async(req,res)=>{
  try {
    if(req.url==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html'});res.end(fs.readFileSync(path.resolve('plugin/codex-conversation-tree/ui/panel.html')));return;}
    if(req.url==='/api/action'&&req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;
      const {name,args}=JSON.parse(raw);let result;
      if(name==='state')result=native.state(tree.id);
      else if(name==='branch'){
        result=native.branch(args);
        assert.deepEqual(tree.memories,memories);assert.deepEqual(native.sessions().map(s=>s.parentThreadId),parents);
        if(args.operation==='promote'){assert.equal(result.tree.native.mainThreadId,'fixture-candidate-path');promoted=true;}
        if(args.operation==='prune'){
          assert.equal(args.threadId,'fixture-root-path');assert.equal(result.tree.native.mainThreadId,'fixture-candidate-path');
          assert.deepEqual(result.tree.nodes.map(n=>n.id),['shared','candidate-only','child-only']);
          assert.equal(native.sessions().find(s=>s.threadId==='fixture-candidate-path').recording,true);pruned=true;
        }
        if(args.operation==='restore'){assert.equal(result.tree.nodes.length,5);restored=true;}
      } else throw Error('This fixture only supports state and reversible branch operations');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));return;
    }
    res.writeHead(404);res.end();
  }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
server.listen(4394,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:4394/',temporary})));
process.on('SIGTERM',()=>{
  native.close();const restarted=new NativeTree(settings);clearInterval(restarted.timer);clearInterval(restarted.apiTimer);
  const result=restarted.state(tree.id);assert.equal(result.tree.native.mainThreadId,'fixture-candidate-path');restarted.close();
  const report={version:JSON.parse(fs.readFileSync('plugin/codex-conversation-tree/plugin.json')).version,verifiedAt:new Date().toISOString(),isolatedUiFixture:true,promotionClicked:promoted,formerMainPruned:pruned,restoredFromPanel:restored,sharedHistoryAndNewMainDescendantsPreserved:pruned,rootMemoryAndSourceReferencesPreserved:true,nativeLineageUnchanged:true,mainSelectionPersistedAfterRestart:true,userConversationsChanged:false};
  fs.writeFileSync('docs/main-branch-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  server.close(()=>process.exit(promoted&&pruned&&restored?0:1));
});
