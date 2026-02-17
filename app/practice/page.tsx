"use client"

import Link from "next/link"
import { ArrowLeft, Target, Crosshair, Flame, Clock } from "lucide-react"

const PRACTICE_MODES = [
  {
    id: "aim-trainer",
    label: "Aim Trainer",
    description: "Sharpen your precision with moving targets",
    icon: Crosshair,
  },
  {
    id: "reflex",
    label: "Reflex Drill",
    description: "Test your reaction speed under pressure",
    icon: Flame,
  },
  {
    id: "timed-run",
    label: "Timed Run",
    description: "Complete the course as fast as you can",
    icon: Clock,
  },
  {
    id: "free-roam",
    label: "Free Roam",
    description: "Explore the arena at your own pace",
    icon: Target,
  },
]

export default function PracticePage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Menu
        </Link>

        <header className="space-y-1">
          <h1 className="text-3xl font-black tracking-tight text-foreground">
            Practice <span className="text-primary">Arena</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Choose a practice mode to sharpen your skills
          </p>
        </header>

        <nav className="flex flex-col gap-2" aria-label="Practice modes">
          {PRACTICE_MODES.map((mode) => {
            const Icon = mode.icon
            return (
              <button
                key={mode.id}
                className="group flex items-center gap-4 rounded-lg border border-border bg-card px-5 py-4 text-left transition-all hover:border-primary/40 hover:bg-primary/5"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground transition-colors group-hover:bg-primary/20 group-hover:text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-foreground">
                    {mode.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {mode.description}
                  </span>
                </div>
              </button>
            )
          })}
        </nav>
      </div>
    </main>
  )
}
