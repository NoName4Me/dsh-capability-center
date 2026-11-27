import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { imageSize } from 'image-size'
import { createWorker } from 'tesseract.js'

const maxBytes = 16 * 1024 * 1024
const maxPixels = 20_000_000

async function readImage(path) {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
      throw new Error('请选择不超过 16 MiB 的 PNG 或 JPEG 文件。')
    }
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size !== stat.size) throw new Error('识别期间图片发生变化，请重试。')
    const image = buffer.subarray(0, size)
    const { type, width, height } = imageSize(image)
    if (!['png', 'jpg'].includes(type)) throw new Error('仅支持 PNG 和 JPEG 图片。')
    if (!(width > 0 && height > 0 && width * height <= maxPixels)) {
      throw new Error('图片像素数超出 2000 万上限。')
    }
    return { image, width, height }
  } finally {
    await file.close()
  }
}

async function recognize(path) {
  const { image, width, height } = await readImage(path)
  const worker = await createWorker(['chi_sim', 'eng'], 1, {
    langPath: fileURLToPath(new URL('./tessdata', import.meta.url)),
    gzip: false,
    cacheMethod: 'none',
    errorHandler: error => parentPort.postMessage({ error: String(error) }),
  })
  try {
    const { data } = await worker.recognize(image, {}, { text: true, tsv: true })
    if (data.tsv.length > 4_000_000 || data.text.length > 1_000_000) {
      throw new Error('识别结果过大，请裁剪图片后重试。')
    }
    const words = []
    for (const row of data.tsv.split('\n')) {
      const fields = row.split('\t')
      if (fields[0] !== '5') continue
      const [left, top, width, height, confidence] = fields.slice(6, 11).map(Number)
      words.push({ text: fields.slice(11).join('\t'), left, top, width, height, confidence })
    }
    return { page: 1, source: 'ocr', width, height, text: data.text, words }
  } finally {
    await worker.terminate()
  }
}

try {
  parentPort.postMessage({ value: await recognize(workerData.path) })
} catch (error) {
  parentPort.postMessage({ error: error.message })
}
