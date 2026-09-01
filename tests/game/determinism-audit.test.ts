import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const AUTHORITY_INITIALIZATION_FILES = [
  'lib/game/room-battle-start.ts',
  'app/api/relay-battle-init/route.ts',
]

const ROOM_START_DELEGATES = [
  'lib/server/colyseus/battle-room.ts',
]

const CROSS_PLATFORM_AUTHORITY_FILES = {
  mobileServer: 'mobile-server/mobile-server-entry.ts',
  battlePage: 'data/pages/battle.html',
  browserEntry: 'lib/game/engine-browser-entry.ts',
}

const DATA_RULE_BOUNDARIES = [
  'lib/game/skills.ts',
  'lib/game/rule-loader.ts',
  'lib/game/turn.ts',
]

const DIRECT_RULE_CAPABILITY_EXEMPTIONS: Record<string, RegExp[]> = {
  'lib/game/identity-verify.ts': [/Date\.now\(\)/],
  'lib/game/deployment.ts': [/Date\.now\(\)/],
  'lib/game/rng.ts': [/Math\.random\.bind\(Math\)/],
  'lib/game/room-cleanup-config.ts': [/Date\.now\(\)/],
  'lib/game/rule-runtime.ts': [/Math\.random\(\)/, /Date\.now\(\)/],
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

function listTypeScriptFiles(directory: string): string[] {
  const absoluteDirectory = path.join(process.cwd(), directory)
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.posix.join(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(relativePath)
    return entry.isFile() && entry.name.endsWith('.ts') ? [relativePath] : []
  })
}

