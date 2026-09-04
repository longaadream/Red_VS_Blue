import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import {
  POSTGRES_CONNECTION_TIMEOUT_MS,
  attachPostgresPoolErrorHandler,
  preparePostgresAuthority,
} from '@/lib/server/colyseus/create-colyseus-server'

describe('RED-170 PostgreSQL pool lifecycle', () => {
  it('allows a slow local connection and retries transient startup failures', async () => {
    const repository = {
      initializeSchema: vi.fn()
        .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
        .mockRejectedValueOnce(Object.assign(new Error('database system is starting up'), { code: '57P03' }))
        .mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue(undefined),
    }
    const sleep = vi.fn().mockResolvedValue(undefined)
    const error = vi.fn()

    await preparePostgresAuthority(repository, { sleep, logger: { error } })

    expect(POSTGRES_CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
    expect(repository.initializeSchema).toHaveBeenCalledTimes(3)
    expect(repository.healthCheck).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('fails immediately for a permanent PostgreSQL authentication error', async () => {
    const authenticationError = Object.assign(new Error('password authentication failed'), { code: '28P01' })
    const repository = {
      initializeSchema: vi.fn().mockRejectedValue(authenticationError),
      healthCheck: vi.fn(),
    }
    const sleep = vi.fn()

    await expect(preparePostgresAuthority(repository, { sleep })).rejects.toBe(authenticationError)
    expect(repository.initializeSchema).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

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
