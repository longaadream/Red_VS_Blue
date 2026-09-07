/* Static source projection; authored JavaScript is never evaluated in this view. */
(() => {
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
  const svgEl=(tag,attrs)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n}
  window.ContentSourceFlow={mount(container,{category,getDraft,onChange,analyze,edit,navigate}){
    let revision=0,fieldKey,sectionId,selected,zoom=0.8,analysis
    const button=(text,fn)=>{const b=el('button',text);b.type='button';b.onclick=fn;return b}
    async function refresh(){
      const ticket=++revision;container.textContent='正在解析实际执行流程…'
      try{analysis=await analyze(category,getDraft())}catch(error){if(ticket===revision)container.textContent=error.message;return}
      if(ticket===revision)render()
    }
    function render(){
      const oldView=container.querySelector('.source-flow-viewport'),scroll=oldView?{x:oldView.scrollLeft,y:oldView.scrollTop}:null
      container.replaceChildren();container.className='source-flow'
      const explanation=el('details');explanation.append(el('summary','运行入口与解析说明'),el('p',analysis.context,'flow-context'))
      for(const note of analysis.notes)explanation.append(el('p',note,'flow-note'))
      container.append(explanation)
      const links=el('div',undefined,'flow-links')
      for(const link of analysis.links)links.append(button(link.reason+' → '+link.id,()=>navigate?.(link.category,link.id)))
      container.append(links)
      const field=analysis.fields.find(f=>f.key===fieldKey)||analysis.fields[0]
      if(!field){container.append(el('p','此定义由上方关联规则或公共被动实现。'));return}
      fieldKey=field.key
      const toolbar=el('div',undefined,'flow-toolbar'),fields=el('select');fields.setAttribute('aria-label','流程代码入口')
      for(const f of analysis.fields){const o=el('option',f.key+(f.readOnly?'（只读）':''));o.value=f.key;fields.append(o)}
      fields.value=field.key;fields.onchange=()=>{fieldKey=fields.value;sectionId=null;selected=null;render()};toolbar.append(fields)
      if(field.diagnostics.length){container.append(toolbar,el('pre',field.diagnostics.join('\n'),'flow-error'));return}
      const section=field.sections.find(s=>s.id===sectionId)||field.sections.find(s=>s.id===field.entry)||field.sections[0]
      sectionId=section.id
      const functions=el('select');functions.setAttribute('aria-label','函数或回调子流程')
      for(const s of field.sections){const o=el('option',s.label+' · '+s.id);o.value=s.id;functions.append(o)}
      functions.value=section.id;functions.onchange=()=>{sectionId=functions.value;selected=null;render()}
      toolbar.append(functions,button('缩小',()=>{zoom=Math.max(0.25,zoom-0.15);render()}),button('放大',()=>{zoom=Math.min(1.4,zoom+0.15);render()}));container.append(toolbar)
      const view=el('div',undefined,'source-flow-viewport'),canvas=el('div',undefined,'source-flow-canvas')
      const ranks=new Map(),active=new Set(),seen=new Set(),back=new Set()
      const walk=id=>{if(seen.has(id))return;seen.add(id);active.add(id);for(const e of section.edges.filter(e=>e.from===id)){if(active.has(e.to))back.add(e);else walk(e.to)}active.delete(id)}
      walk(section.nodes[0].id)
      for(let pass=0;pass<section.nodes.length;pass++){let changed=false;for(const e of section.edges){if(back.has(e))continue;const value=(ranks.get(e.from)||0)+1;if(value>(ranks.get(e.to)||0)){ranks.set(e.to,value);changed=true}}if(!changed)break}
      const last=Math.max(0,...ranks.values())+1
      for(const n of section.nodes)if(n.kind.endsWith('exit'))ranks.set(n.id,last)
      const columns=new Map(),positions=new Map()
      for(const n of section.nodes){const row=ranks.get(n.id)||0,col=columns.get(row)||0;columns.set(row,col+1);positions.set(n.id,{x:30+col*365,y:30+row*160})}
      const width=Math.max(640,...[...positions.values()].map(p=>p.x+350)),height=Math.max(360,...[...positions.values()].map(p=>p.y+135))
      toolbar.append(button('全图',()=>{zoom=Math.max(0.08,Math.min(1,(view.clientWidth-20)/width,(view.clientHeight-20)/height));render()}))
      canvas.style.width=width+'px';canvas.style.height=height+'px';canvas.style.transform='scale('+zoom+')';canvas.style.transformOrigin='top left'
      const surface=el('div');surface.style.width=width*zoom+'px';surface.style.height=height*zoom+'px';surface.append(canvas);view.append(surface)
      const svg=svgEl('svg',{width,height,class:'source-flow-edges'})
      for(const e of section.edges){
        const a=positions.get(e.from),b=positions.get(e.to);if(!a||!b)continue
        const x1=a.x+155,y1=a.y+120,x2=b.x+155,y2=b.y,bend=back.has(e)?Math.max(a.x,b.x)+335:null
        const d=bend?'M'+x1+' '+y1+' H'+bend+' V'+(y2-12)+' H'+x2+' V'+y2:'M'+x1+' '+y1+' V'+((y1+y2)/2)+' H'+x2+' V'+y2
        svg.append(svgEl('path',{d,fill:'none',stroke:e.label==='否'?'#e1a767':'#8bb3df','stroke-width':2}))
        svg.append(svgEl('path',{d:'M'+(x2-5)+' '+(y2-8)+' L'+x2+' '+y2+' L'+(x2+5)+' '+(y2-8),fill:'none',stroke:'#8bb3df','stroke-width':2}))
        if(e.label){const t=svgEl('text',{x:bend||x1+8,y:bend?y2-14:y1+16,fill:'#b7c7d8','font-size':12});t.textContent=e.label;svg.append(t)}
      }
      canvas.append(svg)
      for(const n of section.nodes){const p=positions.get(n.id),card=button('',()=>{selected=n.id;render()});card.className='source-flow-node '+n.kind+(selected===n.id?' selected':'');card.dataset.sourceFlowNode=n.id;card.style.left=p.x+'px';card.style.top=p.y+'px';card.append(el('strong',n.label),el('code',n.source.slice(0,170)));canvas.append(card)}
      container.append(view)
      if(scroll){view.scrollLeft=scroll.x;view.scrollTop=scroll.y}
      const node=section.nodes.find(n=>n.id===selected),panel=el('section',undefined,'flow-inspector')
      if(node){
        panel.append(el('h3',node.label))
        if(node.section)panel.append(button('打开函数 / 回调子流程',()=>{sectionId=node.section;selected=null;render()}))
        if(node.opaque)panel.append(el('p','内部控制流尚未展开，请核对完整代码。','flow-error'))
        const source=el('textarea');source.value=node.source;source.spellcheck=false;source.dataset.flowNodeSource='';source.setAttribute('aria-label','节点源码');panel.append(source)
        if(onChange&&edit&&node.start>=0&&!field.readOnly&&!getDraft().skillGraph)panel.append(button('应用节点修改',async()=>{
          const captured=JSON.stringify(getDraft())
          try{const next=await edit(category,JSON.parse(captured),{field:field.key,hash:field.hash,section:section.id,node:node.id,replacement:source.value});if(JSON.stringify(getDraft())!==captured)throw Error('草稿已变化，请重新选择节点');onChange(next);selected=null;await refresh()}catch(error){panel.append(el('p',error.message,'flow-error'))}
        }));else source.readOnly=true
      }else panel.append(el('p','点击节点查看完整条件或操作；函数/回调可从上方切换。修改节点后仍需保存文件。'))
      container.append(panel)
    }
    refresh();return {refresh}
  }}
})()
