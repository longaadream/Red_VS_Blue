import * as nodeNet from 'node:net'

const PORT_PROBE_HOSTS = ['0.0.0.0', '127.0.0.1'] as const

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false)
        return
      }
      reject(error)
    })

    server.listen({
      port,
      host,
      exclusive: true,
    }, () => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(true)
      })
    })
  })
}

async function isPortAvailable(port: number): Promise<boolean> {
  for (const host of PORT_PROBE_HOSTS) {
    if (!await canBind(port, host)) {
      return false
    }
  }
  return true
}

export async function findFreePort(start: number): Promise<number> {
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    throw new RangeError(`Invalid TCP port: ${start}`)
  }

  for (let port = start; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      return port
    }
  }

  throw new RangeError(`No available TCP port at or above ${start}.`)
}
