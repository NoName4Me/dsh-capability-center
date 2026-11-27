import { verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}

export async function trustedPayload(value, publicKeyFile = process.env.DSH_CATALOG_PUBLIC_KEY_FILE) {
  if (!publicKeyFile) return value
  const {signature, ...payload} = value
  if (!signature || signature.algorithm !== 'ed25519' || typeof signature.value !== 'string' ||
      !verify(null, Buffer.from(canonical(payload)), await readFile(publicKeyFile), Buffer.from(signature.value,'base64'))) {
    throw new Error('发布目录签名无效。')
  }
  return payload
}
export function assertTrustedSource(source) {
  const configured=process.env.DSH_CATALOG_URL
  if (!configured) return
  const expected=new URL(configured)
  expected.pathname=expected.pathname.replace(/\/*$/, '/')
  if (new URL(source).href!==expected.href) throw new Error('分发地址不是企业配置的可信发布源。')
}
