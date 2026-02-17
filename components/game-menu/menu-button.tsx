"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"
import type { MenuItem } from "@/config/game-menu"

interface MenuButtonProps {
  item: MenuItem
  index: number
}

export function MenuButton({ item, index }: MenuButtonProps) {
  const Icon = item.icon

  return (
    <Link
      href={item.href}
      className={cn(
        "group relative flex items-center gap-4 rounded-lg px-5 py-4 text-left transition-all duration-200",
        "border outline-none focus-visible:ring-2 focus-visible:ring-ring",
        item.variant === "primary"
          ? "border-primary/30 bg-primary/10 hover:bg-primary/20 hover:border-primary/60"
          : "border-border bg-card hover:bg-secondary hover:border-muted-foreground/30"
      )}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {/* Icon */}
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors",
          item.variant === "primary"
            ? "bg-primary/20 text-primary group-hover:bg-primary/30"
            : "bg-secondary text-muted-foreground group-hover:text-foreground"
        )}
      >
        <Icon className="h-5 w-5" />
      </span>

      {/* Text */}
      <div className="flex flex-col gap-0.5">
        <span
          className={cn(
            "text-sm font-semibold tracking-wide",
            item.variant === "primary" ? "text-primary" : "text-foreground"
          )}
        >
          {item.label}
        </span>
        <span className="text-xs text-muted-foreground">
          {item.description}
        </span>
      </div>

      {/* Hover indicator */}
      <span
        className={cn(
          "ml-auto h-1.5 w-1.5 rounded-full transition-opacity",
          item.variant === "primary" ? "bg-primary" : "bg-muted-foreground",
          "opacity-0 group-hover:opacity-100"
        )}
      />
    </Link>
  )
}
