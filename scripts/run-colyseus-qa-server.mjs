import * as serverModule from '../lib/server/colyseus/create-colyseus-server.ts'
import * as journalModule from '../lib/server/postgres/postgres-authority-journal.ts'
import * as fakeRepositoryModule from '../tests/colyseus/fake-authority-repository.ts'

const createColyseusBattleServer = serverModule.createColyseusBattleServer
  ?? serverModule.default?.createColyseusBattleServer
const PostgresAuthorityJournal = journalModule.PostgresAuthorityJournal
  ?? journalModule.default?.PostgresAuthorityJournal
const FakeAuthorityRepository = fakeRepositoryModule.FakeAuthorityRepository
  ?? fakeRepositoryModule.default?.FakeAuthorityRepository
// Manual acceptance must exercise the same timer path as the packaged player runtime.
process.env.RVB_TURN_TIMER_ENABLED = '1'
const repository = new FakeAuthorityRepository()
const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
const { server } = createColyseusBattleServer({
  repository,
  journal,
  healthIdentity: {
    runtime: 'colyseus-qa-volatile',
    database: 'memory-test-double',
  },
})
const port = positiveInteger(process.env.RVB_COLYSEUS_PORT, 2567)
const host = process.env.RVB_COLYSEUS_HOST?.trim() || '127.0.0.1'

await server.listen(port, host)
console.log(`[colyseus-qa] volatile RED-161 UI acceptance server: http://${host}:${port}`)
console.log('[colyseus-qa] This process verifies Colyseus behavior only; it is not a PostgreSQL durability candidate.')

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await server.gracefullyShutdown(false)
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
