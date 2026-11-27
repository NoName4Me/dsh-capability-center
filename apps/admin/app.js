const $=id=>document.getElementById(id)
let token=''
const status=message=>{$('status').textContent=message}
async function api(path,data){
  const response=await fetch('/api/admin/'+path,{method:data?'POST':'GET',headers:{authorization:'Bearer '+token,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})})
  const value=await response.json()
  if(!response.ok)throw new Error(value.error??'请求失败')
  return value
}
function element(tag,text){const node=document.createElement(tag);node.textContent=text;return node}
async function refresh(){
  const result=await api('versions')
  $('versions').replaceChildren()
  for(const v of result.versions){
    const row=element('div','');row.className='row'
    const info=element('div','');info.append(element('strong',v.item.name+' · '+v.version),element('p',(v.item.install?.packageName??'Skill ZIP')+' / '+v.state))
    row.append(info)
    const actions={draft:['publish'],published:['delist','revoke'],delisted:['publish','revoke'],revoked:[]}[v.state]??[]
    for(const action of actions){
      const button=element('button',{publish:'发布',delist:'下架',revoke:'安全撤回'}[action])
      button.onclick=async()=>{if(!confirm(button.textContent+' '+v.item.name+' '+v.version+'？'))return;button.disabled=true;try{await api('change',{id:v.id,version:v.version,action});await refresh();status('操作完成')}catch(e){status(e.message);button.disabled=false}}
      row.append(button)
    }
    $('versions').append(row)
  }
  if(!result.versions.length)$('versions').append(element('p','尚无能力版本'))
  $('audit').replaceChildren(...result.audit.map(x=>element('p',x.at+' · '+x.action+' · '+x.id+'@'+x.version)))
}
$('login').onsubmit=async e=>{e.preventDefault();token=$('token').value;$('token').value='';try{await refresh();status('已连接')}catch(e){status(e.message)}}
$('import').onsubmit=async e=>{e.preventDefault();try{await api('import',{packageName:$('name').value.trim(),version:$('version').value.trim(),overlay:{...($('overlay-id').value.trim()?{id:$('overlay-id').value.trim()}:{}),...($('overlay-title').value.trim()?{title:$('overlay-title').value.trim()}:{})}});await refresh();status('已导入草稿，请核对后发布')}catch(e){status(e.message)}}

$('import-raw').onsubmit=async e=>{e.preventDefault();try{await api('import-raw',{descriptorPath:$('raw-path').value.trim()});await refresh();status('已导入 Skill 草稿')}catch(e){status(e.message)}}
