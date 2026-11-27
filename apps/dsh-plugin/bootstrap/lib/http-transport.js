import http from 'node:http'
import https from 'node:https'

const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 307, 308])

export class HttpTransportError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'HttpTransportError'
    this.code = code
    this.details = details
  }
}

function abortError(signal) {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' && reason ? reason : '请求已中止。')
  error.name = 'AbortError'
  return error
}

/**
 * Perform one bounded HTTP(S) GET with Node core transport. This avoids the
 * Node 24 global fetch/Undici close-FIN host crash while retaining explicit
 * truncation, size, timeout, and cancellation failures.
 */
export async function requestBounded(urlValue, {
  headers = {},
  maxBytes,
  timeoutMs = 60_000,
  signal,
  onData = () => undefined,
  acceptNotModified = false,
} = {}) {
  let url
  try {
    url = new URL(urlValue)
  } catch {
    throw new HttpTransportError('invalid-url', '下载地址不是有效 URL。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpTransportError('invalid-url', '下载地址必须使用 http 或 https。')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new HttpTransportError('invalid-limit', '下载大小上限无效。')
  }

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(abortError(signal))
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new HttpTransportError('request-timeout', '请求超时。'))
  }, timeoutMs)
  timer.unref?.()

  return await new Promise((resolve, reject) => {
    let settled = false
    let response
    let request

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
      controller.signal.removeEventListener('abort', onAbort)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined) {
        response?.destroy()
        request?.destroy()
        reject(error instanceof HttpTransportError
          ? error
          : new HttpTransportError('request-failed', error instanceof Error ? error.message : String(error)))
      } else {
        resolve(value)
      }
    }
    const onAbort = () => {
      const reason = controller.signal.reason
      finish(reason instanceof HttpTransportError
        ? reason
        : new HttpTransportError('request-aborted', abortError(controller.signal).message))
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) {
      onAbort()
      return
    }

    const transport = url.protocol === 'https:' ? https : http
    try {
      request = transport.request(url, {
        method: 'GET',
        headers: {
          accept: '*/*',
          connection: 'close',
          ...headers,
        },
      })
    } catch (error) {
      finish(error)
      return
    }
    request.on('error', finish)
    request.on('response', incoming => {
      response = incoming
      if (settled) {
        incoming.destroy()
        return
      }
      if (incoming.statusCode === 304 && acceptNotModified) {
        incoming.resume()
        finish(undefined, { status: 304, headers: incoming.headers, bytes: 0 })
        return
      }
      if (REDIRECT_STATUSES.has(incoming.statusCode)) {
        finish(new HttpTransportError('http-redirect', `服务器返回不允许的重定向 HTTP ${incoming.statusCode}。`))
        return
      }
      if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
        finish(new HttpTransportError('http-status', `服务器返回 HTTP ${incoming.statusCode}。`, {
          status: incoming.statusCode,
        }))
        return
      }
      const declaredLength = Number(incoming.headers['content-length'] ?? '0')
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        finish(new HttpTransportError('response-too-large', '服务器声明的响应大小超过限制。'))
        return
      }
      incoming.on('error', finish)
      incoming.on('aborted', () => {
        finish(new HttpTransportError('response-aborted', '服务器在响应完成前中止了连接。'))
      })
      void (async () => {
        let bytes = 0
        try {
          for await (const chunk of incoming) {
            if (settled) return
            const value = Buffer.from(chunk)
            bytes += value.byteLength
            if (bytes > maxBytes) {
              throw new HttpTransportError('response-too-large', '响应内容超过大小限制。')
            }
            await onData(value, bytes)
          }
          if (!incoming.complete) {
            throw new HttpTransportError('response-incomplete', '服务器返回的响应不完整。')
          }
          if (Number.isFinite(declaredLength) && declaredLength !== 0 && bytes !== declaredLength) {
            throw new HttpTransportError('response-incomplete', '服务器返回的字节数与 Content-Length 不一致。', {
              expected: declaredLength,
              actual: bytes,
            })
          }
          finish(undefined, {
            status: incoming.statusCode,
            headers: incoming.headers,
            bytes,
          })
        } catch (error) {
          finish(error)
        }
      })()
    })
    request.end()
  })
}

export async function readBoundedUrl(urlValue, options = {}) {
  const chunks = []
  const result = await requestBounded(urlValue, {
    ...options,
    onData: async chunk => { chunks.push(Buffer.from(chunk)) },
  })
  return { ...result, body: Buffer.concat(chunks, result.bytes) }
}
