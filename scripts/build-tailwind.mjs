/**
 * build-tailwind.mjs
 *
 * Uses @tailwindcss/node's compile API to generate CSS without PostCSS.
 * This avoids the Turbopack + PostCSS worker crash on Windows.
 *
 * Output: app/tailwind-compiled.css
 */

import { compile, optimize } from '@tailwindcss/node'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

// ── 1. Collect all source files ──────────────────────────────────────────────

function collectFiles(dir, exts, results = []) {
  const skip = new Set(['node_modules', '.next', '.git', 'dist', 'android'])
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return results }
  for (const e of entries) {
    if (skip.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      collectFiles(full, exts, results)
    } else if (exts.some(ext => e.name.endsWith(ext))) {
      results.push(full)
    }
  }
  return results
}

const sourceFiles = collectFiles(projectRoot, ['.tsx', '.ts', '.jsx', '.js', '.html', '.mdx'])

// ── 2. Extract class candidates ───────────────────────────────────────────────
// Tailwind v4 uses a generous extractor: anything that could be a class name.

const CANDIDATE_RE = /(?:^|\s|['"`;,({><=])([a-z!][^\s'"`;,(){}<>+=!?\\]+)/g

const candidateSet = new Set()
for (const file of sourceFiles) {
  let content
  try { content = fs.readFileSync(file, 'utf-8') } catch { continue }
  for (const match of content.matchAll(CANDIDATE_RE)) {
    const token = match[1].trim()
    if (token.length > 1 && token.length < 100) {
      candidateSet.add(token)
      // Also add common modifiers like "hover:bg-red-500"
      if (token.includes(':')) {
        candidateSet.add(token.split(':').pop())
      }
    }
  }
}

const candidates = [...candidateSet]
console.log(`[build-tailwind] Found ${sourceFiles.length} source files, ${candidates.length} candidate tokens`)

// ── 3. Read globals.css ───────────────────────────────────────────────────────

const globalsPath = path.join(projectRoot, 'app', 'globals.css')
const css = fs.readFileSync(globalsPath, 'utf-8')

// ── 4. Compile ────────────────────────────────────────────────────────────────

console.log('[build-tailwind] Compiling Tailwind CSS...')

const compiler = await compile(css, {
  base: path.join(projectRoot, 'app'),
  from: globalsPath,
  onDependency: () => {},
})

const output = compiler.build(candidates)

// ── 5. Optimize (minify) ──────────────────────────────────────────────────────

const optimized = optimize(output, { minify: false })
const finalCss = optimized.code ?? output

// ── 6. Write output ───────────────────────────────────────────────────────────

const outPath = path.join(projectRoot, 'app', 'tailwind-compiled.css')
fs.writeFileSync(outPath, finalCss, 'utf-8')

const kb = (finalCss.length / 1024).toFixed(1)
console.log(`[build-tailwind] Done → app/tailwind-compiled.css (${kb} KB)`)
