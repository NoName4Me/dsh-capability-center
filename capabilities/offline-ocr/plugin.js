import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recognizeImage } from './ocr.js'

export const name = 'capability-center-ocr'
export const inject = ['skills', 'tools']

const directory = dirname(fileURLToPath(import.meta.url))
const description = '在本机识别 PNG/JPEG 和扫描 PDF 中的简体中文或英文印刷文字。'

export function apply(ctx) {
  const lifetime = new AbortController()
  const skillPath = join(directory, 'SKILL.md')
  const content = readFileSync(skillPath, 'utf8')
  ctx.effect(() => ctx.skills.register({
    name: 'offline-ocr',
    description,
    content: content + '\n\n已安装的 OCR 脚本绝对路径：' + JSON.stringify(join(directory, 'cli.js')),
    path: skillPath,
    source: 'custom',
    provider: name,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
    invocation: { modelInvocable: true, userInvocable: true },
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'offline_ocr_check',
    description: '对插件内置的固定中英文图片运行离线文字识别自检。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
      render: () => [{ type: 'text', text: '离线 OCR 中英文自检通过。' }],
    },
    async execute(_args, execution) {
      const signal = execution?.signal
        ? AbortSignal.any([execution.signal, lifetime.signal])
        : lifetime.signal
      const result = await recognizeImage(join(directory, 'fixture.png'), { signal, timeout: 17_000 })
      const text = result.text.replace(/\s+/gu, '')
      if (!text.includes('离线文字识别OCR2026') || !text.includes('Invoice12345')
        || !result.words.some(word => word.text === 'Invoice' && word.confidence >= 0 && word.width > 0)) {
        throw new Error('内置图片未返回预期的中英文或坐标。')
      }
      return { ready: true }
    },
  }))
  ctx.on('dispose', () => lifetime.abort())
}
