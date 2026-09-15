import { describe, expect, it } from 'vitest'
import { StartupUpdateGate } from '../../electron-client/startup-update-gate'

describe('startup update admission', () => {
  it('requires a completed check and a ready local service', () => {
    const gate = new StartupUpdateGate()
    expect(gate.canEnter('current', 'current', true)).toBe(false)
    gate.checked = true
    expect(gate.canEnter('current', 'current', false)).toBe(false)
    expect(gate.canEnter('current', 'current', true)).toBe(true)
  })
  it('allows offline entry before discovering updates but blocks failed downloads', () => {
    const gate = new StartupUpdateGate()
    gate.checked = true
    expect(gate.canEnter('error', 'error', true)).toBe(true)
    expect(gate.canEnter('current', 'error', true)).toBe(true)
    expect(gate.canEnter('error', 'current', true)).toBe(true)
    gate.observe('current', 'downloading')
    gate.observe('current', 'error')
    expect(gate.canEnter('current', 'error', true)).toBe(false)
  })
  it('keeps a failed resource update required until confirmed current', () => {
    const gate = new StartupUpdateGate()
    gate.checked = true
    gate.observe('waiting', 'unsupported')
    gate.observe('error', 'unsupported')
    expect(gate.canEnter('error', 'unsupported', true)).toBe(false)
    gate.observe('current', 'unsupported')
    expect(gate.canEnter('current', 'unsupported', true)).toBe(true)
  })
})
