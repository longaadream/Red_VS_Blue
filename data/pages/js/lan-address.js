;(function(){
  async function show(container,explicit){
    const params=new URLSearchParams(location.search)
    if(params.get('lobbyContext')==='public')return
    const raw=explicit||params.get('serverUrl')||params.get('server')||''
    let url;try{url=new URL(raw)}catch{return}
    if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.search||url.hash)return
    let addresses=[url.origin]
    if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
      const host=window.RvBHost||window.electronAPI
      if(!host?.getLanIps)return
      addresses=[...new Set(await host.getLanIps())].filter(ip=>/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)&&!ip.startsWith('127.')&&!ip.startsWith('169.254.')&&ip!=='0.0.0.0').map(ip=>url.protocol+'//'+ip+(url.port?':'+url.port:''))
    }
    container.replaceChildren();container.hidden=false
    const title=document.createElement('p');title.textContent='局域网直连地址（队友在主页“加入房间”中填写）';container.append(title)
    if(!addresses.length){title.textContent='未取得局域网 IP，请检查 Wi-Fi 或热点连接。';return}
    for(const address of addresses){
      const row=document.createElement('div'),text=document.createElement('input'),copy=document.createElement('button')
      row.style.cssText='display:flex;gap:8px;margin:6px 0';text.value=address;text.readOnly=true;text.setAttribute('aria-label','局域网直连地址');text.style.cssText='min-width:0;flex:1;user-select:text';copy.textContent='复制'
      copy.onclick=async()=>{try{await navigator.clipboard.writeText(address);copy.textContent='已复制'}catch{text.focus();text.select();copy.textContent='请长按复制'}}
      row.append(text,copy);container.append(row)
    }
  }
  window.RvBLanAddress={show}
  document.addEventListener('DOMContentLoaded',()=>{const box=document.getElementById('lanAddress');if(box)void show(box).catch(error=>{box.hidden=false;box.textContent='读取局域网地址失败：'+error.message})})
})()
