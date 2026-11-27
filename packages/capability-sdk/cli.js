#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pluginDescriptor } from '../protocol/index.js'
const [command,path='package.json']=process.argv.slice(2)
try{
  if(command!=='validate')throw new Error('Usage: dsh-capability validate [package.json]')
  const manifest=JSON.parse(await readFile(resolve(path),'utf8'))
  console.log(JSON.stringify(pluginDescriptor(manifest),null,2))
}catch(error){console.error(error.message);process.exitCode=1}
