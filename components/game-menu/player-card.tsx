import { PLAYER_INFO } from "@/config/game-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Progress } from "@/components/ui/progress"

export function PlayerCard() {
  const { name, rank, level, xpCurrent, xpMax, avatarFallback } = PLAYER_INFO
  const xpPercent = Math.round((xpCurrent / xpMax) * 100)

  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
      <Avatar className="h-12 w-12 border-2 border-primary/40">
        <AvatarFallback className="bg-primary/20 text-primary text-sm font-bold">
          {avatarFallback}
        </AvatarFallback>
      </Avatar>

      <div className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-foreground">{name}</span>
          <span className="text-xs font-medium text-primary">{rank}</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-muted-foreground">
            {"LVL " + level}
          </span>
          <Progress value={xpPercent} className="h-1.5 flex-1" />
          <span className="text-[10px] text-muted-foreground">
            {xpCurrent.toLocaleString() + " / " + xpMax.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  )
}
