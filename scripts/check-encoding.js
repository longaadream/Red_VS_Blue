const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TARGET_DIRS = [
  'app',
  'components',
  'config',
  'data',
  'lib',
  'mobile-server',
  'scripts',
  'tests',
]

const TEXT_EXTS = new Set(['.css', '.html', '.js', '.json', '.mjs', '.ts', '.tsx', '.md', '.txt', '.xml'])
const SKIP_DIRS = new Set(['.git', '.next', 'node_modules', 'dist', 'build', '.gradle'])
const MAX_REPORTS = 80

const MOJIBAKE_PATTERNS = [
  /[鐎鈧鑻鏈妫闃瀹鍩瑰婀绁閫鍔鐐馃鉁閳闁閸]/,
  /鈥[^\n]{0,2}\?/,
  /锛[^\n]{0,2}\?/,
  /鍦版澘|妫嬪瓙|閫夋嫨|鍏堟墜|瀵规垬|璁粌|鏈嶅姟|鐘舵€|鐩爣/,
]

function walk(dir, files) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, files)
      continue
    }
    if (TEXT_EXTS.has(path.extname(entry.name).toLowerCase())) files.push(full)
  }
}

function lineForOffset(text, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

function checkFile(file) {
  if (path.relative(ROOT, file).replace(/\\/g, '/') === 'scripts/check-encoding.js') return []

  const bytes = fs.readFileSync(file)
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const issues = []

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    issues.push({ rel, line: 1, message: 'UTF-8 BOM detected' })
  }

  const text = bytes.toString('utf8')
  const replacementIndex = text.indexOf('\uFFFD')
  if (replacementIndex !== -1) {
    issues.push({ rel, line: lineForOffset(text, replacementIndex), message: 'replacement character detected' })
  }

  for (const pattern of MOJIBAKE_PATTERNS) {
    const match = pattern.exec(text)
    if (match) {
      issues.push({ rel, line: lineForOffset(text, match.index), message: `possible mojibake: ${match[0].slice(0, 24)}` })
      break
    }
  }

  if (path.extname(file).toLowerCase() === '.json') {
    try {
      JSON.parse(text)
    } catch (error) {
      issues.push({ rel, line: 1, message: `invalid JSON: ${error.message}` })
    }
  }

  return issues
}

const files = []
for (const dir of TARGET_DIRS) walk(path.join(ROOT, dir), files)

const issues = files.flatMap(checkFile)
if (issues.length) {
  console.error('[check-encoding] Found text encoding/content issues:')
  for (const issue of issues.slice(0, MAX_REPORTS)) {
    console.error(`- ${issue.rel}:${issue.line} ${issue.message}`)
  }
  if (issues.length > MAX_REPORTS) console.error(`...and ${issues.length - MAX_REPORTS} more`)
  process.exit(1)
}

console.log(`[check-encoding] OK (${files.length} text files checked)`)
