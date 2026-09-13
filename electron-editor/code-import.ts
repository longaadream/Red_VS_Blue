import * as fs from 'node:fs'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_FILE_BYTES = 800000
const MAX_TOTAL_BYTES = 2000000
const MAX_FILES = 50
const supported = (file: string) => /\.(js|txt)$/i.test(file)

/** Only called with paths returned by the editor's native file picker. Text is never executed. */
export function readCodeImport(selection: string[], mode: 'files' | 'folder') {
  if (!Array.isArray(selection) || !['files', 'folder'].includes(mode)) throw new Error('无效的导入请求')
  let files = selection
  if (mode === 'folder') {
    if (selection.length !== 1) throw new Error('请选择一个文件夹')
    const directory = fs.lstatSync(selection[0])
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('请选择普通文件夹')
    const entries = fs.readdirSync(selection[0], { withFileTypes: true })
    files = entries.filter(entry => !entry.name.startsWith('.') && supported(entry.name))
      .map(entry => path.join(selection[0], entry.name)).sort()
  }
  if (!files.length) throw new Error('没有找到 .js 或 .txt 文件；只读取所选文件夹的第一层')
  if (files.length > MAX_FILES) throw new Error('一次最多导入 50 个文件，请缩小选择范围')
  let total = 0
  return files.map(file => {
    if (!supported(file)) throw new Error('只接受 .js 或 .txt 文件')
    const metadata = fs.lstatSync(file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('只接受普通文件：' + path.basename(file))
    if (metadata.size > MAX_FILE_BYTES || total + metadata.size > MAX_TOTAL_BYTES) throw new Error('文件过大；单文件最多 800 KB，总计最多 2 MB')
    const fd = fs.openSync(file, 'r')
    try {
      const current = fs.fstatSync(fd)
      if (!current.isFile() || current.dev !== metadata.dev || current.ino !== metadata.ino || current.size !== metadata.size) throw new Error('导入文件已变化，请重新选择')
      const bytes = Buffer.alloc(current.size + 1)
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
      if (count !== current.size) throw new Error('导入文件已变化，请重新选择')
      total += count
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
      if (source.includes('\0') || source.length > 200000) throw new Error('文件包含二进制内容或超过 200,000 字符')
      return { name: path.basename(file), source }
    } finally { fs.closeSync(fd) }
  })
}
