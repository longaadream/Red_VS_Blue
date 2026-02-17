import { PLAYER_STATS } from "@/config/game-menu"
import { Separator } from "@/components/ui/separator"

export function StatsBar() {
  return (
    <div className="flex items-center justify-center gap-6 rounded-lg border border-border bg-card px-6 py-3">
      {PLAYER_STATS.map((stat, i) => (
        <div key={stat.label} className="flex items-center gap-6">
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-sm font-bold text-foreground">
              {stat.value}
            </span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {stat.label}
            </span>
          </div>
          {i < PLAYER_STATS.length - 1 && (
            <Separator orientation="vertical" className="h-8" />
          )}
        </div>
      ))}
    </div>
  )
}
