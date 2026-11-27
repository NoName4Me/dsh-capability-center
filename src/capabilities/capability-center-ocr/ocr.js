import { Worker } from 'node:worker_threads'

export async function recognizeImage(path, { signal, timeout = 90_000 } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  signal.throwIfAborted()
  const worker = new Worker(new URL('./worker.js', import.meta.url), { execArgv: [], workerData: { path } })
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', ({ value, error }) => {
        if (error !== undefined) reject(new Error(error))
        else resolve(value)
      })
      worker.once('error', reject)
      worker.once('exit', code => {
        signal.removeEventListener('abort', abort)
        reject(new Error(`OCR 进程提前退出（${code}）。`))
      })
    })
  } finally {
    await worker.terminate()
  }
}
