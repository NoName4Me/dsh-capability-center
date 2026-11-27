import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonical, sha256, signedCatalog, SHA256 } from '../../packages/protocol/index.js'
import { validateCatalog } from '../../src/engine/lib/manifest.js'
import { validateGraph } from '../../src/engine/lib/graph.js'
import { compareVersions } from '../../src/engine/lib/semver.js'

export class Store {
  constructor(root,{privateKey}={}) {
    this.root=root; this.privateKey=privateKey
    mkdirSync(join(root,'packages'),{recursive:true})
    this.db=new DatabaseSync(join(root,'catalog.sqlite'))
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS versions(id TEXT, version TEXT, item TEXT NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL, first_published TEXT, published TEXT, PRIMARY KEY(id,version)); CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT OR IGNORE INTO meta VALUES('revision',0);")
  }
  close(){this.db.close()}
  transaction(fn){
    this.db.exec('BEGIN IMMEDIATE')
    try{const out=fn();this.db.exec('COMMIT');return out}catch(e){this.db.exec('ROLLBACK');throw e}
  }
  audit(action,id,version){this.db.prepare('INSERT INTO audit(at,action,id,version) VALUES(?,?,?,?)').run(new Date().toISOString(),action,id,version)}
  stage({item,body}){
    validateCatalog({schemaVersion:2,items:[item]},'https://catalog.invalid/')
    if(item.type!=='plugin'||item.artifact.sha256!==sha256(body)||item.artifact.bytes!==body.length) throw new Error('制品摘要错误')
    const path=join(this.root,item.artifact.path)
    if(item.artifact.path!=='packages/'+item.artifact.sha256+'.tgz') throw new Error('非法制品路径')
    if(!existsSync(path)) {try{writeFileSync(path,body,{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}}
    if(sha256(readFileSync(path))!==item.artifact.sha256) throw new Error('已有制品摘要冲突')
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM versions WHERE id=? AND version=?').get(item.id,item.version)
      if(previous){
        if(canonical(JSON.parse(previous.item))!==canonical(item))throw new Error('已登记版本不可覆盖')
        return {id:item.id,version:item.version,state:previous.state}
      }
      const known=this.db.prepare('SELECT item FROM versions WHERE id=? LIMIT 1').get(item.id)
      if(known&&JSON.parse(known.item).install.packageName!==item.install.packageName)throw new Error('能力 ID 已绑定其他包')
      const all=this.db.prepare('SELECT item FROM versions WHERE id<>?').all(item.id)
      if(all.some(row=>JSON.parse(row.item).install.packageName===item.install.packageName))throw new Error('npm 包已绑定其他能力')
      this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,NULL,NULL)').run(item.id,item.version,JSON.stringify(item),'draft',new Date().toISOString())
      this.audit('stage',item.id,item.version)
      return {id:item.id,version:item.version,state:'draft'}
    })
  }
  change(id,version,action){
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM versions WHERE id=? AND version=?').get(id,version)
      if(!row)throw new Error('未知版本')
      const allowed={publish:['draft','delisted'],delist:['published'],revoke:['published','delisted']}[action]
      if(!allowed?.includes(row.state))throw new Error('非法发布状态转换')
      const state={publish:'published',delist:'delisted',revoke:'revoked'}[action]
      const now=new Date().toISOString()
      const first=this.db.prepare('SELECT MIN(first_published) AS first FROM versions WHERE id=?').get(id).first
      if(action==='publish'){
        const item=JSON.parse(row.item)
        if(sha256(readFileSync(join(this.root,item.artifact.path)))!==item.artifact.sha256)throw new Error('制品丢失或损坏')
        this.db.prepare('UPDATE versions SET state=?,first_published=?,published=? WHERE id=? AND version=?').run(state,first??now,now,id,version)
      }else this.db.prepare('UPDATE versions SET state=? WHERE id=? AND version=?').run(state,id,version)
      this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run()
      this.catalog() // Validate resulting public snapshot before transaction commit.
      this.audit(action,id,version)
      return {id,version,state}
    })
  }
  list(){return this.db.prepare('SELECT * FROM versions ORDER BY created DESC').all().map(row=>({...row,item:JSON.parse(row.item)}))}
  auditList(){return this.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT 200').all()}
  catalog(){
    const rows=this.db.prepare("SELECT * FROM versions WHERE state='published'").all()
    const all=rows.map(row=>({...JSON.parse(row.item),firstPublishedAt:row.first_published,publishedAt:row.published}))
    const latest=new Map()
    for(const item of all)if(!latest.has(item.id)||compareVersions(item.version,latest.get(item.id).version)>0)latest.set(item.id,item)
    const items=[...latest.values()].sort((a,b)=>a.id.localeCompare(b.id))
    validateGraph(validateCatalog({schemaVersion:2,items},'https://catalog.invalid/'))
    return signedCatalog({schemaVersion:2,name:'内网能力目录',generatedFor:'dsh-v0.2.1-rc.2',revision:this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value,items,versions:all.sort((a,b)=>a.id.localeCompare(b.id)||compareVersions(b.version,a.version)),revocations:this.db.prepare("SELECT id,version FROM versions WHERE state='revoked' ORDER BY id,version").all()},this.privateKey)
  }
  artifact(digest){
    if(!SHA256.test(digest))return undefined
    const rows=this.db.prepare('SELECT item,state FROM versions WHERE published IS NOT NULL').all()
    if(!rows.some(r=>r.state!=='revoked'&&JSON.parse(r.item).artifact.sha256===digest))return undefined
    const bytes=readFileSync(join(this.root,'packages',digest+'.tgz'))
    if(sha256(bytes)!==digest)throw new Error('制品摘要错误')
    return bytes
  }
}
