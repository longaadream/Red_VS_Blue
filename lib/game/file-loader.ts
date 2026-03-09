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
function loadJsonFilesServerImpl<T>(directory: string): Record<string, T> {
  const result: Record<string, T> = {};
  
  // 只在服务器端执行
  if (typeof window !== 'undefined') {
    return result;
  }
  
  const { readdirSync, readFileSync, existsSync } = require('fs');
  const { join } = require('path');
  const dirPath = join(process.cwd(), directory);

  try {
    const files = readdirSync(dirPath, { withFileTypes: true });

    files.forEach((file: any) => {
      if (file.isFile() && file.name.endsWith('.json')) {
        const filePath = join(dirPath, file.name);

        try {
          const content = readFileSync(filePath, 'utf-8');

          try {
            const data = JSON.parse(content) as T;

            if (data && typeof data === 'object' && 'id' in data) {
              result[data.id as string] = data;
            }
          } catch (parseError) {
            console.error(`Error parsing JSON file ${file.name}:`, parseError);
          }
        } catch (readError) {
          console.error(`Error reading file ${file.name}:`, readError);
        }
      }
    });
  } catch (error) {
    console.error(`Error loading files from directory ${directory}:`, error);
  }

  return result;
}

// 导出函数
export function loadJsonFilesServer<T>(directory: string): Record<string, T> {
  return loadJsonFilesServerImpl<T>(directory);
}
