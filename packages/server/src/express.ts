/**
 * Express / NestJS(platform-express) 适配器。
 *
 * 只依赖 req/res 的结构，不 import express —— 避免在不用 express 的宿主里引入依赖，
 * 也避免与宿主的 express 版本冲突。
 */
type ExpressLikeRequest = {
  method: string
  originalUrl?: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  /** 未被 body parser 消费时，直接读流。 */
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

    // body-parser 已消费时用 req.body；否则读原始流
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
