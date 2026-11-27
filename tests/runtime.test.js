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

test('独立 Python 环境从内网 simple 索引安装真实 wheel', {skip:!process.env.CAPABILITY_CENTER_TEST_PYTHON}, async()=>{
 const {startFileServer}=await import('./helpers.js')
 const {execFile}=await import('node:child_process')
 const {promisify}=await import('node:util')
 const run=promisify(execFile)
 const python=process.env.CAPABILITY_CENTER_TEST_PYTHON
 const version=(await run(python,['-c','import sys; print("%d.%d.%d" % sys.version_info[:3])'])).stdout.trim()
 const root=await mkdtemp(join(tmpdir(),'dsh-python-'))
 const name='pypdf-7.1.0-py3-none-any.whl'
 const wheel=await readFile(new URL('../vendor/'+name,import.meta.url))
 const digest=sha(wheel)
 const server=await startFileServer(new Map([['/simple/pypdf/',Buffer.from('<a href="/files/'+name+'#sha256='+digest+'">'+name+'</a>')],['/files/'+name,wheel]]))
 // A PyPI simple page must be returned as HTML.
 server.server.prependListener('request',(req,res)=>{if(req.url==='/simple/pypdf/'){const original=res.setHeader.bind(res);res.setHeader=(key,value)=>original(key,key.toLowerCase()==='content-type'?'text/html':value)}})
 const before=process.env.DSH_PYPI_INDEX
 process.env.DSH_PYPI_INDEX=server.base+'simple/'
 const item={id:'python-fixture',version:'1.0.0',runtime:validateRuntime({python:{requirements:[{name:'pypdf',version:'7.1.0',hashes:[digest]}]}},server.base)}
 let intent
 try{
 const record=await prepareRuntime({root,item,operationId:'fixture-python',http:{},basePython:{python,version},beforeMutation:async v=>{intent=v}})
 assert.notEqual(record.python,python)
 assert.equal((await run(record.python,['-I','-c','import pypdf; print(pypdf.__version__)'])).stdout.trim(),'7.1.0')
 await verifyRuntime(root,item,record)
 await removeRuntime(root,intent)
 await assert.rejects(()=>readFile(record.directory+'/runtime.json'))
 }finally{if(before===undefined)delete process.env.DSH_PYPI_INDEX;else process.env.DSH_PYPI_INDEX=before;await server.close();await rm(root,{recursive:true,force:true})}
})
