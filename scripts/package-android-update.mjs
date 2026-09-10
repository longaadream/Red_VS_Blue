// Produces public Release assets. Does not sign, upload, or publish anything.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const [apkArg,tag,notesFile]=process.argv.slice(2)
if(!apkArg||!tag||!/^[A-Za-z0-9._-]+$/.test(tag))throw Error('Usage: node scripts/package-android-update.mjs <signed.apk> <release-tag> [notes.txt]')
const apk=path.resolve(apkArg)
const sdk=process.env.ANDROID_HOME||path.join(process.env.LOCALAPPDATA||'','Android/Sdk')
const aapt=process.env.RVB_AAPT||path.join(sdk,'build-tools/35.0.0/aapt.exe')
const info=execFileSync(aapt,['dump','badging',apk],{encoding:'utf8'})
const match=info.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/)
const minSdk=Number(info.match(/sdkVersion:'(\d+)'/)?.[1])
if(!match||!minSdk)throw Error('Cannot read APK package/version/minSdk')
const output=path.resolve('dist/android-release',tag);fs.mkdirSync(output,{recursive:true})
const name=`RedVsBlue-Android-${match[2]}.apk`
const bytes=fs.readFileSync(apk)
const manifest={schemaVersion:'rvb-android-update/v1',packageName:match[1],versionCode:Number(match[2]),versionName:match[3],minSdk,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),url:`https://github.com/longaadream/Red_VS_Blue/releases/download/${tag}/${name}`,notes:notesFile?fs.readFileSync(path.resolve(notesFile),'utf8'):''}
fs.copyFileSync(apk,path.join(output,name))
fs.writeFileSync(path.join(output,'android-latest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({output,manifest},null,2))
