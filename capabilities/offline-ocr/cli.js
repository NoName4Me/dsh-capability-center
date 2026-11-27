import { resolve } from 'node:path'
import { recognizeImage } from './ocr.js'

try {
  const [, , input, format = 'json'] = process.argv
  if (!input || !['json', 'text'].includes(format) || process.argv.length > 4) {
    throw new Error('用法：node cli.js <图片路径> [json|text]')
  }
  const result = await recognizeImage(resolve(input))
  process.stdout.write(format === 'text' ? result.text : JSON.stringify(result) + '\n')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
