import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@colyseus/sdk'
import { matchMaker } from 'colyseus'
import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres.ts'
import { findFreePort } from '../../electron-client/local-port.ts'
import { createOfficialServer } from '../../lib/server/official/server.ts'
import { digest, secret, hashPassword } from '../../lib/server/official/accounts.ts'
import { getServerGameProfileIdentityV1 } from '../../lib/content-pipeline/runtime/profile-game-identity.ts'
import { getDemoPieceIds, getPieceById } from '../../lib/game/piece-repository.ts'
import { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } from '../../lib/game/battle-public-patch.ts'

const root = process.cwd(), output = path.join(root, 'dist/multiplayer-qa'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-ranked-load-'))
const pg = new EmbeddedPostgresController({ runtimeRoot: path.join(root, '_client-postgres/pgsql'), stateRoot: state, findFreePort, portHint: 38961, protectSecret: x => Buffer.from(x), unprotectSecret: x => x.toString() })
const profileIdentity = getServerGameProfileIdentityV1(), sockets = [], results = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await delay(100) }; throw new Error('Timed out: ' + label) }
function message(room, type, trigger) {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { off(); reject(new Error(type + ' timeout')) }, 15000); const off = room.onMessage(type, value => { clearTimeout(timer); off(); resolve(value) }); trigger() })
}
const percentile = (values, fraction) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*fraction)-1)]
let app
try {
  const db = await pg.start(), port = await findFreePort(38962), url = `http://127.0.0.1:${port}`
  app = await createOfficialServer({ databaseUrl: db.url, mail: async () => { throw new Error('Load testing never sends email') }, maxMatches: 10, reconnectGraceMs: 1000 })
  await app.start(port)
  const passwordHash = await hashPassword('Load-test-only-password'), users = []
  // Auth correctness is covered separately; this test seeds verified fixture identities.
  for (let i = 0; i < 100; i++) {
    const user = { id: randomUUID(), token: secret() }; users.push(user)
    await app.pool.query('INSERT INTO official_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [user.id, `${user.id}@example.test`, `负载${i}`, passwordHash])
    await app.pool.query('INSERT INTO official_sessions(token_hash,account_id) VALUES($1,$2)', [digest(user.token), user.id])
  }
  const pieces = getDemoPieceIds().map(getPieceById).filter(p => p?.faction === 'good').slice(0,8).map(p => ({ templateId:p.id, faction:p.faction }))
  async function join(user, id, spectator = false) { const socket = await new Client(url).joinById(id, { playerId:user.id, officialToken:user.token, alignment:'light', profileIdentity, spectator }); socket.onMessage('*',()=>{}); sockets.push(socket); return socket }
  for (const count of [5, 10]) {
    const start = performance.now(), cpu = process.cpuUsage(), games = [], rtts = [], receipts = []
    for (const user of users.slice(0,count*2)) await app.ranked.enqueue(user.id)
    await until(async()=>{ await app.ranked.tick(); return Number((await app.pool.query("SELECT count(*) FROM official_matches WHERE status='assigned'")).rows[0].count) === count }, 'match allocation')
    for (let i=0; i<count; i++) {
      const first = users[i*2], second = users[i*2+1], id = (await app.ranked.status(first.id)).matchId
      const a = await join(first,id), b = await join(second,id)
      for (const [socket,user] of [[a,first],[b,second]]) await socket.request('roomRpc',{method:'rooms.action',data:{action:'select-pieces',playerId:user.id,alignment:'light',pieces,profileIdentity}})
      const viewers = []
      for(let j=0;j<8;j++) viewers.push(await join(users[20+i*8+j],id,true))
      games.push({id,first,second,a,b,viewers})
    }
    for(let round=0;round<3;round++) {
      await Promise.all(games.flatMap(g=>[g.a,g.b,...g.viewers]).map(async socket=>{const began=performance.now();await message(socket,'battleSnapshot',()=>socket.send('battleResync',{}));rtts.push(performance.now()-began)}))
      await delay(250)
    }
    // Real transport drop -> AI takeover event -> the original identity reclaims control.
    const dropped = games[0]; dropped.a.reconnection.enabled = false; dropped.a.connection.close(); dropped.b.reconnection.enabled = false; dropped.b.connection.close()
    await until(async()=>Number((await app.pool.query('SELECT count(*) FROM official_drops WHERE match_id=$1 AND account_id=$2',[dropped.id,dropped.first.id])).rows[0].count)===1,'AI takeover',15000)
    await until(async()=>{ const room = await app.repository.restoreRoom(dropped.id); return Number(room?.room?.battleAuthorityVersion) >= 8 },'AI actually advances authority',30000)
    dropped.a=await join(dropped.first,dropped.id); dropped.b=await join(dropped.second,dropped.id)
    const rss = process.memoryUsage().rss/1024/1024
    if(rss>2048) throw new Error('Load test safety stop: process RSS exceeded 2 GiB')
    for(const game of games) {
      const view = await message(game.a,'battleSnapshot',()=>game.a.send('battleResync',{})), actionId = randomUUID(), began = performance.now()
      const receipt = await message(game.a,'battleReceipt',()=>game.a.send('battleCommand',{protocolVersion:BATTLE_AUTHORITY_PROTOCOL_VERSION,authorityBuildId:BATTLE_AUTHORITY_BUILD_ID,roomId:game.id,playerId:game.first.id,expectedAuthorityVersion:view.authorityVersion,clientActionId:actionId,command:{type:'surrender',playerId:game.first.id,clientActionId:actionId}}))
      if(receipt.kind!=='applied') throw new Error('Server rejected actual load-test command')
      receipts.push(performance.now()-began); await app.ranked.settle(game.id)
      for(const socket of [game.a,game.b,...game.viewers]) if(socket.connection.isOpen) await socket.leave()
      await matchMaker.getLocalRoomById(game.id).closeOfficialMatch()
    }
    if(Number((await app.pool.query("SELECT count(*) FROM official_matches WHERE status='assigned'")).rows[0].count)!==0)throw new Error('Match capacity not released')
    const used=process.cpuUsage(cpu), elapsed=performance.now()-start
    const result={matches:count,players:count*2,spectators:count*8,totalConnections:count*10,elapsedMs:Math.round(elapsed),processRssMiB:Math.round(rss),combinedServerAndSdkCpuCoreAverage:(used.user+used.system)/1000/elapsed,snapshotP95Ms:Math.round(percentile(rtts,.95)),commandReceiptP95Ms:Math.round(percentile(receipts,.95)),aiTakeoverAndReclaim:true,aiAuthorityCommandsAtLeast:8,settled:count}
    results.push(result); console.log('[official-load]',JSON.stringify(result))
  }
  fs.writeFileSync(path.join(output,'red196-load.json'),JSON.stringify({platform:process.platform,node:process.version,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemoryGiB:Math.round(os.totalmem()/1024**3),scope:'Loopback actual Colyseus matches, 8 spectators each, resync bursts and surrender commands; SDK clients share server process. No WAN, SMTP throughput or sustained full-match AI capacity claim.',results},null,2))
} finally { for(const socket of sockets) if(socket.connection.isOpen) await socket.leave(); await app?.close(); await pg.stop() }
