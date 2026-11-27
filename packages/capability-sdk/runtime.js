import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Copy or bundle this helper into a DSH Bundle; no workspace link is needed at runtime. */
export function capabilityRuntime(id,version,{home=process.env.DSH_HOME??join(homedir(),'.dsh')}={}){
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw Error('无效能力标识')
 const directory=join(home,'capability-center','runtimes',id,version)
 const value=JSON.parse(readFileSync(join(directory,'runtime.json'),'utf8'))
 if(value.id!==id||value.version!==version||value.directory!==directory)throw Error('能力运行环境无效')
 return {python:value.python,assets:value.assets,directory}
}
