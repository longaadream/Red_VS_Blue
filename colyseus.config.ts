import { createColyseusBattleServer } from './lib/server/colyseus/create-colyseus-server'

export const { server, repository, journal } = createColyseusBattleServer()
export default server
