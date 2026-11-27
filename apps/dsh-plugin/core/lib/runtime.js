import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { devNull } from 'node:os'
import { mkdir, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { readZip, safeRelativePath } from './archive.js'
import { atomicWriteJson, readJson } from './atomic.js'
import { verifyOwnedFiles } from './installers.js'
import { normalizeServerUrl } from './manifest.js'
import { canonical } from './signature.js'

const run=promisify(execFile)
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const identity=/^[a-z0-9][a-z0-9-]{0,63}$/
const version=/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/
function runtimePath(root,id,v){
 if(!identity.test(id)||!version.test(v))throw Error('非法运行环境标识')
 return join(root,'runtimes',id,v)
}
async function ensureDir(path){
 try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('运行目录不是普通目录')}
 catch(e){if(e.code!=='ENOENT')throw e;await mkdir(path)}
}
function env(){
 const value={...process.env}
 for(const k of Object.keys(value))if(/^PIP_|^PYTHON(?:PATH|HOME)$|^VIRTUAL_ENV$/i.test(k))delete value[k]
 return {...value,PIP_CONFIG_FILE:devNull,PIP_DISABLE_PIP_VERSION_CHECK:'1',PYTHONDONTWRITEBYTECODE:'1'}
}
async function execute(python,args,timeout=180000){
 try{return await run(python,args,{timeout,maxBuffer:1024*1024,encoding:'utf8',windowsHide:true,env:env()})}
 catch(e){throw Error('Python 环境操作失败（退出 '+String(e.code??'unknown')+'），请检查私服、wheel 及解释器兼容性。')}
}
const descriptor=runtime=>({...runtime,assets:(runtime.assets??[]).map(({url,...a})=>a)})
function assetPath(path){
 return safeRelativePath(path)&&path.split('/').every(p=>!/[<>:"|?*]/.test(p)&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
}

export async function verifyRuntime(root,item,record){
 const directory=runtimePath(root,item.id,item.version)
 if(record?.directory!==directory)throw Error('运行环境账本路径不匹配')
 for(const path of [join(root,'runtimes'),dirname(directory),directory]) {
   const info=await lstat(path)
   if(!info.isDirectory()||info.isSymbolicLink())throw Error('运行环境路径不安全')
 }
 const ready=await readJson(join(directory,'runtime.json'))
 if(!ready||ready.id!==item.id||ready.version!==item.version||ready.fingerprint!==hash(canonical(descriptor(item.runtime))))throw Error('运行环境声明不匹配')
 await verifyOwnedFiles(directory,ready.files)
 if(item.runtime.python){
   const python=join(directory,'venv',...(process.platform==='win32'?['Scripts','python.exe']:['bin','python']))
   if(ready.python!==python)throw Error('运行环境解释器路径不匹配')
   const source='import importlib.metadata as m, json, sys; print(json.dumps([m.version(n) for n in sys.argv[1:]]))'
   const rows=item.runtime.python.requirements
   const versions=JSON.parse((await execute(python,['-I','-c',source,...rows.map(x=>x.name)],20000)).stdout)
   if(rows.some((r,i)=>versions[i]!==r.version))throw Error('Python 依赖版本与锁定声明不符')
   await execute(python,['-I','-m','pip','check'],20000)
 }
 return ready
}

export async function prepareRuntime({root,item,operationId,http,basePython,beforeMutation}){
 if(!item.runtime)return undefined
 const directory=runtimePath(root,item.id,item.version)
 await ensureDir(join(root,'runtimes'))
 await ensureDir(dirname(directory))
 let existing
 try{
   const info=await lstat(directory)
   if(!info.isDirectory()||info.isSymbolicLink())throw Error('运行环境路径不安全')
   existing=await readJson(join(directory,'runtime.json'),null)
 }catch(e){if(e.code!=='ENOENT')throw e}
 if(existing){
   if(item.runtime.python&&(existing.basePython!==basePython?.python||existing.baseVersion!==basePython?.version))throw Error('DSH Python 已变化，请先卸载旧运行环境后重装。')
   return await verifyRuntime(root,item,{directory})
 }
 try{await lstat(directory);throw Error('存在未完成的运行目录，请先恢复。')}catch(e){if(e.code!=='ENOENT')throw e}
 await beforeMutation({kind:'runtime-create',itemId:item.id,version:item.version,operationId})
 await mkdir(directory,{mode:0o700})
 await atomicWriteJson(join(directory,'owner.json'),{id:item.id,version:item.version,operationId})
 const files=[], assets={}
 for(const a of item.runtime.assets??[]){
   const {body}=await http.readBoundedUrl(a.url,{maxBytes:a.bytes,timeoutMs:60000})
   if(body.length!==a.bytes||hash(body)!==a.sha256)throw Error('资源摘要错误：'+a.name)
   const target=join(directory,'assets',a.name)
   await mkdir(target,{recursive:true})
   const entries=a.format==='zip'?readZip(body):new Map([['resource.bin',body]])
   const paths=new Set()
   for(const [path,bytes] of entries){
     if(!assetPath(path)||paths.has(path.toLowerCase()))throw Error('不安全或重复资源路径')
     paths.add(path.toLowerCase())
     const file=join(target,...path.split('/'))
     await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes,{flag:'wx'})
     files.push({path:['assets',a.name,path].join('/'),sha256:hash(bytes),bytes:bytes.length})
   }
   assets[a.name]=a.format==='zip'?target:join(target,'resource.bin')
 }
 let python=null
 if(item.runtime.python){
   if(!basePython?.python||!basePython?.version)throw Error('DSH Python 不可用')
   const index=process.env.DSH_PYPI_INDEX
   if(!index)throw Error('请配置 DSH_PYPI_INDEX 内网 Python 私服')
   const registry=normalizeServerUrl(index)
   await execute(basePython.python,['-I','-m','venv',...(item.runtime.python.inheritBuiltin?['--system-site-packages']:[]),join(directory,'venv')])
   python=join(directory,'venv',...(process.platform==='win32'?['Scripts','python.exe']:['bin','python']))
   const lock=join(directory,'requirements.lock')
   const content=item.runtime.python.requirements.map(r=>r.name+'=='+r.version+' '+r.hashes.map(h=>'--hash=sha256:'+h).join(' ')).join('\n')+'\n'
   await writeFile(lock,content,{flag:'wx'})
   files.push({path:'requirements.lock',sha256:hash(content),bytes:Buffer.byteLength(content)})
   await execute(python,['-I','-m','pip','install','--disable-pip-version-check','--no-input','--no-cache-dir','--index-url',registry,'--only-binary=:all:','--require-hashes','--no-deps','--ignore-installed','-r',lock])
 }
 const record={id:item.id,version:item.version,operationId,directory,python,assets,files,basePython:basePython?.python??null,baseVersion:basePython?.version??null,fingerprint:hash(canonical(descriptor(item.runtime)))}
 await atomicWriteJson(join(directory,'runtime.json'),record)
 return await verifyRuntime(root,item,record)
}

export async function removeRuntime(root,{itemId,version:v,operationId}){
 const directory=runtimePath(root,itemId,v)
 for(const parent of [join(root,'runtimes'),dirname(directory),directory]){
   try{const info=await lstat(parent);if(!info.isDirectory()||info.isSymbolicLink())throw Error('运行环境路径不安全')}
   catch(e){if(e.code==='ENOENT')return;throw e}
 }
 const owner=await readJson(join(directory,'owner.json'),null)
 if(!owner){
   if((await readdir(directory)).length===0&&operationId){await rm(directory,{recursive:true});return}
   throw Error('无法验证运行环境所有权')
 }
 if(owner.id!==itemId||owner.version!==v||owner.operationId!==operationId)throw Error('运行环境所有权不匹配')
 await rm(directory,{recursive:true})
}
