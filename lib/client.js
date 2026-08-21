window.__ModuleLoader__.load({ id: 'dsh-workloads-local-ui1', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
const React = require("react");
const h = React.createElement;
const inject = ["slots", "timer"];
const C = {
  bg:"var(--dsw-alias-bg-base)", l1:"var(--dsw-alias-bg-layer-1)", l2:"var(--dsw-alias-bg-layer-2)",
  b1:"var(--dsw-alias-border-l1)", b2:"var(--dsw-alias-border-l2)", brand:"var(--dsw-alias-brand-primary)",
  p:"var(--dsw-alias-label-primary)", s:"var(--dsw-alias-label-secondary)", ok:"var(--dsw-alias-state-success-primary)",
  warn:"var(--dsw-alias-state-warn-primary)", err:"var(--dsw-alias-state-error-primary)"
};
function fmt(value){if(!value)return"—";const d=new Date(value);return Number.isNaN(d.getTime())?String(value):d.toLocaleString()}
function tone(value){if(value==="running"||value==="ready"||value==="completed")return C.ok;if(value==="starting"||value==="stopping"||value==="checking")return C.warn;if(value==="failed"||value==="unhealthy")return C.err;return C.s}
async function get(op,cwd,sessionId,workloadId){let url="/dsh-workloads/api?op="+encodeURIComponent(op)+"&cwd="+encodeURIComponent(cwd)+"&sessionId="+encodeURIComponent(sessionId);if(workloadId)url+="&workloadId="+encodeURIComponent(workloadId);const r=await fetch(url,{headers:{accept:"application/json"},cache:"no-store"});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error||("HTTP "+r.status));return p}
async function post(op,cwd,sessionId,workloadId){const r=await fetch("/dsh-workloads/api",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({op,cwd,sessionId,workloadId})});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error||("HTTP "+r.status));return p}
function Pill({children,color}){return h("span",{style:{border:"1px solid "+(color||C.b1),borderRadius:999,padding:"4px 9px",fontSize:12,color:color||C.s,background:C.l1}},children)}
function JobRow({job}){return h("div",{style:{display:"grid",gridTemplateColumns:"90px minmax(160px,1fr) 110px",gap:10,alignItems:"center",padding:"10px 12px",borderBottom:"1px solid "+C.b1,fontSize:13}},
  h("span",{style:{fontWeight:700}},job.kind||"job"),h("span",{title:job.label,style:{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},job.label||job.id),h("span",{style:{color:tone(job.status),textAlign:"right"}},job.detail||job.status))}
function WorkloadCard({item,selected,onSelect,onAction,busy}){const active=["starting","running","stopping"].includes(item.phase);return h("div",{role:"button",tabIndex:0,onClick:()=>onSelect(item.workloadId),onKeyDown:(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSelect(item.workloadId)}},style:{width:"100%",boxSizing:"border-box",textAlign:"left",cursor:"pointer",borderRadius:10,border:"1px solid "+(selected?C.brand:C.b1),background:selected?C.l2:C.l1,color:C.p,padding:"12px 14px",display:"grid",gap:7}},
  h("div",{style:{display:"flex",justifyContent:"space-between",gap:10}},h("strong",null,item.label),h("span",{style:{color:tone(item.phase),fontSize:12,fontWeight:700}},item.phase+" · "+item.health)),
  h("div",{style:{color:C.s,fontSize:12,wordBreak:"break-all"}},item.workloadId+" / "+(item.runId||"no-run")),
  h("div",{style:{display:"flex",gap:"6px 12px",flexWrap:"wrap",color:C.s,fontSize:12}},h("span",null,"PID: "+(item.pid||"—")),h("span",null,active?"启动: "+fmt(item.startedAt):"结束: "+fmt(item.endedAt)),item.legacy?h("span",null,"已从 proc_* 迁移"):null),
  item.error?h("div",{style:{color:C.err,fontSize:12}},item.error):null,
  h("div",{style:{display:"flex",gap:8,marginTop:2}},
    h("button",{type:"button",disabled:Boolean(busy),onClick:(e)=>{e.stopPropagation();onAction("stop",item.workloadId)},style:{padding:"5px 9px",border:"1px solid "+C.b2,borderRadius:7,background:"transparent",cursor:"pointer",color:C.warn,opacity:busy?.endsWith(item.workloadId)?.5:1}},"停止"),
    item.capabilities&&item.capabilities.restart?h("button",{type:"button",disabled:Boolean(busy),onClick:(e)=>{e.stopPropagation();onAction("restart",item.workloadId)},style:{padding:"5px 9px",border:"1px solid "+C.b2,borderRadius:7,background:"transparent",cursor:"pointer",color:C.brand,opacity:busy?.endsWith(item.workloadId)?.5:1}},"重启"):null))}
