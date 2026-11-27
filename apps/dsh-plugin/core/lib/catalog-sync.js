import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJson, atomicWriteJson } from './atomic.js'
import { normalizeServerUrl, validateCatalog, compatibilityError } from './manifest.js'
import { validateGraph } from './graph.js'
import { canonical, trustedPayload, assertTrustedSource } from './signature.js'

const FRESH=15*60*1000
const visible=item=>!item.hidden && !compatibilityError({...item,compatibility:{...item.compatibility,python:undefined}})
const key=base=>createHash('sha256').update(base).digest('hex')
export class CatalogSync {
  constructor(root,http,{now=Date.now}={}) {
    this.root=join(root,'catalog-cache');this.http=http;this.now=now;this.entries=new Map()
    this.source='';this.selection=Promise.resolve();this.disposed=false
  }
  async initialize(){
    const config=await readJson(join(this.root,'source.json'),{})
    // Configuration from the installer is a default only; an explicit offline choice wins.
    this.source=config.source===''?'':process.env.DSH_CATALOG_URL?normalizeServerUrl(process.env.DSH_CATALOG_URL):config.source??''
  }
  async select(value){
    const source=value?normalizeServerUrl(value):''
    if(source)assertTrustedSource(source)
    if(this.source===source)return
    this.source=source
    this.selection=this.selection.catch(()=>{}).then(()=>atomicWriteJson(join(this.root,'source.json'),{source}))
    await this.selection
  }
  async entry(value){
    const base=normalizeServerUrl(value);assertTrustedSource(base)
    if(!this.entries.has(base)) {
      const pending=(async()=>{
        const path=join(this.root,key(base)+'.json')
        const persisted=await readJson(path,null)
        const entry={base,path,record:persisted,catalog:undefined,pending:null,failed:false,retryAt:0,failures:0}
        if(persisted){
          const payload=await trustedPayload(persisted.raw)
          entry.catalog=validateCatalog(payload,base)
          validateGraph(entry.catalog)
        }
        return entry
      })()
      this.entries.set(base,pending)
      pending.catch(()=>this.entries.delete(base))
    }
    return await this.entries.get(base)
  }
  async refresh(value,{force=false}={}){
    const e=await this.entry(value)
    if(e.pending)return await e.pending
    if(!force && e.failed && this.now()<e.retryAt)throw new Error('目录同步失败，等待重试。')
    if(!force && !e.failed && e.catalog && this.now()-e.record.checkedAt<FRESH)return e.catalog
    e.pending=this.fetch(e).finally(()=>{e.pending=null})
    return await e.pending
  }
  async fetch(e){
    try{
      const response=await this.http.readBoundedUrl(new URL('catalog.json',e.base),{
        timeoutMs:15000,maxBytes:1024*1024,acceptNotModified:true,
        headers:{accept:'application/json',...(e.record?.etag?{'if-none-match':e.record.etag}:{})}
      })
      const raw=response.status===304?e.record?.raw:JSON.parse(response.body.toString('utf8'))
      if(!raw)throw new Error('304 响应没有本地目录。')
      const payload=await trustedPayload(raw)
      const catalog=validateCatalog(payload,e.base);validateGraph(catalog)
      if(e.catalog?.revision!==undefined && (catalog.revision===undefined || catalog.revision<e.catalog.revision ||
        (catalog.revision===e.catalog.revision && canonical(raw)!==canonical(e.record.raw))))throw new Error('拒绝旧目录或同修订号内容变化。')
      const current=catalog.items.filter(visible).map(x=>x.id)
      const known=new Set(e.record?.seen??current)
      const unread=new Set(e.record?.unread??[])
      if(e.record)for(const id of current)if(!known.has(id))unread.add(id)
      for(const id of current)known.add(id)
      const record={raw,etag:response.headers?.etag??(response.status===304?e.record?.etag:null)??null,checkedAt:this.now(),seen:[...known],unread:[...unread].filter(id=>current.includes(id))}
      await atomicWriteJson(e.path,record)
      e.record=record;e.catalog=catalog;e.failed=false;e.failures=0;e.retryAt=0
      return catalog
    }catch(error){
      e.failed=true;e.failures+=1;e.retryAt=this.now()+Math.min(FRESH,30000*2**Math.min(e.failures-1,5))
      throw error
    }
  }
  async snapshot(value){
    if(!value)return {}
    try{
      const e=await this.entry(value)
      return {catalog:e.catalog,unread:e.record?.unread??[],lastSyncedAt:e.record?.checkedAt??null,stale:e.failed}
    }catch{return {}}
  }
  async markRead(value,ids){
    if(!value)return
    const e=await this.entry(value)
    if(e.pending)await e.pending.catch(()=>{})
    if(!e.record)return
    // Serialize local writes with subsequent fetches using the same pending slot.
    e.pending=(async()=>{
      const selected=new Set(ids)
      const record={...e.record,unread:e.record.unread.filter(id=>!selected.has(id))}
      await atomicWriteJson(e.path,record);e.record=record
      return e.catalog
    })().finally(()=>{e.pending=null})
    await e.pending
  }
}
