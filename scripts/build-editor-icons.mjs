import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LayoutDashboard, Users, Zap, BookOpen, ListChecks, Map, Image, Package, ChevronDown, Undo2, Redo2, Shield } from 'lucide-react'
const destination = fileURLToPath(new URL('../electron-editor/ui/assets/icons/', import.meta.url))
mkdirSync(destination, { recursive: true })
for (const [name, Icon] of Object.entries({ workbench: LayoutDashboard, pieces: Users, skills: Zap, cards: BookOpen, rules: ListChecks, pve: Map, assets: Image, build: Package, undo: Undo2, redo: Redo2, statuses: Shield, 'chevron-down': ChevronDown })) {
  writeFileSync(destination + name + '.svg', renderToStaticMarkup(createElement(Icon, { size: 24, color: name === 'chevron-down' ? '#2d65c8' : '#526887', strokeWidth: 1.8 })) + '\n')
}
