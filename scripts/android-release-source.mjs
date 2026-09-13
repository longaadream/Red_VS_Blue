// Runs after the current source's Android stage task, before merge/package tasks.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { sha256 } from './apk-delta.mjs'
const root = path.resolve(import.meta.dirname, '..')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim()
if (commit !== process.env.RVB_RELEASE_SOURCE_COMMIT) throw Error('Android release source changed')
const generated = path.join(root, 'android/app/build/generated')
const files = []
for (const name of ['ui-acceptance-assets', 'android-host-assets']) {
  const directory = path.join(generated, name)
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw Error('Release stage may not contain links')
      if (entry.isDirectory()) walk(file)
      else if (entry.name !== 'android-release-source.json') files.push({ path:'assets/'+path.relative(directory,file).split(path.sep).join('/'), sha256:sha256(fs.readFileSync(file)) })
    }
  }
  walk(directory)
}
if (new Set(files.map(f=>f.path)).size !== files.length) throw Error('Duplicate staged Android asset')
fs.writeFileSync(path.join(generated, 'ui-acceptance-assets/android-release-source.json'), JSON.stringify({sourceCommit:commit, files}))
