import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { PACKAGE_NAME, VERSION, registryUrl, pluginDescriptor, sha256 } from '../protocol/index.js'
import { readBoundedUrl } from '../../src/bootstrap/lib/http-transport.js'

const MAX = 32*1024*1024

// Read only package/package.json, never extract or execute a tarball.
export function readNpmManifest(bytes) {
  const tar=gunzipSync(bytes,{maxOutputLength:128*1024*1024})
  let manifest
  for(let offset=0;offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512)
    if(header.every(x=>x===0)) break
    const field=(a,b)=>header.subarray(a,b).toString('utf8').split('\0')[0]
    const name=field(0,100), prefix=field(345,500)
    const length=field(124,136).trim()
    if(!/^[0-7]+$/.test(length)) throw new Error('无效 tar 长度')
    const size=parseInt(length,8), start=offset+512
    if(!Number.isSafeInteger(size)||start+size>tar.length) throw new Error('tar 越界')
    const full=prefix?prefix+'/'+name:name
    if(full==='package/package.json') {
      if(manifest || size>1024*1024 || !['','0'].includes(field(156,157))) throw new Error('无效或重复 package.json')
      manifest=JSON.parse(tar.subarray(start,start+size).toString('utf8'))
    }
    offset=start+Math.ceil(size/512)*512
  }
  if(!manifest) throw new Error('制品缺少 package/package.json')
  return manifest
}

export async function resolveBundle({registry,packageName,version,overlay,token,read=readBoundedUrl}) {
  if(!PACKAGE_NAME.test(packageName)||!VERSION.test(version)) throw new Error('必须指定合法包名和精确版本')
  const base=registryUrl(registry)
  const headers={accept:'application/json',...(token?{authorization:'Bearer '+token}:{})}
  const response=await read(new URL(encodeURIComponent(packageName),base),{headers,maxBytes:8*1024*1024,timeoutMs:15000})
  const metadata=JSON.parse(response.body.toString('utf8')).versions?.[version]
  if(metadata?.name!==packageName||metadata.version!==version) throw new Error('私服未返回目标版本')
  const tarball=new URL(metadata.dist?.tarball)
  if(tarball.origin!==base.origin || !tarball.pathname.startsWith(base.pathname) || tarball.username || tarball.password || tarball.search || tarball.hash) throw new Error('拒绝私服范围外的制品地址')
  const integrity=metadata.dist?.integrity
  if(typeof integrity!=='string'||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error('私服制品缺少 SHA-512 integrity')
  const {body}=await read(tarball,{headers:{...headers,accept:'application/octet-stream'},maxBytes:MAX,timeoutMs:60000})
  if('sha512-'+createHash('sha512').update(body).digest('base64')!==integrity) throw new Error('npm integrity 不匹配')
  const manifest=readNpmManifest(body)
  if(manifest.name!==packageName||manifest.version!==version) throw new Error('制品身份与私服元数据不一致')
  const item=pluginDescriptor(manifest,overlay)
  const digest=sha256(body)
  item.artifact={path:'packages/'+digest+'.tgz',sha256:digest,bytes:body.length}
  return {item,body,integrity,dependencies:manifest.dependencies??{}}
}
