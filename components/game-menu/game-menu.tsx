"use client"

import { GAME_BRAND, MENU_ITEMS } from "@/config/game-menu"
import { MenuButton } from "./menu-button"
import { PlayerCard } from "./player-card"
import { AnimatedBackground } from "./animated-background"

export function GameMenu() {
  const visibleItems = MENU_ITEMS.filter((item) => item.enabled)

  return (
    <>
      <AnimatedBackground />

      <main className="relative flex min-h-svh flex-col items-center justify-center px-4 py-12">
        {/* Logo / brand */}
        <header className="mb-10 flex flex-col items-center gap-2 text-center">
          <h1 className="text-5xl font-black tracking-tighter sm:text-6xl">
            <span className="text-red-500">{GAME_BRAND.title.split(' ')[0]}</span>
            {GAME_BRAND.title.includes(' ') && <span className="ml-2">{GAME_BRAND.title.split(' ')[1]}</span>}
            <span className="ml-2 text-primary">{GAME_BRAND.subtitle.split(' ')[0]}</span>
            <span className="ml-2 text-blue-500">{GAME_BRAND.subtitle.split(' ')[1]}</span>
          </h1>
          <p className="text-sm tracking-widest uppercase text-muted-foreground">
            {GAME_BRAND.tagline}
          </p>
        </header>

        {/* Content card */}
        <div className="w-full max-w-md space-y-6">
          {/* Player card */}
          <PlayerCard />

          {/* Menu buttons */}
          <nav className="flex flex-col gap-2" aria-label="Game menu">
            {visibleItems.map((item, index) => (
              <MenuButton key={item.id} item={item} index={index} />
            ))}
          </nav>
        </div>

        {/* Version tag */}
        <p className="mt-8 text-xs text-muted-foreground">
          {GAME_BRAND.version}
        </p>
      </main>
    </>
  )
}
