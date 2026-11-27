import { registryUrl, SHA256, sha256, signedCatalog, VERSION } from '../../packages/protocol/index.js'
import { readBoundedUrl } from '../../apps/dsh-plugin/bootstrap/lib/http-transport.js'

export class CoreSource {
  constructor(raw, {privateKey, token, read=readBoundedUrl}={}){
    this.base=raw?registryUrl(raw):null;this.privateKey=privateKey;this.token=token;this.read=read
  }
  async index(){
    if(!this.base)return signedCatalog({schemaVersion:1,protocolVersion:1,releases:[]},this.privateKey)
    const {body}=await this.read(new URL('core-release-index.json',this.base),{maxBytes:1024*1024,timeoutMs:15000,headers:this.token?{authorization:'Bearer '+this.token}:{}})
    const value=JSON.parse(body.toString('utf8'))
    if(value.schemaVersion!==1||value.protocolVersion!==1||!Array.isArray(value.releases)||value.releases.length>100)throw new Error('核心索引无效')
    for(const v of value.releases){
      if(!VERSION.test(v.version)||v.archive!=='core/capability-center-core-'+v.version+'.zip'||!SHA256.test(v.sha256)||!Number.isSafeInteger(v.bytes)||v.bytes<=0||v.bytes>32*1024*1024)throw new Error('核心版本声明无效')
    }
    const {signature,...payload}=value
    return signedCatalog(payload,this.privateKey)
  }
  async artifact(path){
    const index=await this.index()
    const release=index.releases.find(v=>'/'+v.archive===path)
    if(!release||!this.base)return undefined
    const {body}=await this.read(new URL(release.archive,this.base),{maxBytes:release.bytes,timeoutMs:60000,headers:this.token?{authorization:'Bearer '+this.token}:{}})
    if(body.length!==release.bytes||sha256(body)!==release.sha256)throw new Error('核心制品摘要错误')
    return body
  }
}
