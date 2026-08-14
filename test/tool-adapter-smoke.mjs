import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here=path.dirname(fileURLToPath(import.meta.url))
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-workload-tools-'))
const workspace=path.join(temp,'workspace');fs.mkdirSync(workspace,{recursive:true});process.env.DSH_HOME=path.join(temp,'home')
const {LocalWorkloadRegistry}=await import(pathToFileURL(path.join(here,'..','lib','index.js')).href+'?tools='+Date.now())
const tools=new Map();const registry=new LocalWorkloadRegistry();const ctx={
  workloads:registry,sandboxPolicy:{resolve(){return{workspaceRoot:workspace}}},
  tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},systemPrompt:{context(){return()=>{}}},
}
const adapter=await import(pathToFileURL(path.join(here,'..','lib','tools.mjs')).href+'?smoke='+Date.now())
adapter.apply(ctx)
const expected=['workload_list','workload_start','workload_wait','workload_logs','workload_stop','workload_restart','proc_list','proc_start','proc_wait','proc_logs','proc_stop','proc_restart']
if(expected.some((name)=>!tools.has(name)))throw new Error('tool registration missing')
const exec={agent:{session:{}},signal:new AbortController().signal}
let port=43210
while(port<43300){const free=await new Promise((resolve)=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)))});if(free)break;port++}
let workloadId
try{
  const command=`"${process.execPath}" "${path.join(here,'smoke-server.mjs')}" ${port}`
  const started=JSON.parse(await tools.get('workload_start').execute({command,label:`tools:${port}`},exec));workloadId=started.workloadId
  const listed=JSON.parse(await tools.get('proc_list').execute({active_only:true},exec));if(!listed.workloads.some((x)=>x.workloadId===workloadId))throw new Error('compat list failed')
  const ready=JSON.parse(await tools.get('proc_wait').execute({job_id:workloadId,port,timeout_ms:15000},exec));if(!ready.ready)throw new Error('compat wait failed')
  const stopped=JSON.parse(await tools.get('workload_stop').execute({workload_id:workloadId},exec));if(stopped.phase!=='stopped'||stopped.lastAction?.source!=='tool'||stopped.lastAction?.type!=='stop')throw new Error('tool stop audit failed')
  console.log(JSON.stringify({toolCount:tools.size,workloadId,compatibility:true,stopped:stopped.phase}))
}finally{if(workloadId){try{await registry.stop(workspace,workloadId)}catch{}}fs.rmSync(temp,{recursive:true,force:true})}
