#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pluginDescriptor } from '../protocol/index.js'
import { readCapabilityUpload } from '../publisher/index.js'
import { packDescriptor } from './pack.js'
const [command,path='package.json',output]=process.argv.slice(2)
try{
 if(command==='validate')console.log(JSON.stringify(pluginDescriptor(JSON.parse(await readFile(resolve(path),'utf8'))),null,2))
 else if(command==='pack'&&output)console.log(JSON.stringify(await packDescriptor(resolve(path),resolve(output)),null,2))
 else if(command==='inspect')console.log(JSON.stringify(readCapabilityUpload(await readFile(resolve(path))).item,null,2))
 else throw Error('Usage: dsh-capability validate package.json | pack capability.json output.zip | inspect upload.zip')
}catch(error){console.error(error.message);process.exitCode=1}
