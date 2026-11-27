import { deflateRawSync } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { readCapabilityUpload, MAX_UPLOAD_BYTES } from '../publisher/index.js'
import { safeRelativePath } from '../../apps/dsh-plugin/core/lib/archive.js'
import { sha256 } from '../protocol/index.js'
const table=Array.from({length:256},(_,i)=>{let c=i;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0})
function crc(bytes){let c=0xffffffff;for(const byte of bytes)c=(c>>>8)^table[(c^byte)&255];return (c^0xffffffff)>>>0}
export function zipFiles(files){
 const local=[],central=[];let offset=0,cdSize=0
 for(const [path,bytes] of [...files].sort(([a],[b])=>a.localeCompare(b))){
  if(!safeRelativePath(path)||!Buffer.isBuffer(bytes))throw Error('无效 ZIP 条目')
  const name=Buffer.from(path),compressed=deflateRawSync(bytes),checksum=crc(bytes),header=Buffer.alloc(30),directory=Buffer.alloc(46)
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26)
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt16LE(33,14);directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42)
  local.push(header,name,compressed);central.push(directory,name);offset+=header.length+name.length+compressed.length;cdSize+=directory.length+name.length
 }
 if(files.size>65535||offset+cdSize+22>MAX_UPLOAD_BYTES)throw Error('ZIP 过大')
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(cdSize,12);end.writeUInt32LE(offset,16)
 return Buffer.concat([...local,...central,end])
}
export function makeCapabilityZip(item,files){
 const entries=new Map(files);entries.set('capability.json',Buffer.from(JSON.stringify({schemaVersion:1,item},null,2)+'\n'))
 const upload=zipFiles(entries);readCapabilityUpload(upload);return upload
}
export async function packDescriptor(path,output){
 const descriptor=JSON.parse(await readFile(path,'utf8')),item=structuredClone(descriptor.item??descriptor),files=new Map(),root=resolve(dirname(path))
 for(const a of [item.artifact,...(item.runtime?.assets??[])].filter(Boolean)){
  if(!safeRelativePath(a.path)||!a.path.startsWith('payload/'))throw Error('制品必须位于声明文件旁的 payload/ 下')
  const source=resolve(root,...a.path.split('/'));if(!source.startsWith(root+sep))throw Error('制品越界')
  const bytes=await readFile(source);a.sha256=sha256(bytes);a.bytes=bytes.length;files.set(a.path,bytes)
 }
 const upload=makeCapabilityZip(item,files)
 await writeFile(output,upload,{flag:'wx'});return {id:item.id,version:item.version,bytes:upload.length,sha256:sha256(upload)}
}
