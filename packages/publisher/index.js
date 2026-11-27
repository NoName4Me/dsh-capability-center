import { gunzipSync } from 'node:zlib'
import { ID, VERSION, PACKAGE_NAME, sha256 } from '../protocol/index.js'
import { validateCatalog, validateRuntime, serializableItem, MAX_ARTIFACT_BYTES } from '../../apps/dsh-plugin/core/lib/manifest.js'
import { readZip, safeRelativePath } from '../../apps/dsh-plugin/core/lib/archive.js'
import { parseVersion } from '../../apps/dsh-plugin/core/lib/semver.js'

export const MAX_UPLOAD_BYTES=128*1024*1024
const ZIP_LIMITS={maxFileBytes:MAX_ARTIFACT_BYTES,maxUnpackedBytes:192*1024*1024,maxFiles:1024}
const base='https://upload.invalid/'
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)
const validVersion=v=>typeof v==='string'&&VERSION.test(v)&&parseVersion(v)!==null
function json(bytes){if(!bytes||bytes.length>1024*1024)throw Error('缺少或过大的 JSON 声明');return JSON.parse(bytes.toString('utf8'))}
function portable(path){return safeRelativePath(path)&&path.split('/').every(p=>!/[<>:"|?*]/.test(p)&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))}
function npmFiles(bytes){
 const tar=gunzipSync(bytes,{maxOutputLength:192*1024*1024}),files=new Map(),names=new Set()
 for(let offset=0;offset+512<=tar.length;){
  const header=tar.subarray(offset,offset+512);if(header.every(x=>x===0))break
  const field=(a,b)=>header.subarray(a,b).toString('utf8').split('\0')[0]
  const name=field(0,100),prefix=field(345,500),path=prefix?prefix+'/'+name:name,raw=field(124,136).trim()
  if(!/^[0-7]+$/.test(raw))throw Error('无效 tar 长度')
  const size=parseInt(raw,8),start=offset+512,type=field(156,157)
  if(!Number.isSafeInteger(size)||start+size>tar.length||!portable(path.replace(/\/$/,''))||!path.startsWith('package/')||!['','0','5'].includes(type))throw Error('不安全 npm 制品：'+path)
  if(type!=='5'){
   if(names.has(path.toLowerCase()))throw Error('npm 制品重复路径')
   names.add(path.toLowerCase());files.set(path,tar.subarray(start,start+size))
  }
  offset=start+Math.ceil(size/512)*512
 }
 return files
}
export function readNpmManifest(bytes){return json(npmFiles(bytes).get('package/package.json'))}
export function validateBundle(bytes,item){
 const files=npmFiles(bytes),manifest=json(files.get('package/package.json'))
 if(manifest.name!==item.install?.packageName||manifest.version!==item.version||!PACKAGE_NAME.test(manifest.name)||typeof manifest.engines?.dsh!=='string'||!manifest.engines.dsh||item.compatibility?.dsh!==manifest.engines.dsh)throw Error('Bundle 身份与能力声明不一致')
 const patches=Array.isArray(manifest.dsh?.bundle?.patch)?manifest.dsh.bundle.patch:[manifest.dsh?.bundle?.patch]
 if(!patches.length||patches.some(p=>typeof p!=='string'||!portable(p.replace(/^\.\//,''))||!files.has('package/'+p.replace(/^\.\//,''))))throw Error('缺少 DSH Bundle patch')
 const visited=new Set()
 function visit(dir,pkg,root=false){
  if(visited.has(dir))return;visited.add(dir)
  if(['preinstall','install','postinstall'].some(k=>pkg.scripts?.[k]))throw Error('离线包不得依赖安装脚本：'+pkg.name)
  const required={...pkg.dependencies,...pkg.optionalDependencies}
  if(root){const bundled=pkg.bundleDependencies??pkg.bundledDependencies??[];if(Object.keys(required).some(n=>bundled!==true&&(!Array.isArray(bundled)||!bundled.includes(n))))throw Error('根 npm 依赖必须声明 bundleDependencies')}
  for(const [name,range] of Object.entries(required)){
   if(!PACKAGE_NAME.test(name)||typeof range!=='string'||!/^[0-9v~^<>=*xX .|+-]+$/.test(range))throw Error('禁止外部 URL、Git 或本地引用依赖：'+name)
   let parent=dir,found
   while(parent){const path=parent+'/node_modules/'+name;if(files.has(path+'/package.json')){found=path;break}const i=parent.lastIndexOf('/node_modules/');if(i<0)break;parent=parent.slice(0,i)}
   if(!found){if(Object.hasOwn(pkg.optionalDependencies??{},name))continue;throw Error('缺少 npm 传递依赖：'+name)}
   const child=json(files.get(found+'/package.json'));if(child.name!==name||!validVersion(child.version))throw Error('npm 依赖身份错误：'+name)
   // npm's full range grammar is wider than the local semver helper; exact ranges must match.
   if(validVersion(range)&&child.version!==range)throw Error('npm 依赖版本错误：'+name)
   visit(found,child)
  }
  for(const [name,range] of Object.entries(pkg.peerDependencies??{})){
   if(!PACKAGE_NAME.test(name)||typeof range!=='string'||!/^[0-9v~^<>=*xX .|+-]+$/.test(range))throw Error('不安全 peer 依赖')
   if(name.startsWith('@deepseek-ai/'))continue // DSH host-provided peer, verified on actual activation.
   if(pkg.peerDependenciesMeta?.[name]?.optional===true)continue
   let parent=dir,found
   while(parent){const path=parent+'/node_modules/'+name;if(files.has(path+'/package.json')){found=path;break}const i=parent.lastIndexOf('/node_modules/');if(i<0)break;parent=parent.slice(0,i)}
   if(!found)throw Error('缺少 npm peer 依赖：'+name)
   visit(found,json(files.get(found+'/package.json')))
  }
 }
 visit('package',manifest,true)
 return manifest
}
function wheelhouse(bytes,python){
 const files=readZip(bytes,{...ZIP_LIMITS,maxFiles:2048,maxUnpackedBytes:128*1024*1024}),covered=new Map(python.requirements.map(r=>[r.name,new Set()]))
 for(const [name,body] of files){
  const match=/^([A-Za-z0-9_.]+)-([A-Za-z0-9_.!+]+)-(?:[0-9][A-Za-z0-9_]*-)?[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl$/.exec(name)
  if(!match)throw Error('wheelhouse 只能包含根目录 wheel：'+name)
  const normalized=match[1].toLowerCase().replace(/[-_.]+/g,'-'),row=python.requirements.find(r=>r.name===normalized),digest=sha256(body)
  if(!row||row.version!==match[2]||!row.hashes.includes(digest))throw Error('未锁定的 wheel：'+name)
  covered.get(normalized).add(digest)
 }
 for(const row of python.requirements)if(row.hashes.some(h=>!covered.get(row.name).has(h)))throw Error('缺少锁定 wheel：'+row.name)
}
function skill(bytes,item){
 const files=readZip(bytes),prefix=item.id+'/',text=files.get(prefix+'SKILL.md')?.toString('utf8')
 if(!text||[...files.keys()].some(p=>!p.startsWith(prefix)||!portable(p)))throw Error('Skill ZIP 应只包含能力 ID 目录')
 const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);if(!front||!front[1].split(/\r?\n/).some(l=>l.trim()==='name: '+item.id)||!/^description:\s*\S/m.test(front[1]))throw Error('Skill 元数据错误')
}
function core(bytes){
 const files=readZip(bytes),m=json(files.get('manifest.json'))
 if(m.name!=='capability-center-core'||!validVersion(m.version)||m.schemaVersion!==1||m.protocolVersion!==1||m.entry!=='engine/index.js'||!plain(m.compatibility)||!Array.isArray(m.compatibility.os)||!Array.isArray(m.compatibility.arch)||!files.has(m.entry)||!files.has('page/index.html')||json(files.get('package.json')).type!=='module')throw Error('无效核心 ZIP')
 return {id:'capability-center-core',name:'能力中心核心',type:'core',version:m.version,compatibility:m.compatibility,description:'能力中心核心更新'}
}
export function readCapabilityUpload(upload){
 if(!Buffer.isBuffer(upload)||upload.length>MAX_UPLOAD_BYTES)throw Error('上传 ZIP 超过 128 MiB')
 const files=readZip(upload,ZIP_LIMITS),used=new Set(['capability.json']),descriptor=json(files.get('capability.json'))
 if(descriptor.schemaVersion!==1||!plain(descriptor.item))throw Error('无效能力包协议')
 const raw=descriptor.item
 function take(a,extension){
  if(!plain(a)||!portable(a.path)||!a.path.startsWith('payload/')||!a.path.endsWith('.'+extension)||used.has(a.path))throw Error('无效或重复制品路径')
  const body=files.get(a.path);if(!body||!body.length||body.length!==a.bytes||sha256(body)!==a.sha256)throw Error('制品缺失或摘要不符：'+a.path)
  used.add(a.path);return {body,artifact:{path:'packages/'+a.sha256+'.'+extension,sha256:a.sha256,bytes:body.length}}
 }
 let item,body,blobs=[]
 if(raw.type==='core'){
  const a=take(raw.artifact,'zip');body=a.body;item={...core(body),artifact:a.artifact}
  if(raw.version!==item.version||raw.id!==item.id)throw Error('核心身份不一致')
 }else{
  if(!['plugin','skill','composite'].includes(raw.type)||!ID.test(raw.id)||!validVersion(raw.version)||raw.id==='capability-center-core')throw Error('无效能力身份')
  // No arbitrary dependency downloads: only an explicit payload or references to published capabilities.
  const normalized=validateCatalog({schemaVersion:2,items:[raw]},base).items[0]
  item=serializableItem(normalized)
  if(item.type==='composite'){
   if(item.runtime||item.install||item.hidden||item.checks.some(c=>c.type!=='dependencies-ready'))throw Error('组合包只允许已有能力引用与组合检查')
  }else{
   if(item.dependencies.length)throw Error('独立能力不能借用其他能力，请使用组合包')
   const a=take(raw.artifact,item.type==='plugin'?'tgz':'zip');body=a.body;item.artifact=a.artifact
   if(item.type==='plugin'){
     if(!item.checks.some(c=>c.type==='plugin-bundle'))throw Error('插件必须包含原生 Bundle 检查')
     validateBundle(body,item)
   }else{
     if(!item.checks.some(c=>c.type==='skill-discovery'&&(c.name??item.id)===item.id))throw Error('技能必须包含自己的发现检查')
     skill(body,item)
   }
   if(item.runtime){
    for(const asset of item.runtime.assets){
     const a=take(asset,asset.format==='zip'?'zip':'bin')
     if(asset.format==='zip')readZip(a.body,{...ZIP_LIMITS,maxFiles:2048,maxUnpackedBytes:128*1024*1024})
     if(asset.name==='wheelhouse'&&item.runtime.python)wheelhouse(a.body,item.runtime.python)
     asset.path=a.artifact.path;blobs.push({path:asset.path,body:a.body})
    }
   }
  }
 }
 if([...files.keys()].some(k=>!used.has(k)))throw Error('能力包含未声明文件')
 return {item,body,blobs,upload}
}