describe('authority determinism audit', () => {
  it('injects a root seed before every authoritative battle initialization', () => {
    for (const relativePath of AUTHORITY_INITIALIZATION_FILES) {
      const source = read(relativePath)
      const initializationCount = source.match(/createInitialBattleForPlayers\s*\(/g)?.length ?? 0
      const injectedSeedCount = source.match(/rootSeed:\s*seed\b/g)?.length ?? 0

      expect(initializationCount, relativePath).toBeGreaterThan(0)
      expect(injectedSeedCount, relativePath).toBeGreaterThanOrEqual(initializationCount)
      expect(source, relativePath).not.toMatch(/seed\s*:\s*Math\.floor\(Math\.random\(/)
    }

    for (const relativePath of ROOM_START_DELEGATES) {
      expect(read(relativePath), relativePath).toContain('startBattleFromLockedRosters')
    }
  })

  it('contains no unclassified direct wall-clock or random calls in lib/game', () => {
    const violations: string[] = []

    for (const relativePath of listTypeScriptFiles('lib/game')) {
      const exemptions = DIRECT_RULE_CAPABILITY_EXEMPTIONS[relativePath] ?? []
      for (const [lineIndex, line] of read(relativePath).split(/\r?\n/).entries()) {
        if (!/Math\.random|Date\.now/.test(line)) continue
        if (exemptions.some(pattern => pattern.test(line))) continue
        violations.push(`${relativePath}:${lineIndex + 1}: ${line.trim()}`)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps Android legacy replay seeded and Relay clients non-authoritative', () => {
    const mobileServer = read(CROSS_PLATFORM_AUTHORITY_FILES.mobileServer)
    expect(mobileServer.match(/const seed = createRootSeed\(\)/g)?.length, 'mobile root seeds').toBeGreaterThanOrEqual(2)
    expect(mobileServer.match(/rootSeed:\s*seed\b/g)?.length, 'mobile seed injection').toBeGreaterThanOrEqual(2)
    expect(mobileServer).toContain('const initState = state')
    expect(mobileServer).not.toContain("{ type: 'beginPhase' } as Parameters<typeof applyBattleAction>[1]")
    expect(mobileServer).toContain('authorityVersion = 1')
    expect(mobileServer).toContain('stateHash: hashBattleState(state)')
    expect(mobileServer).toContain('deploymentEnabled: true')
    expect(
      mobileServer.match(/deploymentMode:\s*'legacy-reroll-v1'/g)?.length,
      'Android authority entrypoints pinned to legacy deployment',
    ).toBe(2)
    expect(mobileServer).not.toMatch(/seed\s*=\s*Math\.floor\(Math\.random\(/)
    expect(mobileServer).toContain('room.firstPlayerId = initState.turn.currentPlayerId')
    expect(mobileServer).toContain('Invalid deterministic action trace')
    expect(mobileServer).toContain('Trace pre-state hash does not match the authoritative action log')
    expect(mobileServer).toContain('if (trace) Object.assign(entry, trace)')

    const roomStart = read('lib/game/room-battle-start.ts')
    expect(roomStart).toContain("getPlayerSeat(player) === 'red'")
    expect(roomStart).toContain('firstPlayerId,')
    expect(roomStart).toContain('deploymentStartedAt: clock.now()')
    expect(roomStart).not.toContain('RANDOM_STREAM_NAMES.turnOrder')

    const battlePage = read(CROSS_PLATFORM_AUTHORITY_FILES.battlePage)
    expect(battlePage).toContain('function runDeterministicAuthorityAction(state, action)')
    expect(battlePage).toContain('GameEngine.runBattleAction(state, action, { rootSeed: seed })')
    expect(battlePage).toContain("throw new Error('Missing authority root seed')")
    expect(battlePage).not.toMatch(/GameEngine\.applyBattleAction\s*\([^)]*\baction\b/)
    expect(battlePage).not.toContain('optimisticPendingState')
    expect(battlePage).not.toContain('preOptimisticGForEcho')
    expect(battlePage).not.toContain('var authorityTrace = null')
    expect(battlePage).not.toContain('trace: authorityTrace')
    expect(battlePage).not.toMatch(/entry\.action\.type\s*===\s*['"]pending(?:Option|Target)Select['"][\s\S]{0,200}wsActionSeq\s*=/)
    expect(battlePage.match(/runDeterministicAuthorityAction\(/g)?.length, 'training-only deterministic runner definition').toBe(1)
    expect(battlePage).not.toMatch(/RvBColyseus\.send\(\{\s*type:\s*['"]stateUpdate['"]/)
    expect(battlePage).not.toContain('已忽略旧 Relay 客户端权威动作')
    expect(battlePage).not.toContain('runRelayAuthorityAction')
    expect(battlePage).toContain('RvBColyseus.send(battleAuthorityCommandMessage(action, actionAuth))')

    const browserEntry = read(CROSS_PLATFORM_AUTHORITY_FILES.browserEntry)
    expect(browserEntry).toContain('getBattleRootSeed, hashBattleState, hashStable, runBattleAction')
    expect(browserEntry).toContain('applyBattlePublicPatch')

    const gameLogicDoc = read('docs/technical/GAME_LOGIC_SYSTEM.md')
    expect(gameLogicDoc).toContain('浏览器只发送意图、显示服务端投影，不执行在线共享规则')
    expect(gameLogicDoc).toContain('规则失败、')
    expect(gameLogicDoc).toContain('只产生拒绝，不得写 Transition 或改变房间状态')
    expect(gameLogicDoc).not.toContain('UI->>Browser: 在克隆状态执行动作')
  })

  it('keeps browser candidate builds on explicit platform shims', () => {
    const gameEngineBuild = read('scripts/build-game-engine.js')
    const mobileServerBuild = read('scripts/build-mobile-server.js')

    expect(gameEngineBuild).toContain("filter: /^node:(fs|path|crypto|zlib)$/")
    expect(gameEngineBuild).toContain("namespace: 'rvb-browser-stub'")
    expect(gameEngineBuild).toContain('plugins: [browserRuntimeCompatibility]')
    expect(mobileServerBuild).toContain("filter: /^(?:node:)?fs$/")
    expect(mobileServerBuild).toContain("['app-paths',")
  })

  it('injects deterministic Math and Date at every remaining data-code compilation boundary', () => {
    for (const relativePath of DATA_RULE_BOUNDARIES) {
      const source = read(relativePath)
      expect(source, relativePath).toContain('getRuleMath')
      expect(source, relativePath).toContain('getRuleDate')
    }
  })
})
