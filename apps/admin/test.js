import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'
import { createAdmin } from './server.js'
import { pluginDescriptor, sha256 } from '../../packages/protocol/index.js'

test('导入、发布、目录、下架、撤回、权限及不可变版本',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsh-admin-'))
  const store=new Store(root), token='test-admin-token-at-least-24-characters'
  const body=Buffer.from('fixture'), digest=sha256(body)
  const item=pluginDescriptor({name:'fixture-plugin',version:'1.0.0',description:'fixture',engines:{dsh:'>=0.2.1-rc.2'},dsh:{bundle:{patch:'./cordis.patch.yml'}}})
  item.artifact={path:'packages/'+digest+'.tgz',sha256:digest,bytes:body.length}
  const server=createAdmin({store,registry:'http://127.0.0.1:9999/npm/',token,resolve:async()=>({item,body})})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const base='http://127.0.0.1:'+server.address().port
  const post=(path,data,auth=true)=>fetch(base+'/api/admin/'+path,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)})
  try{
    assert.equal((await post('import',{},false)).status,401)
    assert.equal((await post('import',{})).status,201)
    assert.equal((await fetch(base+'/'+item.artifact.path)).status,404)
    const change=action=>post('change',{id:item.id,version:item.version,action})
    assert.equal((await change('publish')).status,200)
    const catalog=await fetch(base+'/catalog.json')
    assert.equal((await catalog.json()).items[0].id,item.id)
    assert.equal((await fetch(base+'/catalog.json',{headers:{'if-none-match':catalog.headers.get('etag')}})).status,304)
    assert.equal(await (await fetch(base+'/'+item.artifact.path)).text(),'fixture')
    assert.throws(()=>store.stage({item:{...item,name:'changed'},body}))
    assert.equal((await change('delist')).status,200)
    assert.equal((await fetch(base+'/catalog.json').then(x=>x.json())).items.length,0)
    assert.equal((await fetch(base+'/'+item.artifact.path)).status,200)
    assert.equal((await change('revoke')).status,200)
    assert.equal((await fetch(base+'/'+item.artifact.path)).status,404)
    assert.equal((await change('publish')).status,400)
  }finally{await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true})}
})

test('真实 npm pack 的制品读取、摘要和包元数据验证',async()=>{
 const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs')
 const {execFileSync}=await import('node:child_process')
 const {createHash}=await import('node:crypto')
 const {resolveBundle}=await import('../../packages/publisher/index.js')
 const {startFileServer}=await import('../../tests/helpers.js')
 const root=mkdtempSync(join(tmpdir(),'dsh-npm-pack-'))
 const manifest={name:'fixture-bundle',version:'1.0.0',description:'fixture',engines:{dsh:'>=0.2.1-rc.2'},dsh:{bundle:{patch:'./cordis.patch.yml'}},capability:{title:'测试能力'}}
 const pkg=join(root,'pkg');mkdirSync(pkg);writeFileSync(join(pkg,'package.json'),JSON.stringify(manifest));writeFileSync(join(pkg,'cordis.patch.yml'),'plugins: []\n')
 try{
 const [result]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:pkg,encoding:'utf8'}))
 const body=readFileSync(join(root,result.filename)),integrity='sha512-'+createHash('sha512').update(body).digest('base64')
 const fixture=await startFileServer()
 try{
 const base=fixture.base+'npm/'
 fixture.routes.set('/npm/fixture-bundle',{versions:{'1.0.0':{...manifest,dist:{tarball:base+'fixture-bundle/-/'+result.filename,integrity}}}})
 fixture.routes.set('/npm/fixture-bundle/-/'+result.filename,body)
 const resolved=await resolveBundle({registry:base,packageName:manifest.name,version:manifest.version})
 assert.equal(resolved.item.name,'测试能力')
 assert.equal(resolved.item.artifact.sha256,sha256(body))
 fixture.routes.set('/npm/fixture-bundle/-/'+result.filename,Buffer.from('tampered'))
 await assert.rejects(()=>resolveBundle({registry:base,packageName:manifest.name,version:manifest.version}),/integrity/)
 }finally{await fixture.close()}
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('Raw Skill 导入包含受管资源、发布和撤回', {skip:!process.env.CAPABILITY_CENTER_TEST_PYTHON},async()=>{
 const {readFileSync}=await import('node:fs')
 const {resolveSkill}=await import('../../packages/publisher/index.js')
 const {createSkillArchive,startFileServer,skillItem}=await import('../../tests/helpers.js')
 const root=mkdtempSync(join(tmpdir(),'dsh-raw-skill-'))
 const store=new Store(join(root,'admin'))
 const fixture=await startFileServer()
 try{
 const archive=await createSkillArchive(join(root,'fixture.zip'),'raw-fixture','1.0.0')
 const body=readFileSync(archive),asset=Buffer.from('test asset')
 const item=skillItem('raw-fixture','1.0.0','skill.zip',body)
 item.runtime={assets:[{name:'model',path:'model.bin',sha256:sha256(asset),bytes:asset.length,format:'file'}]}
 fixture.routes.set('/raw/capability.json',item);fixture.routes.set('/raw/skill.zip',body);fixture.routes.set('/raw/model.bin',asset)
 const draft=await resolveSkill({raw:fixture.base+'raw/',descriptorPath:'capability.json'})
 store.stage(draft)
 assert.equal(store.artifact(sha256(body),'zip'),undefined)
 store.change(item.id,item.version,'publish')
 assert.deepEqual(store.artifact(sha256(body),'zip'),body)
 assert.deepEqual(store.artifact(sha256(asset),'bin'),asset)
 assert.equal(store.catalog().items[0].runtime.assets[0].path,'packages/'+sha256(asset)+'.bin')
 store.change(item.id,item.version,'revoke')
 assert.equal(store.artifact(sha256(asset),'bin'),undefined)
 }finally{store.close();await fixture.close();rmSync(root,{recursive:true,force:true})}
})
