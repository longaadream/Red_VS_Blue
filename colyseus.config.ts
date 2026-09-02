import { createColyseusBattleServer } from './lib/server/colyseus/create-colyseus-server'

export const { server, repository, journal, restoreProductRooms } = createColyseusBattleServer()
export default server
