/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node validation script */
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
  {
    label: 'known CJK mojibake',
    pattern: /锟斤拷|鈫\?|鈹€|鉂\?|涓嬭浇鎴樻姤|涓嬭浇|鎴樻姤|杩斿洖澶у巺|绂诲紑|鎶曢檷|鍒囨崲瑙嗚|鎴樻枟鏃ュ織|鎴戞柟|鐜╁|鍙栨秷|鎵嬬墝|鏆傛棤|瓒呮椂|琚姩瑙﹀彂|鎸佺画|涓诲姩|琛屽姩|宸叉彁浜ょ洰鏍囬€夋嫨|鍚堟硶鎬ф嫤|鏃犳硶绉诲姩|娓呯┖|鍦版澘|妫嬪瓙|閫夋嫨|鍏堟墜|瀵规垬|璁粌|鏈嶅姟|鐘舵€|鐩爣|鍏呰兘|璐圭敤|鍏嶈垂|路 点击/gu,
  },
  {
    label: 'private-use character',
    pattern: /[\uE000-\uF8FF]/gu,
  },
  {
    label: 'Western mojibake',
    pattern: /Ã[\u0080-\u00FF]|Â[\u0080-\u00FF]|â(?:€|‚|„|…|†|‡|ˆ|‰|Š|‹|Œ|Ž|‘|’|“|”|•|–|—|˜|™|š|›|œ|ž|Ÿ)|ðŸ/gu,
  },
  {
    label: 'question-mark-only string',
    pattern: /(['"])\?{2,}\1/gu,
  },
  {
    label: 'question-mark-only HTML text',
    pattern: />\s*(\?+)\s*</gu,
  },
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

function findBufferIssues(bytes, rel) {
  const findings = []
  let sequence = 0
  const text = bytes.toString('utf8')

  function addFinding(offset, message) {
    findings.push({
      rel,
      line: lineForOffset(text, Math.max(0, offset)),
      message,
      offset,
      sequence: sequence++,
    })
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    addFinding(-1, 'UTF-8 BOM detected')
  }

  let replacementIndex = text.indexOf('\uFFFD')
  while (replacementIndex !== -1) {
    addFinding(replacementIndex, 'replacement character detected')
    replacementIndex = text.indexOf('\uFFFD', replacementIndex + 1)
  }

  for (const { label, pattern } of MOJIBAKE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      addFinding(match.index ?? 0, `possible mojibake: ${label}: ${match[0].slice(0, 24)}`)
    }
  }

  if (path.extname(rel).toLowerCase() === '.json') {
    try {
      JSON.parse(text)
    } catch (error) {
      addFinding(0, `invalid JSON: ${error.message}`)
    }
  }

  return findings
    .sort((left, right) => left.line - right.line || left.offset - right.offset || left.sequence - right.sequence)
    .map(issue => ({ rel: issue.rel, line: issue.line, message: issue.message }))
}

function checkFile(file, root = ROOT) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  if (rel === 'scripts/check-encoding.js') return []

  return findBufferIssues(fs.readFileSync(file), rel)
}

function collectProjectFiles(root = ROOT, targetDirs = TARGET_DIRS) {
  const files = []
  for (const dir of targetDirs) walk(path.join(root, dir), files)
  return files
}

function scanProject(root = ROOT, targetDirs = TARGET_DIRS) {
  const files = collectProjectFiles(root, targetDirs)
  return {
    files,
    issues: files.flatMap(file => checkFile(file, root)),
  }
}

function run() {
  const { files, issues } = scanProject()
  if (issues.length) {
    console.error('[check-encoding] Found text encoding/content issues:')
    for (const issue of issues.slice(0, MAX_REPORTS)) {
      console.error(`- ${issue.rel}:${issue.line} ${issue.message}`)
    }
    if (issues.length > MAX_REPORTS) console.error(`...and ${issues.length - MAX_REPORTS} more`)
    process.exitCode = 1
    return
  }

  console.log(`[check-encoding] OK (${files.length} text files checked)`)
}

if (require.main === module) run()

module.exports = {
  collectProjectFiles,
  findBufferIssues,
  scanProject,
}
