import { BookOpen, Map } from "lucide-react"

export default function EncyclopediaPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 text-white">
      {/* Header */}
      <header className="py-8 px-4 text-center">
        <h1 className="text-4xl font-bold mb-2">Game Encyclopedia</h1>
        <p className="text-gray-400">Explore the world of Red vs Blue</p>
      </header>

      {/* Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {/* Character Encyclopedia Card */}
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700 hover:border-primary transition-all duration-300">
            <div className="flex items-center mb-4">
              <BookOpen className="text-primary mr-3" size={24} />
              <h2 className="text-2xl font-semibold">Character Encyclopedia</h2>
            </div>
            <p className="text-gray-400 mb-6">
              Browse through all available pieces, their stats, skills, and backgrounds.
            </p>
            <a 
              href="/encyclopedia/pieces" 
              className="inline-flex items-center px-4 py-2 bg-primary hover:bg-primary/80 rounded-md transition-colors duration-300"
            >
              Explore Characters
              <span className="ml-2">→</span>
            </a>
          </div>

          {/* Map Encyclopedia Card */}
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700 hover:border-primary transition-all duration-300">
            <div className="flex items-center mb-4">
              <Map className="text-primary mr-3" size={24} />
              <h2 className="text-2xl font-semibold">Map Encyclopedia</h2>
            </div>
            <p className="text-gray-400 mb-6">
              Discover all game maps, their layouts, and strategic points.
            </p>
            <a 
              href="/encyclopedia/maps" 
              className="inline-flex items-center px-4 py-2 bg-primary hover:bg-primary/80 rounded-md transition-colors duration-300"
            >
              Explore Maps
              <span className="ml-2">→</span>
            </a>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 px-4 text-center text-gray-500 text-sm">
        <p>Red vs Blue - Game Encyclopedia</p>
      </footer>
    </div>
  )
}