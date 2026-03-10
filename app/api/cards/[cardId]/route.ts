import { NextResponse } from "next/server"
import { readFileSync } from "fs"
import { join } from "path"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
) {
  try {
    const { cardId } = await params
    const filePath = join(process.cwd(), "data", "cards", `${cardId}.json`)
    
    const content = readFileSync(filePath, "utf-8")
    const cardData = JSON.parse(content)
    
    return NextResponse.json(cardData)
  } catch {
    return NextResponse.json({ error: "Card not found" }, { status: 404 })
  }
}
