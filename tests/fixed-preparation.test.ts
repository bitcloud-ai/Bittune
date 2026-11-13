import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {runFixedPreparation} from "../packages/bittune-runtime/src/workbench/fixed-preparation.ts";
import type {TaskScope} from "../packages/bittune-runtime/src/harness/task-scope.ts";

test("fixed preparation executes only the approved scoped command without a model API",async()=>{
 const cwd=await mkdtemp(join(tmpdir(),"bittune-preparation-")),command="printf prepared > prepared.txt";
 const scope:TaskScope={schema_version:1,allow_execution:true,preparation_commands:[command],plan_ids:[],service_instance_ids:[],record_ids:[],read_paths:[],inventory_commands:[],scope_hash:"test"};
 const options={command,cwd,scope,protectedRoots:[join(cwd,"protected")],signal:new AbortController().signal,onStart:()=>{}};
 try{
  assert.equal(await runFixedPreparation({...options,approve:async()=>false}),undefined);
  await assert.rejects(stat(join(cwd,"prepared.txt")));
  await assert.rejects(runFixedPreparation({...options,command:"printf outside > outside.txt",approve:async()=>true}),/task_scope_denied/);
  await runFixedPreparation({...options,approve:async()=>true});
  assert.equal(await readFile(join(cwd,"prepared.txt"),"utf8"),"prepared");
  await assert.rejects(stat(join(cwd,"outside.txt")));
 }finally{await rm(cwd,{recursive:true,force:true});}
});
