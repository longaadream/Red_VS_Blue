import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { attachPostgresPoolErrorHandler } from '@/lib/server/colyseus/create-colyseus-server'

describe('RED-170 PostgreSQL pool lifecycle', () => {
  it('observes idle-client errors so EventEmitter does not terminate the authority process', () => {
    const pool = new EventEmitter()
    const error = vi.fn()
    attachPostgresPoolErrorHandler(pool as never, { error })

    expect(() => pool.emit('error', Object.assign(new Error('idle connection killed'), { code: '57P01' })))
      .not.toThrow()
    expect(error).toHaveBeenCalledWith('[colyseus-postgres] idle pool client error', {
      code: '57P01',
      message: 'idle connection killed',
    })
  })
})
