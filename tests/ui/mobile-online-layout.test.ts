import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const online = readFileSync('data/pages/css/tabletop/online.css', 'utf8')
const adventure = readFileSync('data/pages/css/adventure.css', 'utf8')
const resources = readFileSync('data/pages/css/hand-resources.css', 'utf8')

describe('mobile online and adventure layout', () => {
  it('uses the document as the only touch scroll owner for room lists', () => {
    expect(online).toContain('@media (max-width:900px), (pointer:coarse)')
    expect(online).toMatch(/data-art-page=lobby[^}]*overflow-y:auto[^}]*touch-action:pan-y/)
    expect(online).toMatch(/\.room-scroll\s*\{[^}]*overflow:visible[^}]*max-height:none[^}]*flex:none/)
    expect(online).toMatch(/\.room-columns\s*\{\s*display:none!important/)
    expect(online).toMatch(/\.room-row\s*\{[^}]*display:flex[^}]*flex-wrap:wrap/)
  })

  it('collapses the adventure HUD and keeps its expanded controls above the hand', () => {
    expect(adventure).toContain('@media(orientation:landscape) and (max-height:600px)')
    expect(adventure).toMatch(/#adventureWallet:not\(\.is-expanded\)[^{]*\{display:none\}/)
    expect(adventure).toMatch(/#adventurePartyDock\{[^}]*bottom:calc\(var\(--battle-hand-height,90px\) \+ 4px\)/)
    expect(adventure).toMatch(/#adventureWallet\{[^}]*pointer-events:none/)
    expect(resources).toMatch(/deploymentStatus:not\(\[hidden\]\)\) #handResources\s*\{\s*display:none!important/)
    expect(resources).toMatch(/deploymentStatus:not\(\[hidden\]\)\) #adventureMobileAp/)
  })
})
