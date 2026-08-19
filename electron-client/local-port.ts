import * as nodeNet from 'node:net'

const PORT_PROBE_HOST = '0.0.0.0'

export function findFreePort(start: number): Promise<number> {
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    return Promise.reject(new RangeError(`Invalid TCP port: ${start}`))
  }

  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(findFreePort(start + 1))
        return
      }
      reject(error)
    })

    server.listen({
      port: start,
      host: PORT_PROBE_HOST,
      exclusive: true,
    }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to resolve the selected local TCP port.'))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}
