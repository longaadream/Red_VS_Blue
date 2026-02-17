import {
  Swords,
  Target,
  Settings,
  Trophy,
  Users,
  LogOut,
  type LucideIcon,
} from "lucide-react"

// ============================================================
// GAME MENU CONFIGURATION
// Modify this file to change all menu content and appearance.
// ============================================================

/** Game branding */
export const GAME_BRAND = {
  title: "NEXUS",
  subtitle: "ARENA",
  tagline: "Dominate the battlefield",
  version: "v1.0.2",
}

/** Menu item definition */
export interface MenuItem {
  id: string
  label: string
  description: string
  icon: LucideIcon
  href: string
  /** "primary" gets the accent color, "default" is the standard style */
  variant: "primary" | "default"
  /** Whether to show this item */
  enabled: boolean
}

/** All menu items – reorder, add or remove entries freely */
export const MENU_ITEMS: MenuItem[] = [
  {
    id: "play",
    label: "Play",
    description: "Join a match",
    icon: Swords,
    href: "/play",
    variant: "primary",
    enabled: true,
  },
  {
    id: "practice",
    label: "Practice Arena",
    description: "Hone your skills",
    icon: Target,
    href: "/practice",
    variant: "primary",
    enabled: true,
  },
  {
    id: "ranked",
    label: "Ranked",
    description: "Competitive matches",
    icon: Trophy,
    href: "/ranked",
    variant: "default",
    enabled: true,
  },
  {
    id: "social",
    label: "Social",
    description: "Friends & clans",
    icon: Users,
    href: "/social",
    variant: "default",
    enabled: true,
  },
  {
    id: "settings",
    label: "Settings",
    description: "Game options",
    icon: Settings,
    href: "/settings",
    variant: "default",
    enabled: true,
  },
  {
    id: "quit",
    label: "Quit",
    description: "Exit to desktop",
    icon: LogOut,
    href: "/quit",
    variant: "default",
    enabled: true,
  },
]

/** Player card shown in the sidebar */
export const PLAYER_INFO = {
  name: "Player_One",
  rank: "Diamond II",
  level: 42,
  xpCurrent: 7200,
  xpMax: 10000,
  avatarFallback: "P1",
}

/** Stats displayed in the bottom bar */
export interface StatItem {
  label: string
  value: string
}

export const PLAYER_STATS: StatItem[] = [
  { label: "Wins", value: "314" },
  { label: "K/D", value: "2.7" },
  { label: "Matches", value: "1,028" },
  { label: "Hours", value: "482" },
]
