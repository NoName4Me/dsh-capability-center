import { createHash, sign, verify } from 'node:crypto'

export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}$/u
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
export const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
export const SHA256 = /^[a-f0-9]{64}$/u
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function registryUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('无效私服地址')
  url.pathname = url.pathname.replace(/\/*$/, '/')
  return url
}

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}

export function signedCatalog(value, privateKey) {
  if (!privateKey) return value
  return {...value, signature: {algorithm:'ed25519', value: sign(null, Buffer.from(canonical(value)), privateKey).toString('base64')}}
}

export function verifyCatalog(value, publicKey) {
  const {signature, ...payload} = value
  if (!signature || signature.algorithm !== 'ed25519' || typeof signature.value !== 'string' ||
      !verify(null, Buffer.from(canonical(payload)), publicKey, Buffer.from(signature.value, 'base64'))) throw new Error('目录签名无效')
  return payload
}

export function pluginDescriptor(manifest, overlay = {}) {
  if (!PACKAGE_NAME.test(manifest.name ?? '') || !VERSION.test(manifest.version ?? '') ||
      typeof manifest.dsh?.bundle?.patch !== 'string' || !manifest.dsh.bundle.patch ||
      typeof manifest.engines?.dsh !== 'string') throw new Error('不是有效的 DSH Bundle')
  const meta = {...manifest.capability, ...overlay}
  const id = meta.id ?? manifest.name.split('/').at(-1)
  const name = meta.title ?? meta.name ?? manifest.name
  const description = meta.description ?? manifest.description
  if (!ID.test(id) || typeof name !== 'string' || !name.trim() || typeof description !== 'string' || !description.trim()) throw new Error('缺少能力元数据')
  if (meta.version !== undefined && meta.version !== manifest.version) throw new Error('声明版本与 npm 包不一致')
  // First registry release supports native Bundles only. Complex installation declarations fail closed.
  if (meta.python || meta.assets?.length || meta.components?.length || meta.dependencies?.length) throw new Error('该能力需要尚未支持的额外组件')
  const usage = meta.usage ?? {steps:['安装并确认能力已激活。','按插件说明在 DSH 中使用。'],inputs:'按插件说明提供输入。',output:'由能力提供。',example:'查看插件说明。'}
  return {id, type:'plugin', name, version:manifest.version, description, compatibility:{dsh:manifest.engines.dsh,...(meta.os ? {os:meta.os}:{}),...(meta.arch ? {arch:meta.arch}:{})},
    install:{packageName:manifest.name,registryRequired:true}, checks:[{type:'plugin-bundle'}], dependencies:[], usage,
    trial:{prompt:meta.trial?.prompt ?? '请介绍已安装能力 '+name+' 的使用方法。'},
    ...(meta.category==='mcp'?{category:'mcp'}:{}),
    ...(typeof meta.changelog==='string'?{changelog:meta.changelog.slice(0,4000)}:{})}
}
