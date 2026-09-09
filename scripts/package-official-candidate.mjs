import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'
const root = path.resolve(import.meta.dirname, '..'), id = process.argv[2] || 'RED-196-rc1'
if (!/^RED-196-rc[0-9]+$/.test(id)) throw new Error('Expected an immutable RED-196 candidate ID')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding:'utf8', windowsHide:true }).trim()
if (git('status','--porcelain','--untracked-files=normal')) throw new Error('Commit candidate sources before packaging')
const commit=git('rev-parse','HEAD'), builtRoot=path.join(root,'dist/official-server/win-x64'), built=JSON.parse(fs.readFileSync(path.join(builtRoot,'build.json'),'utf8'))
if(built.commit!==commit || built.dirty)throw new Error('Rebuild the official package from the clean candidate commit')
for(const file of ['node.exe','server.mjs','Start-Official.cmd','Open-Control-Panel.cmd','control-panel/index.html','data/pages/official.html','postgres/runtime-manifest.json'])if(!fs.existsSync(path.join(builtRoot,file)))throw new Error('Incomplete server package: '+file)
if(fs.existsSync(path.join(builtRoot,'data/users.json')))throw new Error('Legacy account data must never be distributed')
execFileSync(process.execPath,[path.join(root,'scripts/package-multiplayer-candidate.mjs'),id],{cwd:root,stdio:'inherit',windowsHide:true})
const output=path.join(root,'dist/multiplayer',id), filename=`Red-vs-Blue-0.1.0-${id}-Official-Server-Windows-x64.zip`, target=path.join(output,filename)
if(fs.existsSync(target))throw new Error('Candidate already exists')
const guide=fs.readFileSync(path.join(root,'docs/technical/RED-196-OFFICIAL-SERVER.md'))
const zip=new AdmZip();zip.addLocalFolder(builtRoot,'Official-Server');zip.addFile('START-HERE.md',guide);zip.addLocalFile(path.join(root,'docs/technical/RED-193-FIRST-PLAYTEST.md'));zip.writeZip(target)
const releaseFile=path.join(output,'release.json'), release=JSON.parse(fs.readFileSync(releaseFile,'utf8'))
release.artifacts.push({file:filename,bytes:fs.statSync(target).size,sha256:createHash('sha256').update(fs.readFileSync(target)).digest('hex')})
release.status='local-candidate-real-email-and-public-network-pending'
release.official={authority:'Colyseus',accountStore:'PostgreSQL',realMailConfigured:false,publicHttpsConfigured:false}
fs.writeFileSync(releaseFile,JSON.stringify(release,null,2)+'\n')
fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),release.artifacts.map(a=>`${a.sha256}  ${a.file}`).join('\n')+'\n')
fs.writeFileSync(path.join(output,'START-HERE.md'),guide)
fs.copyFileSync(path.join(root,'docs/technical/RED-196-QA.md'),path.join(output,'QA-VERIFICATION.md'))
console.log(JSON.stringify(release,null,2))
