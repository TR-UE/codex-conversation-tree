import { findCodex } from '../plugin/codex-conversation-tree/server/paths.mjs';
// Real paginated history + an empty native fork outside the tree, in an
// isolated disposable profile. No login or user conversations are used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { NativeTree } from '../plugin/codex-conversation-tree/server/native.mjs';
import { Codex } from '../plugin/codex-conversation-tree/server/codex.mjs';
import { scanHistoryMetadata } from '../plugin/codex-conversation-tree/server/history-metadata.mjs';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-real-history-delete-'));
const home = path.join(root, 'codex');fs.mkdirSync(home);
// A local deterministic Responses fixture creates authentic native history.
// It sends no requests to OpenAI and does not inspect or save model inputs.
const mockModel = http.createServer(async (req,res)=>{
  for await (const _ of req) {}
  const item={type:'message',id:'msg_fixture',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'Disposable final answer',annotations:[]}]};
  const response={id:'resp_fixture',object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}])res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
});
await new Promise(resolve=>mockModel.listen(0,'127.0.0.1',resolve));
fs.writeFileSync(path.join(home,'config.toml'),`model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local test fixture"\nbase_url = "http://127.0.0.1:${mockModel.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
process.env.CODEX_HOME = home;
process.env.CODEX_BINARY ||= findCodex();
const native = new NativeTree({dataDir:path.join(root,'data'),codexHome:home,codexBinary:process.env.CODEX_BINARY});
clearInterval(native.timer);
let external;
try {
  await native.engine.connect();
  const {thread:source}=await native.engine.rpc('thread/start',{cwd:root,model:'fixture-model',modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only'});
  const sourceId=source.id,sourcePath=source.path;
  const completed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture turn timed out')),20000);native.engine.on('notification',message=>{if(message.method==='turn/completed'&&message.params.threadId===sourceId){clearTimeout(timer);resolve(message.params.turn);}});});
  await native.engine.rpc('turn/start',{threadId:sourceId,input:[{type:'text',text:'Disposable question with real stored history'}]});
  const turn=await completed;assert.equal(turn.status,'completed');
  const initial = await native.link(sourceId, 'History deletion fixture');
  assert.equal(initial.tree.nodes.length,1);assert.equal(initial.tree.nodes[0].forkable,true);
  const visible = await native.engine.rpc('thread/turns/list',{threadId:sourceId,itemsView:'summary',limit:10});assert.equal(visible.data.length,1);
  const beforeFork = (await scanHistoryMetadata(home)).size;
  const branch = await native.fork({treeId:initial.tree.id,nodeId:initial.tree.nodes[0].id,title:'Disposable history branch'});
  assert.equal((await scanHistoryMetadata(home)).size,beforeFork+1);
  // A second client represents the desktop opening the newly created branch.
  // It must be able to resume that exact ID without asking for another fork.
  external = new Codex(home,{experimentalApi:true});await external.connect();
  const resumed = await external.rpc('thread/resume',{threadId:branch.threadId,excludeTurns:true});
  assert.equal(resumed.thread.id,branch.threadId);
  const continued = new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Continuation timed out')),20000);external.on('notification',message=>{if(message.method==='turn/completed'&&message.params.threadId===branch.threadId){clearTimeout(timer);resolve(message.params.turn);}});});
  await external.rpc('turn/start',{threadId:branch.threadId,input:[{type:'text',text:'Continue this same branch without another fork'}]});
  assert.equal((await continued).status,'completed');
  const recorded=()=>native.store.tree(initial.tree.id).nodes.some(n=>n.question==='Continue this same branch without another fork'&&n.nativeThreadId===branch.threadId);
  const deadline=Date.now()+5000;while(!recorded()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(native.store.tree(initial.tree.id).nodes.some(n=>n.question==='Continue this same branch without another fork'&&n.nativeThreadId===branch.threadId));
  assert.equal((await scanHistoryMetadata(home)).size,beforeFork+1);
  const handedOff = new Promise(resolve=>external.child.once('exit',resolve));external.stop();await handedOff;external=null;
  const sibling = await native.fork({treeId:initial.tree.id,nodeId:initial.tree.nodes[0].id,title:'Preserved sibling'});
  const {thread:child} = await native.engine.rpc('thread/fork',{threadId:branch.threadId,excludeTurns:true});
  await native.engine.rpc('thread/name/set',{threadId:child.id,name:'Empty unlinked child'});
  const meta = JSON.parse(fs.readFileSync(child.path,'utf8').split('\n')[0]).payload;
  assert.equal(meta.history_base.thread_id,branch.threadId);
  assert.equal(native.sessions().some(s=>s.threadId===child.id),false);
  await native.engine.rpc('thread/archive',{threadId:child.id});
  const invisible = await native.engine.rpc('thread/list',{ancestorThreadId:branch.threadId,archived:true,limit:100});
  assert.equal(invisible.data.some(t=>t.id===child.id),false);
  const plan = await native.deletion.preview({treeId:initial.tree.id,threadId:branch.threadId});
  assert.equal(plan.threads.length,2);assert.ok(plan.threads.some(t=>t.threadId===child.id));

  // Reproduce a writer owned by a second process. The plugin must report it
  // without killing that process or treating the branch as deleted.
  await native.releaseEngineWriters();
  external = new Codex(home,{experimentalApi:true});await external.connect();
  await external.rpc('thread/resume',{threadId:branch.threadId,excludeTurns:true});
  const failed = await native.deletion.execute({treeId:initial.tree.id,threadId:branch.threadId,planId:plan.planId,confirmation:plan.confirmationText});
  assert.notEqual(failed.deletionResult.status,'completed');
  assert.ok(failed.deletionResult.errors.some(e=>/active writer/.test(e.message)));
  assert.ok(failed.deletionResult.errors.some(e=>/Codex/.test(e.reason)));
  assert.equal(fs.existsSync(sourcePath),true);assert.equal(native.sessions().find(s=>s.threadId===branch.threadId).nativeDeletedAt,undefined);
  const exited = new Promise(resolve=>external.child.once('exit',resolve));external.stop();await exited;external=null;
  const retry = await native.deletion.preview({treeId:initial.tree.id,threadId:branch.threadId});
  const result = await native.deletion.execute({treeId:initial.tree.id,threadId:branch.threadId,planId:retry.planId,confirmation:retry.confirmationText});
  assert.equal(result.deletionResult.status,'completed');
  for (const id of [branch.threadId,child.id]) await assert.rejects(native.engine.rpc('thread/read',{threadId:id,includeTurns:false}),/not found|not loaded|no rollout found/);
  for (const id of [sourceId,sibling.threadId]) {const {thread}=await native.engine.rpc('thread/read',{threadId:id,includeTurns:false});assert.equal(thread.id,id);}
  assert.equal(native.store.tree(initial.tree.id).nodes[0].answer,'Disposable final answer');
  const report = {verifiedAt:new Date().toISOString(),profile:'isolated disposable CODEX_HOME',realPaginatedHistory:true,exactlyOneThreadPerBranch:true,openedWithoutSecondFork:true,sameThreadIdContinued:true,continuationAutomaticallyRecorded:true,unlinkedEmptyArchivedForkDiscovered:true,childDeletedBeforeParent:true,externalWriterReproduced:true,externalWriterNotTerminatedByPlugin:true,retrySucceedsAfterWriterReleased:true,parentAndSiblingPreserved:true,localRecordPreserved:true,userConversationsTouched:false};
  fs.writeFileSync(path.resolve('docs/native-history-delete-integration.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {external?.stop();native.close();mockModel.close();}
