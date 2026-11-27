import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from './store.js'
import { createAdmin } from './server.js'
import { pluginDescriptor, sha256 } from '../../packages/protocol/index.js'
import { makeCapabilityZip, zipFiles } from '../../packages/capability-sdk/pack.js'
import { readCapabilityUpload, validateBundle } from '../../packages/publisher/index.js'
const token='test-admin-token-at-least-24-characters'
const usage={steps:['安装','使用'],inputs:'输入',output:'输出',example:'示例'}
const desc=(id,version='1.0.0')=>({id,type:'skill',name:id,version,description:'测试技能',usage,trial:{prompt:'试用'},checks:[{type:'skill-discovery',name:id}],dependencies:[]})
const ref=(path,body)=>({path,sha256:sha256(body),bytes:body.length})
function fixture(id,version='1.0.0'){
 const body=zipFiles(new Map([[id+'/SKILL.md',Buffer.from('---\nname: '+id+'\ndescription: 测试\n---\n正文')]]))
 const item={...desc(id,version),artifact:ref('payload/skill.zip',body)}
 return {body,item,upload:makeCapabilityZip(item,new Map([[item.artifact.path,body]]))}
}
test('上传、发布、目录、下架、撤回、权限与组合引用',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-admin-')),store=new Store(root),server=createAdmin({store,token})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const base='http://127.0.0.1:'+server.address().port
 const upload=(bytes,auth=true)=>fetch(base+'/api/admin/upload',{method:'POST',headers:{'content-type':'application/zip',...(auth?{authorization:'Bearer '+token}:{})},body:bytes})
 const change=(id,version,action)=>fetch(base+'/api/admin/change',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({id,version,action})})
 try{
 const a=fixture('fixture')
 assert.equal((await upload(a.upload,false)).status,401)
 assert.equal((await upload(Buffer.from('bad'))).status,400)
 assert.equal((await upload(a.upload)).status,201)
 const path='/packages/'+sha256(a.body)+'.zip'
 assert.equal((await fetch(base+path)).status,404)
 assert.equal((await change('fixture','1.0.0','publish')).status,200)
 const catalog=await fetch(base+'/catalog.json')
 assert.equal((await catalog.json()).items[0].id,'fixture')
 assert.equal((await fetch(base+'/catalog.json',{headers:{'if-none-match':catalog.headers.get('etag')}})).status,304)
 assert.deepEqual(Buffer.from(await (await fetch(base+path)).arrayBuffer()),a.body)
 const conflict=makeCapabilityZip({...a.item,name:'different'},new Map([[a.item.artifact.path,a.body]]))
 assert.equal((await upload(conflict)).status,400)
 const combo={...desc('combo'),type:'composite',checks:[{type:'dependencies-ready'}],dependencies:[{id:'fixture',version:'1.0.0'}]}
 assert.equal((await upload(makeCapabilityZip(combo,new Map()))).status,201)
 assert.equal((await change('combo','1.0.0','publish')).status,200)
 assert.equal((await change('fixture','1.0.0','delist')).status,400)
 assert.equal((await upload(fixture('fixture','1.1.0').upload)).status,201)
 assert.equal((await change('fixture','1.1.0','publish')).status,200)
 assert.equal((await change('combo','1.0.0','delist')).status,200)
 assert.equal((await change('fixture','1.0.0','delist')).status,200)
 assert.equal((await change('fixture','1.0.0','revoke')).status,200)
 assert.equal((await fetch(base+path)).status,404)
 assert.equal((await change('fixture','1.0.0','publish')).status,400)
 assert.equal((await fetch(base+'/api/admin/import',{method:'POST',headers:{authorization:'Bearer '+token}})).status,405)
 }finally{await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true})}
})
test('真实 npm pack 必须包含 Bundle patch 与依赖闭包',()=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-npm-pack-')),pkg=join(root,'pkg')
 mkdirSync(pkg)
 const manifest={name:'fixture-bundle',version:'1.0.0',description:'fixture',engines:{dsh:'>=0.2.1-rc.2'},dsh:{bundle:{patch:'./cordis.patch.yml'}},capability:{title:'测试能力'}}
 const pack=()=>{
  writeFileSync(join(pkg,'package.json'),JSON.stringify(manifest));writeFileSync(join(pkg,'cordis.patch.yml'),'plugins: []\n')
  const [result]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:pkg,encoding:'utf8'}))
  return readFileSync(join(root,result.filename))
 }
 try{
 const body=pack(),item={...pluginDescriptor(manifest),artifact:ref('payload/plugin.tgz',body)}
 assert.equal(readCapabilityUpload(makeCapabilityZip(item,new Map([[item.artifact.path,body]]))).item.name,'测试能力')
 manifest.dependencies={absent:'1.0.0'};manifest.bundleDependencies=['absent']
 assert.throws(()=>validateBundle(pack(),item),/缺少 npm/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('wheelhouse 必须含全部锁定 wheel；拒绝多余文件和摘要篡改',()=>{
 const a=fixture('wheel-fixture'),wheelName='pypdf-7.1.0-py3-none-any.whl'
 const wheel=readFileSync(new URL('../../vendor/'+wheelName,import.meta.url))
 const house=zipFiles(new Map([[wheelName,wheel]]))
 const item={...a.item,runtime:{python:{requirements:[{name:'pypdf',version:'7.1.0',hashes:[sha256(wheel)]}]},assets:[{name:'wheelhouse',format:'zip',...ref('payload/wheelhouse.zip',house)}]}}
 const files=new Map([[a.item.artifact.path,a.body],['payload/wheelhouse.zip',house]])
 assert.equal(readCapabilityUpload(makeCapabilityZip(item,files)).blobs.length,1)
 assert.throws(()=>makeCapabilityZip({...item,runtime:{python:item.runtime.python}},files),/wheelhouse/)
 assert.throws(()=>makeCapabilityZip(item,new Map([...files,['payload/extra.bin',Buffer.from('x')]])),/未声明/)
 assert.throws(()=>makeCapabilityZip(item,new Map([[a.item.artifact.path,Buffer.from('x')],['payload/wheelhouse.zip',house]])),/摘要/)
})
test('核心也只通过上传与发布提供更新索引',()=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-core-upload-')),store=new Store(root)
 try{
 const m={name:'capability-center-core',version:'1.0.0',schemaVersion:1,protocolVersion:1,entry:'engine/index.js',compatibility:{dsh:'0.2.1-rc.2',os:['darwin'],arch:['arm64']}}
 const core=zipFiles(new Map([['manifest.json',Buffer.from(JSON.stringify(m))],['package.json',Buffer.from('{"type":"module"}')],['engine/index.js',Buffer.from('export {}')],['page/index.html',Buffer.from('<html></html>')]]))
 const item={id:m.name,version:m.version,type:'core',artifact:ref('payload/core.zip',core)}
 store.stage(readCapabilityUpload(makeCapabilityZip(item,new Map([[item.artifact.path,core]]))))
 assert.equal(store.coreIndex().releases.length,0)
 store.change(item.id,item.version,'publish')
 assert.equal(store.catalog().items.length,0);assert.equal(store.coreIndex().releases.length,1)
 assert.deepEqual(store.coreArtifact('/core/capability-center-core-1.0.0.zip'),core)
 store.change(item.id,item.version,'revoke');assert.equal(store.coreIndex().releases.length,0)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
