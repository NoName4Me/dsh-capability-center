import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { signedCatalog, verifyCatalog, pluginDescriptor, registryUrl } from './index.js'
test('签名验证与篡改拒绝',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519')
  const value={schemaVersion:2,revision:1,items:[]}
  const signed=signedCatalog(value,privateKey)
  assert.deepEqual(verifyCatalog(signed,publicKey),value)
  assert.throws(()=>verifyCatalog({...signed,revision:2},publicKey))
})
test('Bundle 继承 npm 身份并拒绝未实现组件',()=>{
  const p={name:'@team/sample',version:'1.0.0',description:'测试',engines:{dsh:'>=0.2.1-rc.2'},dsh:{bundle:{patch:'./cordis.patch.yml'}}}
  assert.equal(pluginDescriptor(p).id,'sample')
  assert.throws(()=>pluginDescriptor(p,{version:'2.0.0'}))
  assert.throws(()=>pluginDescriptor(p,{python:{}}))
  assert.throws(()=>registryUrl('https://a:b@example.com'))
})
