'use client'

import { useState, useEffect } from 'react'
import { ChevronLeft } from 'lucide-react'

export default function MapEncyclopediaPage() {
  const [maps, setMaps] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch maps data
  useEffect(() => {
    const fetchMaps = async () => {
      try {
        setLoading(true)
        const response = await fetch('/api/maps')
        if (!response.ok) {
          throw new Error('Failed to fetch maps')
        }
        const data = await response.json()
        setMaps(data.maps || [])
        setError(null)
      } catch (err) {
        setError('Failed to load map data')
        console.error(err)
        // Fallback to mock data if API fails
        setMaps([
          {
            id: "arena-8x6",
            name: "小型竞技场",
            layout: [
              "########",
              "#..C..S#",
              "#..##..#",
              "#S.C..H#",
              "#......#",
              "########"
            ],
            legend: [
              {
                char: "#",
                type: "wall",
                walkable: false,
                bulletPassable: false
              },
              {
                char: ".",
                type: "floor",
                walkable: true,
                bulletPassable: true
              },
              {
                char: "C",
                type: "cover",
                walkable: true,
                bulletPassable: false
              }
            ]
          },
          {
            id: "large-arena",
            name: "大型竞技场",
            layout: [
              "##########",
              "#........#",
              "#.##..##.#",
              "#.##..##.#",
              "#........#",
              "#..C..C..#",
              "#........#",
              "#.##..##.#",
              "#.##..##.#",
              "#........#",
              "##########"
            ],
            legend: [
              {
                char: "#",
                type: "wall",
                walkable: false,
                bulletPassable: false
              },
              {
                char: ".",
                type: "floor",
                walkable: true,
                bulletPassable: true
              },
              {
                char: "C",
                type: "cover",
                walkable: true,
                bulletPassable: false
              }
            ]
          }
        ])
      } finally {
        setLoading(false)
      }
    }

    fetchMaps()
  }, [])

  // Render map layout
  const renderMapLayout = (layout: string[]) => {
    return (
      <div className="bg-gray-700 rounded p-4 font-mono text-sm">
        {layout.map((row, index) => (
          <div key={index} className="flex">
            {row.split('').map((cell, cellIndex) => (
              <div 
                key={cellIndex} 
                className={`w-6 h-6 flex items-center justify-center ${getCellClass(cell)}`}
                title={getCellTitle(cell)}
              >
                {cell}
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }

  // Get cell class based on type
  const getCellClass = (char: string) => {
    switch (char) {
      case '#': return 'bg-gray-900 text-gray-500';
      case '.': return 'bg-gray-600 text-gray-300';
      case 'C': return 'bg-green-900 text-green-400';
      case 'S': return 'bg-red-900 text-red-400';
      case 'H': return 'bg-blue-900 text-blue-400';
      default: return 'bg-gray-600 text-gray-300';
    }
  }

  // Get cell title based on type
  const getCellTitle = (char: string) => {
    switch (char) {
      case '#': return 'Wall - Not walkable';
      case '.': return 'Floor - Walkable';
      case 'C': return 'Cover - Walkable, provides protection';
      case 'S': return 'Spawn point';
      case 'H': return 'Health pickup';
      default: return 'Unknown';
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-xl">Loading map data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-xl text-red-500 mb-4">{error}</p>
          <button 
            className="px-4 py-2 bg-primary hover:bg-primary/80 rounded-md transition-colors duration-300"
            onClick={() => window.location.reload()}
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 text-white">
      {/* Header */}
      <header className="py-8 px-4">
        <div className="container mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-4xl font-bold mb-2">Map Encyclopedia</h1>
            <p className="text-gray-400">Explore all game maps</p>
          </div>
          <a 
            href="/encyclopedia" 
            className="flex items-center text-gray-400 hover:text-white transition-colors duration-300"
          >
            <ChevronLeft className="mr-1" size={20} />
            Back to Encyclopedia
          </a>
        </div>
      </header>

      {/* Map Grid */}
      <main className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-1 gap-8 max-w-4xl mx-auto">
          {maps.map((map) => (
            <div key={map.id} className="bg-gray-800 rounded-lg p-6 border border-gray-700 hover:border-primary transition-all duration-300">
              {/* Map Header */}
              <div className="mb-6">
                <h2 className="text-2xl font-semibold mb-2">{map.name}</h2>
                <div className="text-gray-400">ID: {map.id}</div>
              </div>

              {/* Map Layout */}
              <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Layout</h3>
                {renderMapLayout(map.layout)}
              </div>

              {/* Legend */}
              <div>
                <h3 className="text-lg font-semibold mb-3">Legend</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {map.legend.map((item: any, index: number) => (
                    <div key={index} className="bg-gray-700 rounded p-3">
                      <div className="flex items-center mb-2">
                        <div className={`w-6 h-6 flex items-center justify-center ${getCellClass(item.char)} mr-2`}>
                          {item.char}
                        </div>
                        <span className="font-medium">{item.type}</span>
                      </div>
                      <div className="text-xs text-gray-400">
                        Walkable: {item.walkable ? 'Yes' : 'No'}
                      </div>
                      <div className="text-xs text-gray-400">
                        Bullet Passable: {item.bulletPassable ? 'Yes' : 'No'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 px-4 text-center text-gray-500 text-sm">
        <p>Red vs Blue - Map Encyclopedia</p>
      </footer>
    </div>
  )
}
