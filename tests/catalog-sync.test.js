import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogSync } from '../src/engine/lib/catalog-sync.js'

const item=id=>({id,type:'plugin',name:id,version:'1.0.0',description:'测试',artifact:{path:'packages/a.tgz',bytes:1,sha256:'a'.repeat(64)},install:{packageName:id},checks:[{type:'plugin-bundle'}],usage:{steps:['安装','使用'],inputs:'输入',output:'结果',example:'示例'},trial:{prompt:'试用'}})
test('首次基线、上新、304、失败缓存、持久已读、拒绝降级',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-sync-'));let revision=1,items=[item('a')],fail=false,notModified=false
 const http={readBoundedUrl:async()=>{if(fail)throw Error('offline');return notModified?{status:304,headers:{etag:'tag'}}:{status:200,headers:{etag:'tag'},body:Buffer.from(JSON.stringify({schemaVersion:2,revision,items}))}}}
 const base='http://127.0.0.1:8765/'
 try{
 const sync=new CatalogSync(root,http)
 await sync.refresh(base,{force:true});assert.deepEqual((await sync.snapshot(base)).unread,[])
 revision=2;items.push(item('b'));await sync.refresh(base,{force:true});assert.deepEqual((await sync.snapshot(base)).unread,['b'])
 notModified=true;await sync.refresh(base,{force:true});assert.deepEqual((await sync.snapshot(base)).unread,['b'])
 await sync.markRead(base,['b']);assert.deepEqual((await sync.snapshot(base)).unread,[])
 const restarted=new CatalogSync(root,http);assert.deepEqual((await restarted.snapshot(base)).unread,[])
 fail=true;await assert.rejects(()=>restarted.refresh(base,{force:true}));assert.equal((await restarted.snapshot(base)).catalog.items.length,2)
 fail=false;notModified=false;revision=1;await assert.rejects(()=>restarted.refresh(base,{force:true}),/旧目录/)
 }finally{await rm(root,{recursive:true,force:true})}
})
