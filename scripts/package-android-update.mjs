// Compatibility entry point; use synchronized-release.mjs for public dual-platform publishing.
import fs from 'node:fs'
import path from 'node:path'
import { androidArtifacts } from './android-release-artifacts.mjs'
const [apk,tag,notesFile,previousApk]=process.argv.slice(2)
if(!apk||!tag)throw Error('Usage: package-android-update.mjs signed.apk vX.Y.Z [notes.txt] [previous.apk]')
const result=androidArtifacts(path.resolve(apk),tag,{previousApk:previousApk&&path.resolve(previousApk),notes:notesFile?fs.readFileSync(notesFile,'utf8'):''})
const out=path.resolve('dist/android-release',tag)
if(fs.existsSync(out))throw Error('Output already exists; do not overwrite release artifacts')
fs.mkdirSync(out,{recursive:true})
for(const [name,bytes]of result.assets)fs.writeFileSync(path.join(out,name),bytes)
console.log(JSON.stringify({output:out,manifest:result.manifest},null,2))
