import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db"

export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId")
  if (!playerId) {
    return NextResponse.json({ error: "playerId required" }, { status: 400 })
  }

  try {
    const records = await prisma.gameRecord.findMany({
      where: { playerId },
      orderBy: { createdAt: "desc" },
      take: 100,
    })

    const total = records.length
    const wins = records.filter(r => r.result === "win").length
    const losses = records.filter(r => r.result === "loss").length
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0

    return NextResponse.json({
      stats: { total, wins, losses, winRate },
      records: records.map(r => ({
        ...r,
        myPieces: JSON.parse(r.myPieces),
        opponentPieces: JSON.parse(r.opponentPieces),
      })),
    })
  } catch (error) {
    console.error("[GET /api/records]", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      playerId, playerName, opponentId, opponentName,
      result, turns, myPieces, opponentPieces, roomId, mapId,
    } = body

    if (!playerId || !result || turns == null) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    const record = await prisma.gameRecord.create({
      data: {
        playerId,
        playerName: playerName || playerId,
        opponentId: opponentId || null,
        opponentName: opponentName || null,
        result,
        turns,
        myPieces: JSON.stringify(myPieces || []),
        opponentPieces: JSON.stringify(opponentPieces || []),
        roomId: roomId || null,
        mapId: mapId || null,
      },
    })

    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    console.error("[POST /api/records]", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
