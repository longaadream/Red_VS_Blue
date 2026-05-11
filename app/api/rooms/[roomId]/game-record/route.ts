import { NextRequest, NextResponse } from 'next/server'
import { getRoomStore } from '@/lib/game/room-store'
import { verifyRecordSignature, derivePlayerId } from '@/lib/game/identity-verify'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params
  const room = await getRoomStore().getRoom(roomId.toLowerCase())
  if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 })
  if (!room.gameRecord) return NextResponse.json({ error: 'Game not finished' }, { status: 404 })
  return NextResponse.json(room.gameRecord)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params
  const body = await req.json() as { playerId?: string; publicKey?: string; signature?: string }
  const { playerId, publicKey, signature } = body

  if (!playerId || !publicKey || !signature) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  const roomStore = getRoomStore()
  const room = await roomStore.getRoom(roomId.toLowerCase())
  if (!room?.gameRecord) return NextResponse.json({ error: 'Game record not found' }, { status: 404 })
  if (!room.players.find(p => p.id === playerId)) {
    return NextResponse.json({ error: 'Player not in this game' }, { status: 403 })
  }
  if (await derivePlayerId(publicKey) !== playerId) {
    return NextResponse.json({ error: 'Public key mismatch' }, { status: 401 })
  }

  // Verify signature is over the record body (without signatures field)
  const { signatures: _sig, ...recordToSign } = room.gameRecord as Record<string, unknown>
  void _sig
  if (!await verifyRecordSignature(recordToSign, signature, publicKey)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  room.gameRecord.signatures[playerId] = signature
  await roomStore.setRoom(roomId.toLowerCase(), room)

  return NextResponse.json({
    success: true,
    signaturesCount: Object.keys(room.gameRecord.signatures).length,
  })
}
