import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

type AuditFailure = Error & { status?: number; stdout?: string }

type EventEvidence = { event: string }

type EventAuditReport = {
  schemaVersion: number
  declaredWithoutProducers: unknown[]
  events: unknown[]
  emittedOnly: unknown[]
  undeclaredEvents: unknown[]
  consumedOnly: EventEvidence[]
  declaredWithoutConsumers: EventEvidence[]
}

function runEventAudit(): { status: number; report: EventAuditReport } {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/audit-combat-events.mjs'], { encoding: 'utf8' })
    return { status: 0, report: JSON.parse(stdout) as EventAuditReport }
  } catch (error) {
    const failure = error as AuditFailure
    return { status: failure.status ?? 1, report: JSON.parse(failure.stdout ?? '{}') as EventAuditReport }
  }
}

describe('RED-45 producer/consumer event catalog', () => {
  it('resolves literal context variables and inventories producer and consumer evidence', () => {
    const { report } = runEventAudit()

    expect(report.schemaVersion).toBe(2)
    expect(report.declaredWithoutProducers).toEqual([])
    expect(report.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'beforeDamageDealt',
        declared: true,
        producers: expect.arrayContaining(['lib/game/skills.ts']),
        consumers: expect.arrayContaining(['data/rules/rule-watcher-rage-dealt.json#trigger.type']),
      }),
      expect.objectContaining({
        event: 'beforeMove',
        declared: true,
        producers: expect.arrayContaining(['lib/game/turn.ts']),
        consumers: expect.arrayContaining(['data/rules/rule-freeze-prevent-move.json#trigger.type']),
      }),
    ]))
  })

  it('fails observably for the undeclared and producerless beforeAttack consumers', () => {
    const { status, report } = runEventAudit()

    expect(status).toBe(1)
    expect(report.emittedOnly).toEqual([])
    expect(report.undeclaredEvents).toEqual([
      expect.objectContaining({
        event: 'beforeAttack',
        declared: false,
        producers: [],
        consumers: [
          'data/rules/rule-freeze-prevent-attack.json#trigger.type',
        ],
      }),
    ])
    expect(report.consumedOnly.map(entry => entry.event)).toEqual(['beforeAttack'])
  })

  it('reports declared events without current data consumers without treating them as producers', () => {
    const { report } = runEventAudit()
    const consumerless = report.declaredWithoutConsumers.map(entry => entry.event)

    expect(consumerless).toEqual(expect.arrayContaining([
      'afterCardAdded',
      'afterChargeGained',
      'afterPieceSummoned',
      'beforePieceSummoned',
      'whenever',
    ]))
  })
})
