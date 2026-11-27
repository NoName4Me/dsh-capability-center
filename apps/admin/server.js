import { createServer } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveBundle, resolveSkill } from '../../packages/publisher/index.js'
import { registryUrl, sha256 } from '../../packages/protocol/index.js'
import { Store } from './store.js'
import { CoreSource } from './core-source.js'

const hash=x=>createHash('sha256').update(x).digest()
function json(res,status,data,headers={}){
  const bytes=Buffer.from(JSON.stringify(data))
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':bytes.length,'x-content-type-options':'nosniff',...headers});res.end(bytes)
}
async function readJson(req){
  if(!String(req.headers['content-type']).startsWith('application/json'))throw new Error('需要 JSON 请求')
  let size=0;const chunks=[]
  for await(const chunk of req){size+=chunk.length;if(size>64*1024)throw new Error('请求过大');chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString())
}
export function createAdmin({store,registry,token,registryToken,raw,rawToken,resolve=resolveBundle,resolveRaw=resolveSkill,coreSource=new CoreSource(null,{privateKey:store.privateKey})}){
  const base=registryUrl(registry)
  if(typeof token!=='string'||token.length<24)throw new Error('DSH_ADMIN_TOKEN 至少 24 字符')
  const authorized=req=>timingSafeEqual(hash(String(req.headers.authorization??'')),hash('Bearer '+token))
  return createServer(async(req,res)=>{
    const path=new URL(req.url,'http://local.invalid').pathname
    try{
      if(req.method==='GET'&&path==='/'){
        const content=readFileSync(new URL('./index.html',import.meta.url))
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(content);return
      }
      if(req.method==='GET'&&['/app.js','/style.css'].includes(path)){
        const content=readFileSync(new URL('.'+path,import.meta.url));res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','x-content-type-options':'nosniff'});res.end(content);return
      }
      if(req.method==='GET'&&path==='/catalog.json'){
        const catalog=store.catalog(), bytes=Buffer.from(JSON.stringify(catalog)), etag='"'+sha256(bytes)+'"'
        if(req.headers['if-none-match']===etag){res.writeHead(304,{etag,'cache-control':'no-cache'});res.end();return}
        json(res,200,catalog,{etag,'cache-control':'no-cache'});return
      }
      if(req.method==='GET'&&path==='/core-release-index.json'){json(res,200,await coreSource.index(),{'cache-control':'no-cache'});return}
      if(req.method==='GET'&&/^\/core\/capability-center-core-[0-9A-Za-z.-]+\.zip$/.test(path)){
        const bytes=await coreSource.artifact(path)
        if(!bytes){json(res,404,{error:'核心制品不存在'});return}
        res.writeHead(200,{'content-type':'application/zip','content-length':bytes.length,'cache-control':'no-store'});res.end(bytes);return
      }
      const artifact=/^\/packages\/([a-f0-9]{64})\.(tgz|zip|bin)$/.exec(path)
      if(req.method==='GET'&&artifact){
        const bytes=store.artifact(artifact[1],artifact[2]);if(!bytes){json(res,404,{error:'制品不存在'});return}
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);return
      }
      if(!path.startsWith('/api/admin/')){json(res,404,{error:'不存在'});return}
      if(!authorized(req)){json(res,401,{error:'需要管理员凭据'});return}
      if(req.method==='GET'&&path==='/api/admin/versions'){json(res,200,{versions:store.list(),audit:store.auditList()});return}
      if(req.method==='POST'&&path==='/api/admin/import'){
        const body=await readJson(req)
        const result=await resolve({registry:base.href,packageName:body.packageName,version:body.version,overlay:body.overlay,token:registryToken,raw,rawToken})
        json(res,201,store.stage(result));return
      }
      if(req.method==='POST'&&path==='/api/admin/import-raw'){
        const body=await readJson(req);json(res,201,store.stage(await resolveRaw({raw,rawToken,descriptorPath:body.descriptorPath})));return
      }
      if(req.method==='POST'&&path==='/api/admin/change'){
        const body=await readJson(req);json(res,200,store.change(body.id,body.version,body.action));return
      }
      json(res,405,{error:'不支持的操作'})
    }catch(error){if(!res.headersSent)json(res,400,{error:String(error?.message??'操作失败').slice(0,500)});else res.destroy()}
  })
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const privateKey=process.env.DSH_CATALOG_SIGNING_KEY_FILE?readFileSync(process.env.DSH_CATALOG_SIGNING_KEY_FILE):undefined
  if(!privateKey&&process.env.DSH_ALLOW_UNSIGNED_CATALOG!=='1')throw new Error('配置目录签名密钥，或仅在联调时显式允许未签名目录')
  const store=new Store(process.env.DSH_ADMIN_DATA??'./.admin-data',{privateKey})
  const server=createAdmin({store,registry:process.env.DSH_NPM_REGISTRY,token:process.env.DSH_ADMIN_TOKEN,registryToken:process.env.DSH_NPM_READ_TOKEN,raw:process.env.DSH_RAW_BASE,rawToken:process.env.DSH_RAW_READ_TOKEN,coreSource:new CoreSource(process.env.DSH_RAW_BASE,{privateKey,token:process.env.DSH_RAW_READ_TOKEN})})
  server.listen(Number(process.env.DSH_ADMIN_PORT??8780),process.env.DSH_ADMIN_HOST??'127.0.0.1',()=>console.log('能力发布后台已启动'))
}
