import { inflateRawSync } from 'node:zlib'

const MAX_FILES = 512
const MAX_UNPACKED_BYTES = 48 * 1024 * 1024
const MAX_FILE_BYTES = 12 * 1024 * 1024

export class ArchiveError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

export function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 300
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.startsWith('/')
    && !/^[a-zA-Z]:/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function entriesOf(bytes, maxFileBytes, maxUnpackedBytes, maxFiles) {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ArchiveError('invalid-archive', '制品不是 ZIP 格式。')
  }
  let eocd = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new ArchiveError('invalid-archive', 'ZIP 缺少中央目录。')
  const count = bytes.readUInt16LE(eocd + 10)
  const directorySize = bytes.readUInt32LE(eocd + 12)
  const directoryOffset = bytes.readUInt32LE(eocd + 16)
  if (count === 0 || count > maxFiles || directoryOffset + directorySize > bytes.length) {
    throw new ArchiveError('invalid-archive', 'ZIP 文件数量或中央目录越界。')
  }
  const result = []
  const names = new Set()
  let cursor = directoryOffset
  let unpacked = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ArchiveError('invalid-archive', 'ZIP 中央目录损坏。')
    }
    const madeBy = bytes.readUInt16LE(cursor + 4)
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const checksum = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const externalAttributes = bytes.readUInt32LE(cursor + 38)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) {
      throw new ArchiveError('invalid-archive', 'ZIP 使用了加密或不支持的压缩方式。')
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if ((madeBy >>> 8) === 3 && ((externalAttributes >>> 16) & 0o170000) === 0o120000) {
      throw new ArchiveError('unsafe-archive', `ZIP 包含符号链接：${name}`)
    }
    if (!name || (!name.endsWith('/') && !safeRelativePath(name))
      || (name.endsWith('/') && !safeRelativePath(name.slice(0, -1)))) {
      throw new ArchiveError('unsafe-archive', `ZIP 包含不安全路径：${name}`)
    }
    if (names.has(name.toLowerCase())) throw new ArchiveError('invalid-archive', `ZIP 包含重复路径：${name}`)
    names.add(name.toLowerCase())
    if (size > maxFileBytes) throw new ArchiveError('archive-too-large', `ZIP 文件过大：${name}`)
    unpacked += size
    if (unpacked > maxUnpackedBytes) throw new ArchiveError('archive-too-large', 'ZIP 解压后体积过大。')
    result.push({ name, method, checksum, compressedSize, size, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return result
}

export function readZip(bytes, { maxFileBytes = MAX_FILE_BYTES, maxUnpackedBytes = MAX_UNPACKED_BYTES, maxFiles = MAX_FILES } = {}) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new ArchiveError('invalid-archive', 'ZIP 单文件上限无效。')
  }
  const files = new Map()
  for (const entry of entriesOf(bytes, maxFileBytes, maxUnpackedBytes, maxFiles)) {
    if (entry.name.endsWith('/')) continue
    const offset = entry.localOffset
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) {
      throw new ArchiveError('invalid-archive', `ZIP 本地头损坏：${entry.name}`)
    }
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + nameLength + extraLength
    const end = start + entry.compressedSize
    if (end > bytes.length) throw new ArchiveError('invalid-archive', `ZIP 数据越界：${entry.name}`)
    const compressed = bytes.subarray(start, end)
    let content
    try {
      content = entry.size === 0
        ? Buffer.alloc(0)
        : entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: entry.size })
    } catch {
      throw new ArchiveError('invalid-archive', `ZIP 解压失败：${entry.name}`)
    }
    if (content.byteLength !== entry.size || crc32(content) !== entry.checksum) {
      throw new ArchiveError('invalid-archive', `ZIP 校验失败：${entry.name}`)
    }
    files.set(entry.name, content)
  }
  return files
}
