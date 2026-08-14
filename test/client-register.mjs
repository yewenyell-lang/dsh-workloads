import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here=path.dirname(fileURLToPath(import.meta.url))
let definition=null
const sandbox={window:{__ModuleLoader__:{load(value){definition=value}}},console}
vm.runInNewContext(fs.readFileSync(path.join(here,'..','lib','client.js'),'utf8'),sandbox,{filename:'client.js'})
if(!definition||definition.id!=='dsh-workloads-local-ui1')throw new Error('module loader registration missing')
const plugin=definition.factory((name)=>{if(name==='react')return{createElement(){}};throw new Error('unexpected require '+name)})
let registration=null
const ctx={slots:{inject(name,callback){if(name!=='conversation.view')throw new Error('unexpected slot');return callback()},register(options,component){registration={options,component};return()=>{}}}}
plugin.apply(ctx)
if(registration?.options?.id!=='runtime-center'||registration.options.label!=='运行中心'||typeof registration.component!=='function')throw new Error('runtime center slot registration failed')
console.log(JSON.stringify({moduleId:definition.id,slot:registration.options.name,id:registration.options.id,label:registration.options.label}))
