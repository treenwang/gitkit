/**
 * Adapter for Express and NestJS (platform-express).
 *
 * It depends on the shape of req/res only and never imports express, which
 * avoids pulling in a dependency for hosts that do not use it and avoids
 * clashing with the host's express version.
 */
type ExpressLikeRequest = {
  method: string
  originalUrl?: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  /** Read the raw stream when no body parser has consumed it. */
  readable?: boolean
  on?: (event: string, cb: (chunk?: unknown) => void) => void
}

type ExpressLikeResponse = {
  status: (code: number) => ExpressLikeResponse
  set: (headers: Record<string, string>) => ExpressLikeResponse
  send: (body: string) => void
}

export function toExpress(
  handler: (req: Request) => Promise<Response>,
): (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<void> {
  return async (req, res) => {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) headers.set(k, v.join(', '))
    }

    // Use req.body when body-parser consumed it, otherwise read the raw stream
    const body =
      req.body !== undefined && req.body !== null
        ? typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body)
        : await readStream(req)

    const url = `http://localhost${req.originalUrl ?? req.url}`
    const init: RequestInit = { method: req.method, headers }
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body

    const response = await handler(new Request(url, init))
    const text = await response.text()

    const out: Record<string, string> = {}
    response.headers.forEach((value, key) => { out[key] = value })
    res.status(response.status).set(out).send(text)
  }
}

function readStream(req: ExpressLikeRequest): Promise<string> {
  const on = req.on
  if (!on) return Promise.resolve('')
  return new Promise((resolve) => {
    const chunks: string[] = []
    on.call(req, 'data', (c) => chunks.push(String(c)))
    on.call(req, 'end', () => resolve(chunks.join('')))
    on.call(req, 'error', () => resolve(''))
  })
}