function Readiness({value}){if(!value)return h("div",{style:{color:C.s,fontSize:12}},"尚未执行 readiness");const e=value.evidence||{};const parts=[];if(e.logText!==null&&e.logText!==undefined)parts.push("日志文本="+(e.logText?"通过":"未通过"));if(e.tcpPort)parts.push("TCP="+e.tcpPort);if(e.httpUrl)parts.push("HTTP="+e.httpUrl+" → "+e.httpStatus);return h("div",{style:{display:"flex",gap:8,flexWrap:"wrap",fontSize:12,color:C.s}},h("strong",{style:{color:tone(value.checking?"checking":value.ready?"ready":"unhealthy")}},value.checking?"检查中":value.ready?"已就绪":"未就绪"),h("span",null,parts.join(" · ")||"无证据"),h("span",null,fmt(value.checkedAt)))}
function apply(ctx){
  let updateRuntimeCount=()=>{};
  const workloadCounts=new Map();
  function RuntimeCenter({useSessions,sessionId}){
    const cwd=useSessions((state)=>state.byId[sessionId]&&state.byId[sessionId].cwd);
    const jobs=useSessions((state)=>state.jobsBySession[sessionId])||[];
    const [snapshot,setSnapshot]=React.useState(null),[error,setError]=React.useState(""),[selected,setSelected]=React.useState(""),[logs,setLogs]=React.useState(null),[revision,setRevision]=React.useState(0),[busy,setBusy]=React.useState(""),[confirm,setConfirm]=React.useState("");
    const logRef=React.useRef(null);
    React.useEffect(()=>{if(!cwd)return undefined;let live=true;const load=()=>get("list",cwd,sessionId).then((p)=>{if(!live)return;setSnapshot({...p.value,observedAt:p.observedAt});setError("");const rows=p.value.workloads||[];setSelected((current)=>current||(rows[0]&&rows[0].workloadId)||"")}).catch((e)=>{if(live)setError(e instanceof Error?e.message:String(e))});load();const dispose=ctx.interval(load,3000);return()=>{live=false;dispose()}},[cwd,sessionId,revision]);
    React.useEffect(()=>{if(!cwd||!selected){setLogs(null);return undefined}let live=true;const load=()=>get("logs",cwd,sessionId,selected).then((p)=>{if(live)setLogs({...p.value,observedAt:p.observedAt,error:""})}).catch((e)=>{if(live)setLogs({workloadId:selected,log:"",error:e instanceof Error?e.message:String(e)})});load();const dispose=ctx.interval(load,3000);return()=>{live=false;dispose()}},[cwd,sessionId,selected,revision]);
    React.useEffect(()=>{const node=logRef.current;if(node)node.scrollTop=node.scrollHeight},[logs]);
    const actionLabel=(op)=>op==="stopAll"?"全部关闭":op==="stop"?"停止":"重启";
    const action=async(op,workloadId)=>{if(busy)return;const key=op+":"+(workloadId||"all");if(confirm!==key){setConfirm(key);setError("再次点击同一“"+actionLabel(op)+"”按钮以确认操作。");return}setConfirm("");setBusy(key);setError("");try{await post(op,cwd,sessionId,workloadId);setRevision((v)=>v+1)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy("")}};
    const rows=snapshot?snapshot.workloads||[]:[];const active=rows.filter((x)=>["starting","running","stopping"].includes(x.phase)).length;const liveJobs=jobs.filter((x)=>x.status==="running"||x.status==="stopping").length;const workloadActive=snapshot?active:(workloadCounts.get(sessionId)||0);const runtimeCount=liveJobs+workloadActive;const current=rows.find((x)=>x.workloadId===selected)||null;
    React.useEffect(()=>{if(snapshot)workloadCounts.set(sessionId,active);updateRuntimeCount(runtimeCount)},[sessionId,runtimeCount,Boolean(snapshot)]);
    if(!cwd)return h("div",{style:{padding:24,color:C.s}},"当前对话没有工作目录，无法建立 Workspace Runtime。");
    return h("div",{style:{height:"100%",overflow:"auto",background:C.bg,color:C.p,padding:20,boxSizing:"border-box"}},
      h("div",{style:{display:"flex",justifyContent:"space-between",gap:16,alignItems:"flex-start",marginBottom:16}},h("div",null,h("h2",{style:{margin:"0 0 6px",fontSize:20}},"DSH 运行中心"),h("div",{style:{color:C.s,fontSize:13,wordBreak:"break-all"}},cwd),h("div",{style:{color:C.s,fontSize:12,marginTop:5}},"会话 Job 随当前对话结束；Workspace Workload 在同一工作目录的所有对话间共享并持久化。")),h("button",{type:"button",onClick:()=>setRevision((v)=>v+1),style:{border:"1px solid "+C.b2,background:C.l1,color:C.p,borderRadius:8,padding:"8px 12px",cursor:"pointer"}},"立即刷新")),
      h("div",{style:{display:"flex",gap:10,flexWrap:"wrap",marginBottom:16}},h(Pill,null,"会话任务 "+jobs.length),h(Pill,{color:active?C.ok:C.s},"工作区服务 "+active+" / "+rows.length),snapshot?h("span",{style:{fontSize:12,color:C.s,padding:"5px 0"}},"同步于 "+fmt(snapshot.observedAt)):null),
      error?h("div",{style:{color:C.err,border:"1px solid "+C.err,borderRadius:8,padding:10,marginBottom:14}},error):null,
      h("section",{style:{background:C.l1,border:"1px solid "+C.b1,borderRadius:12,overflow:"hidden",marginBottom:16}},h("div",{style:{padding:"12px 14px",borderBottom:"1px solid "+C.b1,display:"flex",justifyContent:"space-between"}},h("strong",null,"会话后台任务"),h("span",{style:{color:C.s,fontSize:12}},"Session-owned")),jobs.length?jobs.map((job)=>h(JobRow,{key:job.id,job})):h("div",{style:{padding:18,color:C.s}},"当前会话没有后台任务。后台任务的完整输出和取消操作仍由 DSH Job 控制器负责。")),
      h("section",null,h("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"0 0 10px"}},h("div",{style:{display:"flex",alignItems:"center",gap:10}},h("strong",null,"工作区长期服务"),h("span",{style:{color:C.s,fontSize:12}},"Workspace-owned · local-process")),active>0?h("button",{type:"button",disabled:Boolean(busy),onClick:()=>action("stopAll"),style:{padding:"6px 12px",border:"1px solid "+C.err,borderRadius:8,background:"transparent",cursor:"pointer",color:C.err,fontSize:13,opacity:busy?0.6:1}},"全部关闭"):null),
        !snapshot&&!error?h("div",{style:{color:C.s}},"正在读取持久 Workload…"):null,
        snapshot&&!rows.length?h("div",{style:{background:C.l1,border:"1px dashed "+C.b2,borderRadius:12,padding:28,color:C.s}},"当前工作区没有长期 Workload。使用 workload_start 后，同 cwd 对话会在 3 秒内同步。"):null,
        rows.length?h("div",{style:{display:"grid",gridTemplateColumns:"minmax(290px,380px) minmax(420px,1fr)",gap:16,alignItems:"start"}},h("div",{style:{display:"grid",gap:10}},rows.map((item)=>h(WorkloadCard,{key:item.workloadId,item,selected:item.workloadId===selected,onSelect:setSelected,onAction:action,busy}))),h("div",{style:{minWidth:0,background:C.l1,border:"1px solid "+C.b1,borderRadius:12,padding:14,position:"sticky",top:0}},h("div",{style:{display:"flex",justifyContent:"space-between",gap:10,marginBottom:10}},h("strong",null,current?current.label:"Workload 日志"),h("span",{style:{color:C.s,fontSize:12}},logs&&logs.observedAt?fmt(logs.observedAt):"")),current?h(Readiness,{value:current.readiness}):null,h("pre",{ref:logRef,style:{margin:"12px 0 0",minHeight:260,maxHeight:"calc(100vh - 360px)",overflow:"auto",whiteSpace:"pre-wrap",wordBreak:"break-word",background:C.l2,border:"1px solid "+C.b1,borderRadius:8,padding:12,color:C.p,fontSize:12,lineHeight:1.55}},!selected?"请选择 Workload。":logs&&logs.error?"日志读取失败："+logs.error:logs?logs.log||"暂无日志输出。":"正在读取日志…"),logs&&logs.truncated?h("div",{style:{color:C.s,fontSize:12,marginTop:8}},"仅显示末尾 32 KiB，凭据形态已遮蔽。"):null)):null));
  }
  ctx.slots.inject("conversation.view",()=>{
    let count=0,disposeView=()=>{};
    const register=(next)=>{disposeView();count=next;disposeView=ctx.slots.register({name:"conversation.view",id:"runtime-center",order:30,label:"运行中心("+count+")"},RuntimeCenter)};
    updateRuntimeCount=(next)=>{if(next!==count)register(next)};
    register(0);
    return()=>{updateRuntimeCount=()=>{};disposeView()};
  });
}
module.exports={inject,apply};
return module.exports; } });
