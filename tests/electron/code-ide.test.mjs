import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { inspectCode } from '../../electron-editor/code-ide/format.mjs'
const require = createRequire(import.meta.url)
const { readCodeImport } = require('../../electron-editor/dist/code-import.js')

const fixtures = [
  ['code', 'function executeSkill(context){/* inside */ const n=2;return {success:true,value:context.n*n};}'],
  ['code', 'function executeSkill(){const s="引号\\\"换行\\n反斜杠\\\\";return {success:true,s};}'],
  ['code', 'function executeSkill(){const v=String.raw`line1\n  line2\\n`;return {success:true,v};}'],
  ['code', 'function executeSkill(){return\n{success:true};}'],
  ['code', 'function executeSkill(){"use\\x20strict";return this==null;}'],
  ['skillCode', '// 保留注释\nconst value=context.n*2; return {success:true,value};'],
  ['effectCode', 'function(ctx){/* delay */ return {success:true,value:ctx.n};}'],
  ['effectCode', '// AI explanation\nfunction(ctx){return {success:true,value:ctx.n};}'],
  ['effectCode', '/* AI explanation */\nfunction(ctx){const s=String.raw`a\n b`;return {success:true,s};}'],
  ['effectCode', 'function(ctx){return {success:true,value:ctx.n};} // trailing comment'],
  ['effectCode', '/* before */ function(ctx){return {success:true,value:ctx.n};} /* after */'],
  ['previewCode', 'function calculatePreview(piece,skillDef){return {description:skillDef.description};}'],
]
for (const [field, source] of fixtures) test(`format + JSON roundtrip + semantics: ${field} ${source.slice(0, 50)}`, async () => {
  const result = await inspectCode(source, field)
  assert.equal(result.error, undefined)
  assert.equal((await inspectCode(result.formatted, field)).formatted, result.formatted)
  assert.equal(JSON.parse(JSON.stringify({ [field]: result.formatted }))[field], result.formatted)
  const execute = text => {
    // Only controlled fixtures are evaluated; the production editor never executes source.
    const script = field === 'skillCode' ? `(function(context){${text}})({n:3})`
      : field === 'effectCode' ? `(\n${text}\n)({n:3})`
        : `${text}\n${field === 'previewCode' ? 'calculatePreview({}, {description:"x"})' : 'executeSkill({n:3})'}`
    return JSON.stringify(vm.runInNewContext(script, {}, { timeout: 500 }))
  }
  assert.equal(execute(result.formatted), execute(source))
  if (source.includes('/* inside */')) assert.ok(result.formatted.includes('/* inside */'))
})
test('syntax failure returns accurate coordinates without substituting the source', async () => {
  const source = 'function executeSkill() {\n  const x = ;\n}'
  const result = await inspectCode(source, 'code')
  assert.ok(result.error); assert.equal(result.line, 2); assert.ok(result.column > 1)
  assert.equal(result.formatted, undefined)
})
test('unsupported fields and oversized sources are rejected', async () => {
  assert.ok((await inspectCode('x', 'triggerSkill')).error)
  assert.ok((await inspectCode('x'.repeat(200001), 'code')).error)
  assert.ok((await inspectCode({}, 'code')).error)
})
test('rule and skill source use synchronous script contexts, not modules', async () => {
  for (const source of ['export const x=1;', 'await context.foo();', 'break;']) {
    for (const field of ['code', 'skillCode']) assert.ok((await inspectCode(source, field)).error)
  }
  const result = await inspectCode('// rule\nconst a=;', 'skillCode')
  assert.ok(result.error); assert.equal(result.line, 2)
})
test('all current skill/card/rule string code fields can be formatted without modifying disk', async () => {
  let count = 0
  for (const collection of ['skills', 'cards', 'rules']) {
    const directory = path.resolve('data', collection)
    for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.json') && file !== 'manifest.json')) {
      const document = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
      for (const field of ['code', 'skillCode', 'previewCode', 'effectCode']) {
        if (typeof document[field] !== 'string') continue
        const result = await inspectCode(document[field], field)
        assert.equal(result.error, undefined, `${collection}/${file} ${field}: ${result.error}`)
        count++
      }
    }
  }
  assert.ok(count > 200)
})
test('folder import is staged text, nonrecursive, preserves literal JS without execution', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-code-import-'))
  try {
    fs.mkdirSync(path.join(folder, 'nested'))
    fs.writeFileSync(path.join(folder, 'nested/hidden.js'), 'hidden')
    fs.writeFileSync(path.join(folder, '.hidden.js'), 'hidden')
    fs.writeFileSync(path.join(folder, 'not-code.json'), '{}')
    const source = 'throw new Error("must never execute");\n'
    fs.writeFileSync(path.join(folder, 'skill.js'), source)
    fs.writeFileSync(path.join(folder, 'rule.txt'), 'return { success: true };')
    const files = readCodeImport([folder], 'folder')
    assert.equal(files.length, 2)
    assert.equal(files.find(file => file.name === 'skill.js').source, source)
    assert.deepEqual(Object.keys(files[0]).sort(), ['name', 'source'])
  } finally { fs.rmSync(folder, { recursive: true }) }
})
test('import rejects binary, malformed UTF8, oversized text, unsupported type and excessive batch', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-code-import-'))
  try {
    const file = path.join(folder, 'input.js')
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe])); assert.throws(() => readCodeImport([file], 'files'))
    fs.writeFileSync(file, 'a\0b'); assert.throws(() => readCodeImport([file], 'files'), /二进制/)
    fs.writeFileSync(file, 'x'.repeat(200001)); assert.throws(() => readCodeImport([file], 'files'), /200,000/)
    fs.writeFileSync(file, 'x'.repeat(800001)); assert.throws(() => readCodeImport([file], 'files'), /800 KB/)
    assert.throws(() => readCodeImport([path.join(folder, 'a.json')], 'files'), /只接受/)
    assert.throws(() => readCodeImport(Array(51).fill(file), 'files'), /50/)
    assert.throws(() => readCodeImport([folder], 'files'), /只接受/)
  } finally { fs.rmSync(folder, { recursive: true }) }
})
