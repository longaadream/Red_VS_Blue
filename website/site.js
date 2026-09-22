// Download links stay tied to the reviewed public release, independently of the candidate atlas.
fetch('./release.json', {cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('manifest');return r.json()}).then(data=>{
  if(!/^\d+\.\d+\.\d+$/.test(data.version))return;
  for(const el of document.querySelectorAll('[data-download]')){
    const item=data[el.dataset.download];if(!item)continue;
    const url=new URL(item.url),versionPrefix='/'+data.version+'/';
    const pinnedClient=el.dataset.download==='windows'||el.dataset.download==='android';
    if(url.protocol==='https:'&&url.origin==='https://updates.redvsblue.top'&&(!pinnedClient||url.pathname.startsWith(versionPrefix)))el.href=url.href;
  }
  document.querySelectorAll('[data-version]').forEach(el=>el.textContent=data.version);
  document.querySelectorAll('[data-release]').forEach(el=>el.href='https://github.com/longaadream/Red_VS_Blue/releases/tag/v'+data.version);
  const label=document.getElementById('resource-version');if(label&&data.resource)label.textContent='公开资源 '+data.resource.version+' · 最低客户端 '+data.resource.minimumClientVersion;
}).catch(()=>{});
