import { describe, expect, it } from 'vitest'
import { StartupUpdateGate } from '../../electron-client/startup-update-gate'

describe('startup update admission', () => {
  it('allows local entry as soon as the local service is ready', () => {
    const gate = new StartupUpdateGate()
    expect(gate.canEnter('current', 'current', false)).toBe(false)
    expect(gate.canEnter('current', 'current', true)).toBe(true)
    expect(gate.canEnter('checking', 'checking', true)).toBe(true)
  })
  it('does not force discovered or downloaded updates before local play', () => {
    const gate = new StartupUpdateGate()
    expect(gate.canEnter('error', 'error', true)).toBe(true)
    expect(gate.canEnter('waiting', 'downloaded', true)).toBe(true)
    expect(gate.canEnter('downloading', 'downloading', true)).toBe(true)
  })
  it('only prevents entry while a resource profile is being applied', () => {
    const gate = new StartupUpdateGate()
    expect(gate.canEnter('applying', 'current', true)).toBe(false)
    expect(gate.canEnter('current', 'unsupported', true)).toBe(true)
  })
})
