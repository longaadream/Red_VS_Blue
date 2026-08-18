type RouteMethod = 'GET' | 'POST' | 'DELETE'

type RouteContext = {
  req: {
    json<T>(): Promise<T>
    param(name: string): string
    header(name: string): string | undefined
  }
  json(body: unknown, status?: number): Response
}

type RouteHandler = (context: RouteContext) => Response | Promise<Response>

type RegisteredRoute = {
  method: RouteMethod
  path: string
  handler: RouteHandler
}

function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]
    const actual = pathParts[index]
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual)
      continue
    }
    if (expected !== actual) return null
  }
  return params
}

/**
 * Minimal HTTP-compatible Hono harness used only by Vitest. It executes the
 * real Relay route callbacks while the standalone Relay package remains an
 * independently installed Bun application.
 */
export class Hono {
  private readonly routes: RegisteredRoute[] = []

  private register(method: RouteMethod, path: string, handler: RouteHandler): this {
    this.routes.push({ method, path, handler })
    return this
  }

  get(path: string, handler: RouteHandler): this {
    return this.register('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): this {
    return this.register('POST', path, handler)
  }

  delete(path: string, handler: RouteHandler): this {
    return this.register('DELETE', path, handler)
  }

  async request(input: string | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request
      ? input
      : new Request(new URL(input, 'http://relay.test'), init)
    const pathname = new URL(request.url).pathname
    for (const route of this.routes) {
      if (route.method !== request.method) continue
      const params = matchRoute(route.path, pathname)
      if (!params) continue
      return route.handler({
        req: {
          json: <T>() => request.json() as Promise<T>,
          param: name => params[name] ?? '',
          header: name => request.headers.get(name) ?? undefined,
        },
        json: (body, status = 200) => Response.json(body, { status }),
      })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }
}
