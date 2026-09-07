import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { analyzeContentFlow } = require('../electron-editor/dist/source-flow.cjs')
const root = process.cwd(), folder = path.join(root, 'docs/qa/RED-192-graph-existing')
const entries = []
const pieces = fs.readdirSync(path.join(root, 'data/pieces')).filter(f => f.endsWith('.json') && f !== 'manifest.json')
  .map(file => JSON.parse(fs.readFileSync(path.join(root, 'data/pieces', file), 'utf8')))
for (const category of ['skills', 'rules']) {
  const base = path.join(root, 'data', category)
  for (const id of fs.readdirSync(base).filter(file => file.endsWith('.json') && file !== 'manifest.json').map(file => file.slice(0, -5)).sort()) {
    const document = JSON.parse(fs.readFileSync(path.join(base, id + '.json'), 'utf8'))
    entries.push({ category, id, document, flow: analyzeContentFlow(category, document, pieces) })
  }
}
const report = { skills: entries.filter(e => e.category === 'skills').length, rules: entries.filter(e => e.category === 'rules').length,
  nodes: entries.reduce((sum, e) => sum + e.flow.summary.nodes, 0), opaque: entries.reduce((sum, e) => sum + e.flow.summary.opaque, 0),
  entries: entries.map(e => ({ category: e.category, id: e.id, name: e.document.name, ...e.flow.summary, diagnostics: e.flow.fields.flatMap(f => f.diagnostics) })) }
if (report.entries.some(e => e.diagnostics.length)) throw new Error('Flow syntax diagnostics: inspect source before export')
fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(path.join(folder, 'coverage.json'), JSON.stringify(report, null, 2) + '\n')
const data = JSON.stringify(entries).replace(/</g, '\\u003c')
const css = fs.readFileSync(path.join(root, 'electron-editor/ui/source-flow.css'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'electron-editor/ui/source-flow.js'), 'utf8')
fs.writeFileSync(path.join(folder, 'flows.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>现有技能与规则流程</title><style>
body{margin:24px;background:#101722;color:#e2e9f3;font:15px system-ui}button,select,input{font:inherit;background:#1b293b;color:inherit;border:1px solid #44576e;border-radius:5px;padding:7px}header{display:flex;gap:14px;align-items:center;flex-wrap:wrap}#summary{color:#b9c8dc} ${css}</style>
<header><h1>技能与规则 · 实际流程</h1><input id="search" placeholder="搜索棋子、技能或规则"><select id="pick" aria-label="选择技能或规则"></select></header><p id="summary"></p><div id="flow"></div>
<script type="application/json" id="data">${data}</script><script>${renderer}</script><script>
const entries=JSON.parse(document.querySelector('#data').textContent), pick=document.querySelector('#pick'), search=document.querySelector('#search');
function list(){const old=pick.value;pick.replaceChildren();for(const e of entries.filter(e=>(e.id+' '+e.document.name).toLowerCase().includes(search.value.toLowerCase()))){const o=document.createElement('option');o.value=e.category+'/'+e.id;o.textContent=(e.category==='skills'?'技能 · ':'规则 · ')+(e.document.name||e.id);pick.append(o)}if([...pick.options].some(o=>o.value===old))pick.value=old;show()}
function show(){const e=entries.find(e=>e.category+'/'+e.id===pick.value);if(!e){document.querySelector('#flow').replaceChildren();return}document.querySelector('#summary').textContent=e.id+' · '+(e.document.description||'')+' · '+e.flow.summary.nodes+'节点';window.ContentSourceFlow.mount(document.querySelector('#flow'),{category:e.category,getDraft:()=>e.document,analyze:async()=>e.flow,navigate:(category,id)=>{search.value='';list();pick.value=category+'/'+id;show()}})}
search.oninput=list;pick.onchange=show;list();pick.value='skills/naruto-sage-mode';if(!pick.value)pick.selectedIndex=0;show();</script></html>`)
console.log(JSON.stringify({ ...report, entries: undefined, gallery: path.join(folder, 'flows.html') }))
