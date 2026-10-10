/** Offline migration: retain author data while applying reviewed upstream fields. */
/* eslint-disable @typescript-eslint/no-explicit-any -- offline JSON document migration retains heterogeneous author fields. */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { assertContentGraphArtifact } from '../electron-editor/content-graph-document'

const prior = '00df31f8bd35b34200d507fd83853bf5ac99ba94'
const upstream = '082166c6b803b2e838bce5f0f6824c5bbc714dd6'
const checkpoint = 'f3e78d7bcf'
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
const paths = git('diff', '--name-only', prior, upstream, '--', 'data/skills', 'data/rules', 'data/cards', 'data/pieces').trim().split('\n').filter(Boolean)
const sourceFields = new Set(['code', 'skillCode', 'previewCode', 'effect'])
const report: Array<{ path: string; fields: string[]; remigration: string[] }> = []
const pending: Array<{ path: string; document: Record<string, any> }> = []
for (const path of paths) {
  const before = JSON.parse(git('show', `${prior}:${path}`))
  const after = JSON.parse(git('show', `${upstream}:${path}`))
  const document = JSON.parse(git('show', `${checkpoint}:${path}`))
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  const remigration: string[] = []
  for (const field of fields) {
    if (sourceFields.has(field)) {
      const extras = { ...document.contentGraphEntries }
      delete extras[field]
      if (document.contentGraph && document.contentGraphField === field) {
        delete document.contentGraph
        delete document.contentGraphField
        delete document.contentGraphCompilerVersion
        const next = Object.keys(extras).sort()[0]
        if (next) {
          document.contentGraph = extras[next].graph
          document.contentGraphField = next
          document.contentGraphCompilerVersion = extras[next].compilerVersion
          delete extras[next]
        }
      }
      if (Object.keys(extras).length) document.contentGraphEntries = extras
      else delete document.contentGraphEntries
      if (document.gameplayModules?.entries?.[field]) {
        delete document.gameplayModules.entries[field]
        if (!Object.keys(document.gameplayModules.entries).length) delete document.gameplayModules
      }
      remigration.push(field)
    } else if (JSON.stringify(document[field]) !== JSON.stringify(before[field])) {
      throw new Error(`${path}:${field}: independent local change needs explicit resolution`)
    }
    if (Object.hasOwn(after, field)) document[field] = after[field]
    else delete document[field]
  }
  assertContentGraphArtifact(document)
  pending.push({ path, document })
  report.push({ path, fields, remigration })
}
if (process.argv.includes('--write')) for (const { path, document } of pending) writeFileSync(path, JSON.stringify(document, null, 2) + '\n')
console.log(JSON.stringify({ prior, upstream, checkpoint, mode: process.argv.includes('--write') ? 'written' : 'dry-run', changes: report }, null, 2))
