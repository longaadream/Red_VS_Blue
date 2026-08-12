/**
 * sync-android-assets.js
 *
 * 把 Next.js 的静态资源和本地 HTML 页面复制到 Android APK 的 assets 目录，
 * 供 MainActivity 从本地加载，无需每次从服务端下载。
 *
 * 目标目录（相对于 android 项目）：
 *   android/app/src/main/assets/game_assets/
 *
 * MainActivity 会拦截 /data/** 请求并从 assets/game_assets/data/ 读取本地副本。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ASSETS_DST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'game_assets')

function copyDir(src, dst) {
  if (!fs.existsSync(src)) {
    console.warn(`[sync-android] SKIP (not found): ${src}`)
    return 0
  }
  fs.mkdirSync(dst, { recursive: true })
  let count = 0
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      count += copyDir(s, d)
    } else {
      fs.copyFileSync(s, d)
      count++
    }
  }
  return count
}

function generateManifest(srcDir, dirName) {
  const dir = path.join(srcDir, dirName)
  if (fs.existsSync(dir)) {
    const ids = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== 'manifest.json')
      .map(f => f.replace('.json', ''))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(ids, null, 2))
    console.log(`[sync-android] Generated ${dirName} manifest: ${ids.length} entries`)
  }
}

// ── 清理旧的 game_assets ─────────────────────────────────────────────────
if (fs.existsSync(ASSETS_DST)) {
  fs.rmSync(ASSETS_DST, { recursive: true, force: true })
  console.log('[sync-android] Cleaned old game_assets.')
}

// ── 复制 .next/static/ ─────────────────────────────────────────────────
const staticSrc = path.join(ROOT, '.next', 'static')
const staticDst = path.join(ASSETS_DST, '_next', 'static')
const n1 = copyDir(staticSrc, staticDst)
console.log(`[sync-android] Copied .next/static/ → game_assets/_next/static/ (${n1} files)`)

// ── 复制 public/ ────────────────────────────────────────────────────────
const publicSrc = path.join(ROOT, 'public')
const publicDst = path.join(ASSETS_DST, 'public')
const n2 = copyDir(publicSrc, publicDst)
console.log(`[sync-android] Copied public/ → game_assets/public/ (${n2} files)`)

// ── 复制 data/ ─────────────────────────────────────────────────────────
// 供 Android 本地 HTML 页面（训练营、棋子图鉴、地图图鉴）离线读取
const dataSrc = path.join(ROOT, 'data')
const dataDst = path.join(ASSETS_DST, 'data')

if (fs.existsSync(dataSrc)) {
  const n3 = copyDir(dataSrc, dataDst)
  console.log(`[sync-android] Copied data/ → game_assets/data/ (${n3} files)`)

  const dataDirs = ['pieces', 'maps', 'rules', 'skills', 'cards', 'tiles', 'status-effects']
  for (const dirName of dataDirs) {
    generateManifest(dataDst, dirName)
  }
} else {
  console.warn('[sync-android] SKIP data/ (not found)')
}

// ── 复制 HTML 页面 ──────────────────────────────────────────────────────
const pagesSrc = path.join(ROOT, 'data', 'pages')

if (fs.existsSync(pagesSrc)) {
  let pageCount = 0
  for (const entry of fs.readdirSync(pagesSrc)) {
    if (!entry.endsWith('.html')) continue
    const srcFile = path.join(pagesSrc, entry)
    const dstFile = path.join(ASSETS_DST, entry)
    fs.copyFileSync(srcFile, dstFile)
    pageCount++
  }
  console.log(`[sync-android] Copied ${pageCount} HTML pages → game_assets/`)

  // 同时复制到 android-client/www/ 供 Capacitor 使用
  const androidWww = path.join(ROOT, 'android-client', 'www')
  for (const entry of fs.readdirSync(pagesSrc)) {
    if (!entry.endsWith('.html')) continue
    const srcFile = path.join(pagesSrc, entry)
    const dstFile = path.join(androidWww, entry)
    fs.copyFileSync(srcFile, dstFile)
  }
  console.log(`[sync-android] Copied ${pageCount} HTML pages → android-client/www/`)

  // 同时复制到 Windows Electron dist data/pages/（保持安卓/Windows 完全一致）
  const electronPages = path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'data', 'pages')
  if (fs.existsSync(electronPages)) {
    for (const entry of fs.readdirSync(pagesSrc)) {
      if (!entry.endsWith('.html')) continue
      const srcFile = path.join(pagesSrc, entry)
      const dstFile = path.join(electronPages, entry)
      fs.copyFileSync(srcFile, dstFile)
    }
    console.log(`[sync-android] Copied ${pageCount} HTML pages → dist Electron data/pages/`)
  }
  const electronWwwPages = path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'www')
  if (fs.existsSync(electronWwwPages)) {
    for (const entry of fs.readdirSync(pagesSrc)) {
      if (!entry.endsWith('.html')) continue
      const srcFile = path.join(pagesSrc, entry)
      const dstFile = path.join(electronWwwPages, entry)
      fs.copyFileSync(srcFile, dstFile)
    }
    console.log(`[sync-android] Copied ${pageCount} HTML pages to dist Electron www/`)
  }
} else {
  console.warn('[sync-android] SKIP HTML pages (data/pages not found)')
}

// ── 复制 js/ ─────────────────────────────────────────────────────────────
const jsSrc = path.join(ROOT, 'android-client', 'www', 'js')
const jsDst = path.join(ASSETS_DST, 'js')

if (fs.existsSync(jsSrc)) {
  const n4 = copyDir(jsSrc, jsDst)
  console.log(`[sync-android] Copied js/ → game_assets/js/ (${n4} files)`)

  // 同时同步 js/ 到 Windows Electron dist（保持安卓/Windows 完全一致）
  const electronJs = path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'www', 'js')
  if (fs.existsSync(electronJs)) {
    const n4e = copyDir(jsSrc, electronJs)
    console.log(`[sync-android] Synced js/ → dist Electron www/js/ (${n4e} files)`)
  }
  const electronPageJs = path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'data', 'pages', 'js')
  const electronPageDir = path.dirname(electronPageJs)
  if (fs.existsSync(electronPageDir)) {
    const n4p = copyDir(jsSrc, electronPageJs)
    console.log(`[sync-android] Synced js/ to dist Electron data/pages/js/ (${n4p} files)`)
  }
} else {
  console.warn('[sync-android] SKIP js/ (not found)')
}

// ── 复制 images/ ────────────────────────────────────────────────────────
// 优先从 Windows 客户端构建输出中获取图片（最完整），其次从 public/ 获取
const electronBuildImages = path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'www', 'images')
const imagesDst = path.join(ASSETS_DST, 'images')
const androidWwwImagesDst = path.join(ROOT, 'android-client', 'www', 'images')

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.svg', '.webp', '.gif'])

function copyImagesFromDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return 0
  if (fs.existsSync(dstDir)) {
    fs.rmSync(dstDir, { recursive: true, force: true })
  }
  fs.mkdirSync(dstDir, { recursive: true })
  let imgCount = 0
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) continue
    fs.copyFileSync(
      path.join(srcDir, entry.name),
      path.join(dstDir, entry.name)
    )
    imgCount++
  }
  return imgCount
}

function countImagesInDir(srcDir) {
  if (!fs.existsSync(srcDir)) return 0
  return fs.readdirSync(srcDir)
    .filter(name => IMAGE_EXTS.has(path.extname(name).toLowerCase())).length
}

let imgCount = 0
const electronImageCount = countImagesInDir(electronBuildImages)
if (!fs.existsSync(publicSrc) && electronImageCount > 0) {
  imgCount = copyImagesFromDir(electronBuildImages, imagesDst)
  console.log(`[sync-android] Copied images from electron-build → game_assets/images/ (${imgCount} files)`)
  copyImagesFromDir(electronBuildImages, androidWwwImagesDst)
} else if (fs.existsSync(publicSrc)) {
  imgCount = copyImagesFromDir(publicSrc, imagesDst)
  console.log(`[sync-android] Copied images from public/ → game_assets/images/ (${imgCount} files)`)
  copyImagesFromDir(publicSrc, androidWwwImagesDst)
  const electronWww = path.dirname(electronBuildImages)
  if (fs.existsSync(electronWww)) {
    const electronSyncedCount = copyImagesFromDir(publicSrc, electronBuildImages)
    console.log(`[sync-android] Synced images to dist Electron www/images/ (${electronSyncedCount} files)`)
  }
} else {
  console.warn('[sync-android] SKIP images (no source found)')
}

// ── 复制 public/card-art/ → android-client/www/images/card-art/ ─────────
const terrainSrc = path.join(ROOT, 'public', 'terrain')
if (fs.existsSync(terrainSrc)) {
  const terrainTargets = [
    path.join(imagesDst, 'terrain'),
    path.join(androidWwwImagesDst, 'terrain'),
    path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'www', 'images', 'terrain'),
    path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'data', 'pages', 'images', 'terrain'),
  ]
  let terrainCount = 0
  for (const target of terrainTargets) {
    terrainCount = copyDir(terrainSrc, target)
  }
  console.log(`[sync-android] Copied public/terrain/ to images/terrain/ (${terrainCount} files, ${terrainTargets.length} targets)`)
}

const cardArtSrc = path.join(ROOT, 'public', 'card-art')
const cardArtDst = path.join(ROOT, 'android-client', 'www', 'images', 'card-art')
if (fs.existsSync(cardArtSrc)) {
  const cardArtTargets = [
    cardArtDst,
    path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'www', 'images', 'card-art'),
  ]
  let cardArtCount = 0
  const cardArtFiles = fs.readdirSync(cardArtSrc).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
  cardArtCount = cardArtFiles.length
  for (const dst of cardArtTargets) {
    if (dst === cardArtDst || fs.existsSync(path.dirname(path.dirname(dst)))) {
      fs.mkdirSync(dst, { recursive: true })
      for (const f of cardArtFiles) fs.copyFileSync(path.join(cardArtSrc, f), path.join(dst, f))
    }
  }
  console.log(`[sync-android] Copied public/card-art/ → images/card-art/ (${cardArtCount} files, ${cardArtTargets.length} targets)`)
}

// ── 复制 data/ 到 android-client/www/data/ ──────────────────────────────
const androidWwwData = path.join(ROOT, 'android-client', 'www', 'data')

if (fs.existsSync(dataSrc)) {
  if (fs.existsSync(androidWwwData)) {
    fs.rmSync(androidWwwData, { recursive: true, force: true })
  }
  const n5 = copyDir(dataSrc, androidWwwData)
  console.log(`[sync-android] Copied data/ → android-client/www/data/ (${n5} files)`)

  for (const dirName of ['pieces', 'maps', 'rules', 'skills', 'cards', 'tiles', 'status-effects']) {
    generateManifest(androidWwwData, dirName)
  }

  // 同时同步 data/ 到 Windows Electron dist（保持安卓/Windows 完全一致）
  const electronData = path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'data')
  if (fs.existsSync(electronData)) {
    const n6 = copyDir(dataSrc, electronData)
    console.log(`[sync-android] Synced data/ → dist Electron data/ (${n6} files)`)
  }
  const electronWwwData = path.join(ROOT, 'dist', 'client-build', 'win-unpacked', 'resources', 'app', 'www', 'data')
  if (fs.existsSync(path.dirname(electronWwwData))) {
    const n7 = copyDir(dataSrc, electronWwwData)
    console.log(`[sync-android] Synced data/ to dist Electron www/data/ (${n7} files)`)
  }
}

console.log('[sync-android] Done.')
