import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { validateRuntime } from '../apps/dsh-plugin/core/lib/manifest.js'
import { prepareRuntime, verifyRuntime, removeRuntime } from '../apps/dsh-plugin/core/lib/runtime.js'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
test('独立资源准备、校验、拥有者保护及清理',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-runtime-')),body=Buffer.from('asset')
 const item={id:'fixture',version:'1.0.0',runtime:validateRuntime({assets:[{name:'model',path:'models/model.bin',sha256:sha(body),bytes:body.length,format:'file'}]},'http://local.invalid/')}
 let intent
 try{
 const record=await prepareRuntime({root,item,operationId:'fixture-op',http:{readBoundedUrl:async()=>({body})},beforeMutation:async v=>{intent=v}})
 assert.equal((await readFile(record.assets.model)).toString(),'asset')
 await verifyRuntime(root,item,record)
 await assert.rejects(()=>removeRuntime(root,{...intent,operationId:'other'}),/所有权/)
 await removeRuntime(root,intent)
 await assert.rejects(()=>readFile(record.assets.model))
 assert.throws(()=>validateRuntime({python:{requirements:[{name:'bad/url',version:'1.0',hashes:[sha(body)]}]}},'http://local.invalid/'))
 }finally{await rm(root,{recursive:true,force:true})}
})
