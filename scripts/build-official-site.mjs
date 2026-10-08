#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve(import.meta.dirname, '..')
const website = path.join(root, 'website')
const clientVersion = '0.1.13'
const resourceVersion = '1.0.12'
const semver = /^\d+\.\d+\.\d+$/

function usage() {
  return 'Usage: node scripts/build-official-site.mjs --source <resource-snapshot> --output <site-output>'
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--source' && argument !== '--output') {
      throw new Error(`${usage()}\nUnknown argument: ${argument}`)
    }
    if (values.has(argument)) throw new Error(`${argument} may be provided only once`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    values.set(argument, value)
    index += 1
  }
  if (!values.has('--source') || !values.has('--output')) throw new Error(usage())
  return {
    source: path.resolve(process.cwd(), values.get('--source')),
    output: path.resolve(process.cwd(), values.get('--output'))
  }
}

function requireDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Missing ${label}: ${directory}`)
  }
}

function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertReleaseManifest() {
  const release = readJson(path.join(website, 'release.json'), 'website release manifest')
  if (release.version !== clientVersion || !semver.test(release.version)) {
    throw new Error(`Website release manifest client version must be ${clientVersion}`)
  }
  if (release.resource?.version !== resourceVersion || release.resource.minimumClientVersion !== clientVersion) {
    throw new Error(`Website release manifest resource must be ${resourceVersion} for client ${clientVersion}`)
  }
  if (!/^[a-f0-9]{64}$/.test(release.resource?.contentHash || '')) {
    throw new Error('Website release manifest resource contentHash must be a lowercase SHA-256 value')
  }
  if (!release.windows?.url || !release.android?.url || !release.resource?.url) {
    throw new Error('Website release manifest is missing a download URL')
  }
  return release
}

function loadSharedContent() {
  const context = {}
  vm.runInNewContext(fs.readFileSync(path.join(root, 'data/pages/js/deck-presets.js'), 'utf8'), context)
  vm.runInNewContext(fs.readFileSync(path.join(root, 'data/pages/js/gallery-content.js'), 'utf8'), context)
  if (!context.RvBDeckPresets || !context.RvBGalleryContent) {
    throw new Error('Missing shared gallery content helpers')
  }
  return context
}

function assertSafeRelativePath(relative, label) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..') || relative.split('\\').includes('..')) {
    throw new Error(`Unsafe ${label} path: ${relative}`)
  }
}

function buildSite({ source, output }) {
  requireDirectory(source, 'resource snapshot')
  requireDirectory(website, 'website source')
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing output: ${output}`)
  const release = assertReleaseManifest()
  const context = loadSharedContent()
  const piecesDirectory = path.join(source, 'data/pieces')
  const skillsDirectory = path.join(source, 'data/skills')
  const cardsDirectory = path.join(source, 'data/cards')
  const keywordsFile = path.join(source, 'data/skill-keywords.json')
  const manifestFile = path.join(piecesDirectory, 'manifest.json')
  requireDirectory(piecesDirectory, 'piece definitions')
  requireDirectory(skillsDirectory, 'skill definitions')
  requireDirectory(cardsDirectory, 'card definitions')
  if (!fs.existsSync(manifestFile)) throw new Error(`Missing piece manifest: ${manifestFile}`)
  if (!fs.existsSync(keywordsFile)) throw new Error(`Missing keyword definitions: ${keywordsFile}`)

  const parent = path.dirname(output)
  fs.mkdirSync(parent, { recursive: true })
  const staging = fs.mkdtempSync(path.join(parent, '.official-site-'))
  try {
    fs.cpSync(website, staging, { recursive: true })
    for (const file of ['battle-audio.js', 'battle-impact.js', 'button-audio.js']) {
      fs.copyFileSync(path.join(root, 'data/pages/js', file), path.join(staging, 'assets', file))
    }

    const readData = (kind, id) => {
      if (typeof id !== 'string' || !id) throw new Error(`Missing ${kind} definition id`)
      assertSafeRelativePath(id, `${kind} definition`)
      return readJson(path.join(source, 'data', kind, `${id}.json`), `${kind} ${id}`)
    }
    const keywords = readJson(keywordsFile, 'keyword definitions')
    if (!Array.isArray(keywords)) throw new Error('Keyword definitions must be an array')
    const keywordMap = new Map(keywords.flatMap(keyword => [[keyword.name, keyword], [keyword.id, keyword]]))
    const definedKeywords = values => (values || []).filter(name => keywordMap.has(name))

    function copyImage(relative, id, folder, { required = false } = {}) {
      if (!relative) {
        if (required) throw new Error(`Missing image for ${id}: no image path`)
        return null
      }
      relative = String(relative).replaceAll('\\', '/')
      assertSafeRelativePath(relative, `${id} image`)
      const candidates = [
        path.join(source, 'images', relative),
        path.join(source, 'images', 'adventure', relative),
        path.join(root, 'public', relative),
        path.join(root, 'data/pages/images', relative)
      ]
      const imageSource = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile())
      if (!imageSource) throw new Error(`Missing image for ${id}: ${relative}`)
      const extension = path.extname(relative)
      const image = `assets/${folder}/${id}${extension}`
      const destination = path.join(staging, image)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(imageSource, destination)
      return image
    }

    function skillView(entry) {
      const id = typeof entry === 'string' ? entry : entry?.skillId || entry?.id
      const skill = readData('skills', id)
      const triggeredBy = entry?.triggeredBy ? readData('skills', entry.triggeredBy) : null
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        kind: skill.kind,
        type: skill.type,
        keywords: definedKeywords(skill.keywords),
        actionPointCost: skill.actionPointCost || 0,
        chargeCost: skill.chargeCost || 0,
        cooldownTurns: skill.cooldownTurns || 0,
        triggeredBy: triggeredBy?.name || null
      }
    }

    const ids = readJson(manifestFile, 'piece manifest')
    if (!Array.isArray(ids)) throw new Error('Piece manifest must be an array')
    const pieces = ids
      .map(id => readData('pieces', id))
      .filter(context.RvBGalleryContent.isGalleryPiece)
      .map(piece => {
        const skills = (piece.skills || []).map(skillView)
        const transformedSkills = (piece.transformedSkills || []).map(skillView)
        const relatedCards = (piece.relatedCards || []).map(id => {
          const card = readData('cards', id)
          return {
            id: card.id,
            name: card.name,
            description: card.description,
            type: card.type,
            actionPointCost: card.actionPointCost || 0,
            chargeCost: card.chargeCost || 0,
            cooldownTurns: card.cooldownTurns ?? card.cooldown ?? 0,
            keywords: definedKeywords(card.keywords),
            targetText: card.targetText || '',
            image: copyImage(card.image ? `card-art/${card.image}` : null, card.id, 'cards')
          }
        })
        const keywordNames = new Set([...skills, ...transformedSkills, ...relatedCards].flatMap(item => item.keywords))
        const pieceKeywords = [...keywordNames].map(name => {
          const keyword = keywordMap.get(name)
          if (!keyword) throw new Error(`Missing keyword definition: ${name} for ${piece.id}`)
          return {
            id: keyword.id,
            name: keyword.name,
            shortDescription: keyword.shortDescription || '',
            longDescription: keyword.longDescription || ''
          }
        })
        return {
          id: piece.id,
          name: piece.name,
          description: piece.description || '',
          faction: piece.faction,
          stats: piece.stats,
          role: context.RvBDeckPresets.roleFor(piece),
          image: copyImage(piece.image, piece.id, 'pieces', { required: true }),
          skills,
          transformedSkills,
          relatedCards,
          keywords: pieceKeywords
        }
      })

    fs.writeFileSync(
      path.join(staging, 'atlas.json'),
      JSON.stringify({ label: `资源 ${release.resource.version} · 配套客户端 ${release.resource.minimumClientVersion}`, pieces }, null, 2)
    )
    if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing output: ${output}`)
    fs.renameSync(staging, output)
    return { output, count: pieces.length, resourceVersion: release.resource.version }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

try {
  const result = buildSite(parseArgs(process.argv.slice(2)))
  console.log(`Built ${result.output} with ${result.count} pieces; resource ${result.resourceVersion}.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
