// 客户端版本的文件加载器，通过API获取数据
export async function loadJsonFiles<T>(endpoint: string): Promise<Record<string, T>> {
  try {
    const response = await fetch(`/api/${endpoint}`)
    if (!response.ok) {
      throw new Error(`Failed to fetch ${endpoint}: ${response.status}`)
    }
    const data = await response.json() as Record<string, T>
    return data
  } catch (error) {
    console.error(`Error loading data from ${endpoint}:`, error)
    return {}
  }
}

// 服务器端版本的文件加载器，使用fs模块
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

export function loadJsonFilesServer<T>(directory: string): Record<string, T> {
  const result: Record<string, T> = {}
  const dirPath = join(process.cwd(), directory)
  
  try {
    console.log('Current working directory:', process.cwd())
    console.log('Loading files from directory:', dirPath)
    console.log('Directory exists:', require('fs').existsSync(dirPath))
    
    const files = readdirSync(dirPath, { withFileTypes: true })
    
    console.log('Found files:', files.map(f => f.name))
    
    files.forEach((file) => {
      if (file.isFile() && file.name.endsWith('.json')) {
        const filePath = join(dirPath, file.name)
        console.log('Loading file:', filePath)
        
        try {
          const content = readFileSync(filePath, 'utf-8')
          console.log('File content length:', content.length)
          
          try {
            const data = JSON.parse(content) as T
            console.log('Parsed data for', file.name, ':', data)
            
            if (data && typeof data === 'object' && 'id' in data) {
              result[data.id as string] = data
              console.log('Added skill:', data.id)
            } else {
              console.warn('File', file.name, 'does not have an id field')
            }
          } catch (parseError) {
            console.error(`Error parsing JSON file ${file.name}:`, parseError)
            console.error('File content:', content)
          }
        } catch (readError) {
          console.error(`Error reading file ${file.name}:`, readError)
        }
      }
    })
  } catch (error) {
    console.error(`Error loading files from directory ${directory}:`, error)
  }
  
  console.log('Final loaded skills:', Object.keys(result))
  return result
}
