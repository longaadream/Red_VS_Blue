import { hostDiscoveryFromEnvironment } from '../electron-client/host-discovery'
import { createColyseusBattleServer } from '../lib/server/colyseus/create-colyseus-server'

export const { server, repository, journal, restoreProductRooms, updateAdmission } = createColyseusBattleServer({ hostDiscovery: hostDiscoveryFromEnvironment })
export default server
