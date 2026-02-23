"use client"

// 测试所有导入
import { GameMenu } from "@/components/game-menu/game-menu"
import { MenuButton } from "@/components/game-menu/menu-button"
import { PlayerCard } from "@/components/game-menu/player-card"
import { AnimatedBackground } from "@/components/game-menu/animated-background"

// 测试 UI 组件导入
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"

// 测试配置导入
import { GAME_BRAND, MENU_ITEMS } from "@/config/game-menu"

export default function TestImports() {
  // 检查所有导入是否为 undefined
  const imports = {
    GameMenu: typeof GameMenu,
    MenuButton: typeof MenuButton,
    PlayerCard: typeof PlayerCard,
    AnimatedBackground: typeof AnimatedBackground,
    Button: typeof Button,
    Card: typeof Card,
    CardContent: typeof CardContent,
    CardHeader: typeof CardHeader,
    CardTitle: typeof CardTitle,
    Avatar: typeof Avatar,
    AvatarFallback: typeof AvatarFallback,
    Progress: typeof Progress,
    Separator: typeof Separator,
    GAME_BRAND: typeof GAME_BRAND,
    MENU_ITEMS: typeof MENU_ITEMS,
  }

  // 检查是否有 undefined
  const undefinedImports = Object.entries(imports)
    .filter(([_, value]) => value === 'undefined')
    .map(([key, _]) => key)

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Import Test</h1>
      
      {undefinedImports.length > 0 ? (
        <div className="text-red-500 mb-4">
          <h2 className="font-bold">Undefined Imports:</h2>
          <ul>
            {undefinedImports.map(name => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="text-green-500 mb-4">
          All imports are defined!
        </div>
      )}

      <pre className="bg-gray-100 p-4 rounded">
        {JSON.stringify(imports, null, 2)}
      </pre>

      <div className="mt-8">
        <h2 className="font-bold mb-2">Testing Components:</h2>
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-500">Button:</p>
            {Button ? <Button>Test Button</Button> : <span className="text-red-500">undefined</span>}
          </div>
          <div>
            <p className="text-sm text-gray-500">Card:</p>
            {Card ? (
              <Card>
                <CardHeader>
                  <CardTitle>Test Card</CardTitle>
                </CardHeader>
                <CardContent>Content</CardContent>
              </Card>
            ) : <span className="text-red-500">undefined</span>}
          </div>
          <div>
            <p className="text-sm text-gray-500">Avatar:</p>
            {Avatar ? (
              <Avatar>
                <AvatarFallback>AB</AvatarFallback>
              </Avatar>
            ) : <span className="text-red-500">undefined</span>}
          </div>
          <div>
            <p className="text-sm text-gray-500">Separator:</p>
            {Separator ? <Separator /> : <span className="text-red-500">undefined</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
