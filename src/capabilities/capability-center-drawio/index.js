import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { atomicWriteJson, readJson } from './atomic.js'

const BOARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CELL_ID = /^[A-Za-z0-9_.:@-]{1,512}$/u
const MAX_XML_BYTES = 4 * 1024 * 1024
const MAX_SELECTION_CELLS = 512
const TOOL_NAMES = [
  'drawio_create',
  'drawio_get_selection',
  'drawio_get_diagram',
  'drawio_edit',
  'drawio_open',
]
const STYLE_PROPERTIES = new Set([
  'fillColor',
  'strokeColor',
  'fontColor',
  'strokeWidth',
  'strokeStyle',
  'fillStyle',
  'dashed',
  'rounded',
  'opacity',
  'fontSize',
  'fontFamily',
  'fontStyle',
  'textAlign',
  'verticalAlign',
  'align',
  'verticalLabelPosition',
  'labelPosition',
  'shape',
  'arcSize',
  'shadow',
  'glass',
  'sketch',
  'fillOpacity',
  'strokeOpacity',
  'spacing',
  'spacingLeft',
  'spacingRight',
  'edgeStyle',
  'startArrow',
  'endArrow',
  'startFill',
  'endFill',
  'startSize',
  'endSize',
  'html',
])

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function canvasError(code, message, status = 409, details) {
  return Object.assign(new Error(message), { code, status, details })
}

function boundedText(value, name, maximum, { empty = false } = {}) {
  if (typeof value !== 'string') throw canvasError('invalid-input', `${name} 必须是字符串。`, 400)
  const text = value.trim()
  if ((!empty && text === '') || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw canvasError('invalid-input', `${name} 长度或字符无效。`, 400)
  }
  return text
}

function boundedIdentifier(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw canvasError('invalid-input', `${name} 必须是 1 至 512 个安全字符。`, 400)
  }
  return value
}

function finiteInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw canvasError('invalid-input', `${name} 必须是 ${minimum} 至 ${maximum} 之间的整数。`, 400)
  }
  return value
}

function safeCellId(value, name = 'cellId') {
  if (typeof value !== 'string' || !CELL_ID.test(value)) {
    throw canvasError('invalid-input', `${name} 无效。`, 400)
  }
  return value
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function xmlUnescape(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function attributesOf(tag) {
  const attributes = new Map()
  const expression = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu
  for (const match of tag.matchAll(expression)) {
    attributes.set(match[1], xmlUnescape(match[2] ?? match[3] ?? ''))
  }
  return attributes
}

function serializeAttribute(name, value) {
  return `${name}="${xmlEscape(value)}"`
}

function replaceAttribute(tag, name, value) {
  const expression = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`, 'u')
  if (expression.test(tag)) {
    return tag.replace(expression, (_match, prefix) => `${prefix}"${xmlEscape(value)}"`)
  }
  const close = tag.endsWith('/>') ? '/>' : '>'
  return `${tag.slice(0, -close.length)} ${serializeAttribute(name, value)}${close}`
}

function pageRange(xml, requestedPageId) {
  let pageId = requestedPageId
  for (const match of xml.matchAll(/<diagram\b[^>]*>/gu)) {
    const attributes = attributesOf(match[0])
    const candidate = attributes.get('id')
    if (pageId === undefined || candidate === pageId) {
      const start = match.index + match[0].length
      const end = xml.indexOf('</diagram>', start)
      if (end < 0) throw canvasError('invalid-diagram', '图稿页面缺少结束标签。', 400)
      if (pageId === undefined) pageId = candidate
      return {
        pageId,
        pageName: attributes.get('name') ?? 'Page-1',
        start,
        end,
      }
    }
  }
  throw canvasError('unknown-page', `图稿中不存在页面 ${requestedPageId ?? ''}。`, 404)
}

function normalizedStyle(value, name = 'style') {
  if (value === '') return ''
  const style = boundedText(value, name, 2_048)
  if (style.includes(';') || style.includes('=')) {
    throw canvasError('invalid-style', `${name} 不能包含分号或等号。`, 400)
  }
  return style
}

const NODE_STYLE = 'rounded=1;arcSize=12;whiteSpace=wrap;html=1;shadow=0;glass=0;sketch=0;'
  + 'strokeWidth=1.2;spacing=10;fontStyle=0;'
const EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=blockThin;endFill=1;'

const VISUAL_THEMES = Object.freeze({
  editorial: Object.freeze({
    background: '#FAFAF8',
    roles: Object.freeze({
      process: 'fillColor=#FFFDF8;strokeColor=#A8A29E;fontColor=#1C1917;fontSize=14;',
      start: 'rounded=1;arcSize=50;fillColor=#1F2933;strokeColor=#1F2933;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      end: 'rounded=1;arcSize=50;fillColor=#1F2933;strokeColor=#1F2933;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      decision: 'shape=rhombus;fillColor=#FFF7E5;strokeColor=#B99A5B;fontColor=#3F321D;fontSize=14;',
      outcome: 'fillColor=#F1F7F4;strokeColor=#78978A;fontColor=#1F3B31;fontSize=14;',
      warning: 'fillColor=#FFF4F0;strokeColor=#C47C6B;fontColor=#5B2C24;fontSize=14;',
      note: 'dashed=1;fillColor=#F8F7F3;strokeColor=#B7B1A7;fontColor=#57534E;fontSize=13;',
    }),
    edge: 'strokeColor=#7C746C;fontColor=#57534E;labelBackgroundColor=#FAFAF8;fontSize=12;',
  }),
  technical: Object.freeze({
    background: '#F7F9FC',
    roles: Object.freeze({
      process: 'fillColor=#FFFFFF;strokeColor=#94A3B8;fontColor=#0F172A;fontSize=14;',
      start: 'rounded=1;arcSize=50;fillColor=#0F172A;strokeColor=#0F172A;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      end: 'rounded=1;arcSize=50;fillColor=#0F172A;strokeColor=#0F172A;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      decision: 'shape=rhombus;fillColor=#ECFEFF;strokeColor=#0891B2;fontColor=#164E63;fontSize=14;',
      outcome: 'fillColor=#EFF6FF;strokeColor=#60A5FA;fontColor=#1E3A8A;fontSize=14;',
      warning: 'fillColor=#FFF1F2;strokeColor=#FB7185;fontColor=#881337;fontSize=14;',
      note: 'dashed=1;fillColor=#F8FAFC;strokeColor=#CBD5E1;fontColor=#475569;fontSize=13;',
    }),
    edge: 'strokeColor=#64748B;fontColor=#475569;labelBackgroundColor=#F7F9FC;fontSize=12;',
  }),
  warm: Object.freeze({
    background: '#FCFAF7',
    roles: Object.freeze({
      process: 'fillColor=#FFFDFC;strokeColor=#C4A68D;fontColor=#3F2E24;fontSize=14;',
      start: 'rounded=1;arcSize=50;fillColor=#5B3A29;strokeColor=#5B3A29;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      end: 'rounded=1;arcSize=50;fillColor=#5B3A29;strokeColor=#5B3A29;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      decision: 'shape=rhombus;fillColor=#FFF2DF;strokeColor=#C98645;fontColor=#573418;fontSize=14;',
      outcome: 'fillColor=#F1F7EF;strokeColor=#83A07A;fontColor=#294327;fontSize=14;',
      warning: 'fillColor=#FCEFEB;strokeColor=#C97C69;fontColor=#622F25;fontSize=14;',
      note: 'dashed=1;fillColor=#FAF6F0;strokeColor=#CBB8A6;fontColor=#5F5148;fontSize=13;',
    }),
    edge: 'strokeColor=#8D6E5A;fontColor=#5F4A3D;labelBackgroundColor=#FCFAF7;fontSize=12;',
  }),
  monochrome: Object.freeze({
    background: '#F8F8F7',
    roles: Object.freeze({
      process: 'fillColor=#FFFFFF;strokeColor=#8C8C88;fontColor=#20201E;fontSize=14;',
      start: 'rounded=1;arcSize=50;fillColor=#252523;strokeColor=#252523;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      end: 'rounded=1;arcSize=50;fillColor=#252523;strokeColor=#252523;fontColor=#FFFFFF;fontSize=14;fontStyle=1;',
      decision: 'shape=rhombus;fillColor=#F1F1EE;strokeColor=#6B6B66;fontColor=#252523;fontSize=14;',
      outcome: 'fillColor=#EFEFEC;strokeColor=#777772;fontColor=#252523;fontSize=14;',
      warning: 'fillColor=#F4F0EE;strokeColor=#927B70;fontColor=#473832;fontSize=14;',
      note: 'dashed=1;fillColor=#F4F4F1;strokeColor=#A3A39E;fontColor=#4F4F4A;fontSize=13;',
    }),
    edge: 'strokeColor=#74746F;fontColor=#52524D;labelBackgroundColor=#F8F8F7;fontSize=12;',
  }),
})

const NODE_ROLES = new Set(Object.keys(VISUAL_THEMES.editorial.roles))
const LEGACY_DRAWIO_FILLS = new Map([
  ['#dae8fc', ['#F4F7FA', '#7790A8', '#24384B']],
  ['#d5e8d4', ['#F3F7F2', '#7C9A7F', '#263A2A']],
  ['#e1d5e7', ['#F6F2F7', '#8E7A97', '#392C3D']],
  ['#fff2cc', ['#FBF6E9', '#B3985E', '#483A20']],
  ['#f8cecc', ['#FCF1EE', '#BE7F73', '#512E28']],
])

function resolveVisualTheme(value) {
  if (value === undefined || value === '' || value === 'auto') return 'editorial'
  if (typeof value === 'string' && Object.hasOwn(VISUAL_THEMES, value)) return value
  throw canvasError('invalid-visual-theme', 'visualTheme 必须是 auto、editorial、technical、warm 或 monochrome。', 400)
}

function inferredNodeRole(node) {
  if (typeof node.role === 'string' && NODE_ROLES.has(node.role)) return node.role
  const label = String(node.label ?? '')
  if (/^(开始|起点|输入)/u.test(label)) return 'start'
  if (/^(结束|终点|完成|项目落地)$/u.test(label)) return 'end'
  if (/是否|能否|可否|判断|决策|卡口/u.test(label)) return 'decision'
  if (/通过|完成|成功|归档|落地/u.test(label)) return 'outcome'
  if (/退回|驳回|失败|终止|异常|放弃/u.test(label)) return 'warning'
  if (/说明|备注|图例/u.test(label)) return 'note'
  return 'process'
}

function setStyleProperty(style, name, value) {
  const expression = new RegExp(`(^|;)${name}=([^;]*)`, 'iu')
  if (expression.test(style)) return style.replace(expression, `$1${name}=${value}`)
  return `${style}${style === '' || style.endsWith(';') ? '' : ';'}${name}=${value};`
}

function refineLegacyDrawioPalette(style) {
  const fill = /(?:^|;)fillColor=(#[0-9a-f]{6})(?:;|$)/iu.exec(style)?.[1]?.toLowerCase()
  const replacement = fill === undefined ? undefined : LEGACY_DRAWIO_FILLS.get(fill)
  if (replacement === undefined) return style
  let refined = setStyleProperty(style, 'fillColor', replacement[0])
  refined = setStyleProperty(refined, 'strokeColor', replacement[1])
  refined = setStyleProperty(refined, 'fontColor', replacement[2])
  return refined
}

function diagramNodeStyle(node, { visualTheme = 'auto', preserveDrawioPalette = false } = {}) {
  const theme = VISUAL_THEMES[resolveVisualTheme(visualTheme)]
  const custom = node.style === undefined ? '' : boundedText(node.style, `${node.id}.style`, 2_048, { empty: true })
  if (custom !== '') {
    const styled = preserveDrawioPalette ? custom : refineLegacyDrawioPalette(custom)
    return NODE_STYLE + styled
  }
  return NODE_STYLE + theme.roles[inferredNodeRole(node)]
}

function diagramEdgeStyle(edge, { visualTheme = 'auto', preserveDrawioPalette = false } = {}) {
  const theme = VISUAL_THEMES[resolveVisualTheme(visualTheme)]
  const custom = edge.style === undefined ? '' : boundedText(edge.style, `${edge.id}.style`, 2_048, { empty: true })
  if (custom === '') return EDGE_STYLE + theme.edge
  const styled = preserveDrawioPalette ? custom : refineLegacyDrawioPalette(custom)
  return EDGE_STYLE + styled
}

const CELL_DEFINITION = /<mxCell\b(?:[^>"']|"[^"]*"|'[^']*')*\/>|<mxCell\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/mxCell>|<object\b[^>]*>[\s\S]*?<\/object>|<UserObject\b[^>]*>[\s\S]*?<\/UserObject>/gu

function definitionInfo(full) {
  const wrapper = /^<(object|UserObject)\b[^>]*>/u.exec(full)
  if (wrapper !== null) {
    const outer = attributesOf(wrapper[0])
    const innerMatch = /<mxCell\b[^>]*>/u.exec(full)
    const inner = innerMatch === null ? new Map() : attributesOf(innerMatch[0])
    const id = outer.get('id') ?? inner.get('id')
    return {
      id,
      wrapped: true,
      labelAttribute: 'label',
      edge: inner.get('edge') === '1',
      source: outer.get('source') ?? inner.get('source'),
      target: outer.get('target') ?? inner.get('target'),
      parent: outer.get('parent') ?? inner.get('parent'),
    }
  }
  const outer = attributesOf(full)
  return {
    id: outer.get('id'),
    wrapped: false,
    labelAttribute: 'value',
    edge: outer.get('edge') === '1',
    source: outer.get('source'),
    target: outer.get('target'),
    parent: outer.get('parent'),
  }
}

function replaceTagAttribute(full, tagExpression, name, value) {
  const match = tagExpression.exec(full)
  if (match === null) throw canvasError('invalid-diagram', '图元缺少可更新的开始标签。', 400)
  return `${full.slice(0, match.index)}${replaceAttribute(match[0], name, value)}`
    + full.slice(match.index + match[0].length)
}

function nodeCellXml(node, existingIds = new Set(), styleOptions = {}) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw canvasError('invalid-input', '节点操作无效。', 400)
  }
  const id = safeCellId(node.id, 'node.id')
  if (id === '0' || id === '1' || existingIds.has(id)) {
    throw canvasError('duplicate-cell', `图元 ID ${id} 已存在或保留了根 ID。`, 409)
  }
  const label = boundedText(node.label ?? '', 'node.label', 8_000, { empty: true })
  const x = finiteInteger(node.x, `${id}.x`, { minimum: -1_000_000, maximum: 1_000_000 })
  const y = finiteInteger(node.y, `${id}.y`, { minimum: -1_000_000, maximum: 1_000_000 })
  const width = finiteInteger(node.width ?? 160, `${id}.width`, { minimum: 1, maximum: 100_000 })
  const height = finiteInteger(node.height ?? 80, `${id}.height`, { minimum: 1, maximum: 100_000 })
  const style = diagramNodeStyle({ ...node, id, label }, styleOptions)
  return `<mxCell id="${xmlEscape(id)}" value="${xmlEscape(label)}" style="${xmlEscape(style)}" `
    + `vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`
}

function edgeCellXml(edge, existingIds = new Set(), styleOptions = {}) {
  if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) {
    throw canvasError('invalid-input', '连线操作无效。', 400)
  }
  const id = safeCellId(edge.id, 'edge.id')
  const source = safeCellId(edge.source, `${id}.source`)
  const target = safeCellId(edge.target, `${id}.target`)
  if (id === '0' || id === '1' || existingIds.has(id)) {
    throw canvasError('duplicate-cell', `连线 ID ${id} 已存在或保留了根 ID。`, 409)
  }
  if (!existingIds.has(source) || !existingIds.has(target)) {
    throw canvasError('unknown-endpoint', `连线 ${id} 的 source 或 target 不存在。`, 404)
  }
  const label = boundedText(edge.label ?? '', `${id}.label`, 8_000, { empty: true })
  const style = diagramEdgeStyle({ ...edge, id }, styleOptions)
  return `<mxCell id="${xmlEscape(id)}" value="${xmlEscape(label)}" style="${xmlEscape(style)}" `
    + `edge="1" parent="1" source="${xmlEscape(source)}" target="${xmlEscape(target)}">`
    + '<mxGeometry relative="1" as="geometry"/></mxCell>'
}

function definitions(body) {
  return [...body.matchAll(CELL_DEFINITION)].map(match => ({
    full: match[0],
    ...definitionInfo(match[0]),
  })).filter(definition => typeof definition.id === 'string')
}

function normalizeCompressedDiagram(xml) {
  return xml.replace(/(<diagram\b[^>]*>)([\s\S]*?)(<\/diagram>)/gu, (full, open, body, close) => {
    const encoded = body.trim()
    if (encoded === '' || encoded.startsWith('<')) return full
    try {
      const uriDecoded = decodeURIComponent(encoded.replace(/\s/gu, ''))
      const inflated = inflateRawSync(Buffer.from(uriDecoded, 'base64'), {
        maxOutputLength: MAX_XML_BYTES,
      }).toString('utf8')
      const decoded = decodeURIComponent(inflated)
      if (!decoded.includes('<mxGraphModel')) throw new Error('missing model')
      return `${open}${decoded}${close}`
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|larger than/iu.test(messageOf(error))) {
        throw canvasError('invalid-diagram', '压缩页面解码后超过 4 MiB。', 413)
      }
      throw canvasError('unsupported-diagram-encoding', 'draw.io 页面既不是未压缩 XML，也不是可解码的压缩页面。', 400)
    }
  })
}

function normalizeOperations(operations) {
  if (operations === undefined) return []
  if (!Array.isArray(operations) || operations.length > 200) {
    throw canvasError('invalid-input', 'operations 必须是最多 200 个结构变更。', 400)
  }
  return operations.map(operation => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      throw canvasError('invalid-input', 'operations 中存在无效变更。', 400)
    }
    if (!['add_node', 'add_edge', 'remove_cell'].includes(operation.kind)) {
      throw canvasError('unsupported-operation', '结构变更仅支持 add_node、add_edge 和 remove_cell。', 400)
    }
    return { ...operation }
  })
}

function transformPage(body, {
  cellIds = [],
  sets = [],
  operations = [],
  visualTheme = 'auto',
  preserveDrawioPalette = false,
}) {
  let next = body
  const before = definitions(next)
  const currentIds = new Set(before.map(cell => cell.id))

  if (cellIds.length > 0) {
    const targets = new Set(cellIds.map((id, index) => safeCellId(id, `cellIds[${index}]`)))
    if (targets.has('0') || targets.has('1')) {
      throw canvasError('protected-cell', '不能修改 draw.io 根图元。', 400)
    }
    const normalized = normalizeSets(sets)
    if (normalized.length > 0) {
      const found = new Set()
      next = next.replace(CELL_DEFINITION, full => {
        const info = definitionInfo(full)
        if (info.id === undefined || !targets.has(info.id)) return full
        found.add(info.id)
        let changed = full
        const label = normalized.find(item => item.name === 'label')
        if (label !== undefined) {
          changed = replaceTagAttribute(
            changed,
            info.wrapped ? /^<(?:object|UserObject)\b[^>]*>/u : /^<mxCell\b[^>]*>/u,
            info.labelAttribute,
            label.value,
          )
        }
        const styleChanges = normalized.filter(item => item.name !== 'label')
        if (styleChanges.length > 0) {
          const inner = /<mxCell\b[^>]*>/u.exec(changed)?.[0] ?? changed
          const rawStyle = attributesOf(inner).get('style') ?? ''
          changed = replaceTagAttribute(
            changed,
            /<mxCell\b[^>]*>/u,
            'style',
            updateStyle(rawStyle, styleChanges.map(item => [item.name, item.value])),
          )
        }
        return changed
      })
      const missing = [...targets].filter(id => !found.has(id))
      if (missing.length > 0) {
        throw canvasError('unknown-cell', `当前页面不存在图元：${missing.join(', ')}。`, 404, { cellIds: missing })
      }
    } else if (sets.length > 0) {
      throw canvasError('invalid-input', 'sets 非空但没有可应用的属性。', 400)
    }
  } else if (sets.length > 0) {
    throw canvasError('invalid-input', '提供 sets 时必须同时提供 cellIds。', 400)
  }

  for (const operation of operations) {
    if (operation.kind === 'add_node') {
      const xml = nodeCellXml(operation, currentIds, { visualTheme, preserveDrawioPalette })
      currentIds.add(operation.id)
      const close = next.lastIndexOf('</root>')
      if (close < 0) throw canvasError('invalid-diagram', '当前页面缺少根节点。', 400)
      next = `${next.slice(0, close)}${xml}${next.slice(close)}`
      continue
    }
    if (operation.kind === 'add_edge') {
      const xml = edgeCellXml(operation, currentIds, { visualTheme, preserveDrawioPalette })
      currentIds.add(operation.id)
      const close = next.lastIndexOf('</root>')
      if (close < 0) throw canvasError('invalid-diagram', '当前页面缺少根节点。', 400)
      next = `${next.slice(0, close)}${xml}${next.slice(close)}`
      continue
    }
    const removeId = safeCellId(operation.id, 'remove_cell.id')
    if (removeId === '0' || removeId === '1' || !currentIds.has(removeId)) {
      throw canvasError('unknown-cell', `当前页面不存在要删除的图元 ${removeId}。`, 404)
    }
    const removed = new Set([removeId])
    let changed = true
    while (changed) {
      changed = false
      for (const definition of definitions(next)) {
        if (!removed.has(definition.id)
          && (removed.has(definition.parent)
            || (definition.edge
              && (removed.has(definition.source) || removed.has(definition.target))))) {
          removed.add(definition.id)
          changed = true
        }
      }
    }
    next = next.replace(CELL_DEFINITION, full => {
      const info = definitionInfo(full)
      return removed.has(info.id) ? '' : full
    })
    for (const id of removed) currentIds.delete(id)
  }
  for (const definition of definitions(next)) {
    for (const [name, value] of [
      ['parent', definition.parent],
      ...(definition.edge ? [['source', definition.source], ['target', definition.target]] : []),
    ]) {
      if (value === undefined || value === '0' || value === '1') continue
      if (!currentIds.has(value)) {
        throw canvasError(
          'dangling-reference',
          `图元 ${definition.id} 的 ${name} 引用了不存在的图元 ${value}。`,
          409,
          { cellId: definition.id, reference: name, target: value },
        )
      }
    }
  }
  return next
}

function updateStyle(raw, changes) {
  const segments = raw.split(';')
  const remaining = new Map(changes)
  const next = segments.map((segment, index) => {
    const equals = segment.indexOf('=')
    if (equals < 0) return segment
    const key = segment.slice(0, equals)
    if (!remaining.has(key)) return segment
    const value = remaining.get(key)
    remaining.delete(key)
    return `${key}=${value}${index === segments.length - 1 && raw.endsWith(';') ? ';' : ''}`
  })
  for (const [key, value] of remaining) {
    if (next.length > 0 && next.at(-1) === '') next.splice(-1, 1)
    next.push(`${key}=${value}`)
  }
  return next.join(';')
}

function normalizeSets(sets) {
  if (!Array.isArray(sets) || sets.length === 0 || sets.length > 32) {
    throw canvasError('invalid-input', 'sets 必须包含 1 至 32 个属性更新。', 400)
  }
  const result = []
  const seen = new Set()
  for (const item of sets) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw canvasError('invalid-input', 'sets 中存在无效更新。', 400)
    }
    const name = typeof item.name === 'string' ? item.name : ''
    if (name !== 'label' && !STYLE_PROPERTIES.has(name)) {
      throw canvasError('unsupported-style', `不支持更新属性 ${name || '(empty)'}。`, 400)
    }
    if (seen.has(name)) throw canvasError('invalid-input', `属性 ${name} 重复。`, 400)
    seen.add(name)
    const value = name === 'label'
      ? boundedText(item.value, 'label', 8_000, { empty: true })
      : normalizedStyle(item.value, name)
    result.push({ name, value })
  }
  return result
}

export function createDiagramXml({
  title,
  description = '',
  pageId,
  pageName,
  nodes,
  edges = [],
  visualTheme = 'auto',
  preserveDrawioPalette = false,
  now = new Date().toISOString(),
}) {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 200) {
    throw canvasError('invalid-input', 'nodes 必须包含 1 至 200 个图元。', 400)
  }
  if (!Array.isArray(edges) || edges.length > 400) {
    throw canvasError('invalid-input', 'edges 必须是数组且最多 400 条。', 400)
  }
  const resolvedTheme = resolveVisualTheme(visualTheme)
  const theme = VISUAL_THEMES[resolvedTheme]
  const ids = new Set()
  const nodeIds = new Set()
  const nodeXml = nodes.map(node => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw canvasError('invalid-input', 'nodes 中存在无效图元。', 400)
    }
    const id = safeCellId(node.id, 'node.id')
    if (id === '0' || id === '1' || ids.has(id)) {
      throw canvasError('duplicate-cell', `图元 ID ${id} 重复或保留了根 ID。`, 400)
    }
    ids.add(id)
    nodeIds.add(id)
    const label = boundedText(node.label ?? '', 'node.label', 8_000, { empty: true })
    const x = finiteInteger(node.x, `${id}.x`, { minimum: -1_000_000, maximum: 1_000_000 })
    const y = finiteInteger(node.y, `${id}.y`, { minimum: -1_000_000, maximum: 1_000_000 })
    const width = finiteInteger(node.width ?? 160, `${id}.width`, { minimum: 1, maximum: 100_000 })
    const height = finiteInteger(node.height ?? 80, `${id}.height`, { minimum: 1, maximum: 100_000 })
    const style = diagramNodeStyle({ ...node, id, label }, { visualTheme: resolvedTheme, preserveDrawioPalette })
    return `<mxCell id="${xmlEscape(id)}" value="${xmlEscape(label)}" style="${xmlEscape(style)}" `
      + `vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`
  })
  const edgeXml = edges.map(edge => {
    if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) {
      throw canvasError('invalid-input', 'edges 中存在无效连线。', 400)
    }
    const id = safeCellId(edge.id, 'edge.id')
    if (id === '0' || id === '1' || ids.has(id)) {
      throw canvasError('duplicate-cell', `连线 ID ${id} 重复或保留了根 ID。`, 400)
    }
    ids.add(id)
    const source = safeCellId(edge.source, `${id}.source`)
    const target = safeCellId(edge.target, `${id}.target`)
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      throw canvasError('unknown-endpoint', `连线 ${id} 的 source 或 target 不存在。`, 400)
    }
    const label = boundedText(edge.label ?? '', `${id}.label`, 8_000, { empty: true })
    const style = diagramEdgeStyle({ ...edge, id }, { visualTheme: resolvedTheme, preserveDrawioPalette })
    return `<mxCell id="${xmlEscape(id)}" value="${xmlEscape(label)}" style="${xmlEscape(style)}" `
      + `edge="1" parent="1" source="${xmlEscape(source)}" target="${xmlEscape(target)}">`
      + '<mxGeometry relative="1" as="geometry"/></mxCell>'
  })
  return `<mxfile host="capability-center" modified="${xmlEscape(now)}" agent="capability-center">`
    + `<diagram id="${xmlEscape(pageId)}" name="${xmlEscape(pageName)}">`
    + '<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" '
    + 'connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="1600" pageHeight="1200" '
    + `background="${xmlEscape(theme.background)}" math="0" shadow="0">`
    + '<root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + nodeXml.join('')
    + edgeXml.join('')
    + '</root></mxGraphModel></diagram></mxfile>'
    + (description === '' ? '' : '')
}

export function updateDiagramCells(xml, {
  pageId,
  cellIds = [],
  sets = [],
  operations = [],
  visualTheme = 'auto',
  preserveDrawioPalette = false,
}) {
  if (typeof xml !== 'string' || xml === '' || Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    throw canvasError('invalid-diagram', '图稿 XML 为空或超过 4 MiB。', 400)
  }
  if (!Array.isArray(cellIds) || cellIds.length > 200) {
    throw canvasError('invalid-input', 'cellIds 必须是最多 200 个图元。', 400)
  }
  if (!Array.isArray(sets) || sets.length > 32) {
    throw canvasError('invalid-input', 'sets 必须是属性更新数组。', 400)
  }
  const normalizedOperations = normalizeOperations(operations)
  if (cellIds.length === 0 && sets.length === 0 && normalizedOperations.length === 0) {
    throw canvasError('invalid-input', 'drawio_edit 需要 sets 或 operations。', 400)
  }
  const normalizedXml = normalizeCompressedDiagram(xml)
  if (Buffer.byteLength(normalizedXml, 'utf8') > MAX_XML_BYTES) {
    throw canvasError('invalid-diagram', '解码后的图稿 XML 超过 4 MiB。', 400)
  }
  const page = pageRange(normalizedXml, pageId)
  const body = normalizedXml.slice(page.start, page.end)
  const updated = transformPage(body, {
    cellIds,
    sets,
    operations: normalizedOperations,
    visualTheme,
    preserveDrawioPalette,
  })
  return {
    xml: `${normalizedXml.slice(0, page.start)}${updated}${normalizedXml.slice(page.end)}`,
    pageId: page.pageId,
    pageName: page.pageName,
  }
}

function sessionHash(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex')
}

function outputSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

const BOARD_PROPERTIES = {
  boardId: { type: 'string' },
  sessionId: { type: 'string' },
  revision: { type: 'integer' },
  pageId: { type: 'string' },
  pageName: { type: 'string' },
  title: { type: 'string' },
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function boardMeta(value) {
  return {
    boardId: value.boardId,
    sessionId: value.sessionId,
    revision: value.revision,
    pageId: value.pageId,
    pageName: value.pageName,
    title: value.title,
  }
}

function executionSession(exec) {
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId.trim() === ''
    || sessionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw canvasError('session-required', '工具执行缺少可信的会话绑定。', 403)
  }
  return sessionId
}

export class DrawioCanvasService {
  constructor({
    dataRoot,
    now = () => new Date().toISOString(),
    createId = randomUUID,
  }) {
    this.dataRoot = dataRoot
    this.now = now
    this.createId = createId
    this.root = join(dataRoot, 'drawio')
    this.boardsRoot = join(this.root, 'boards')
    this.sessionsRoot = join(this.root, 'sessions')
    this.locks = new Map()
  }

  async initialize() {
    await mkdir(this.boardsRoot, { recursive: true })
    await mkdir(this.sessionsRoot, { recursive: true })
  }

  boardPath(boardId) {
    if (typeof boardId !== 'string' || !BOARD_ID.test(boardId)) {
      throw canvasError('unknown-board', '画板 ID 无效。', 404)
    }
    return join(this.boardsRoot, `${boardId}.json`)
  }

  activePath(sessionId) {
    return join(this.sessionsRoot, `${sessionHash(sessionId)}.json`)
  }

  async withLock(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const queued = previous.then(() => gate)
    this.locks.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(key) === queued) this.locks.delete(key)
    }
  }

  async readBoard(boardId) {
    const board = await readJson(this.boardPath(boardId))
    if (board === undefined || board.boardId !== boardId || typeof board.xml !== 'string') {
      throw canvasError('unknown-board', '画布不存在。', 404)
    }
    return board
  }

  async writeBoard(board) {
    await atomicWriteJson(this.boardPath(board.boardId), board)
    return board
  }

  assertOwner(board, sessionId) {
    if (board.sessionId !== sessionId) {
      throw canvasError('board-session-mismatch', '画板不属于当前会话。', 403)
    }
  }

  clientBoard(board) {
    return {
      boardId: board.boardId,
      sessionId: board.sessionId,
      revision: board.revision,
      pageId: board.pageId,
      pageName: board.pageName,
      title: board.title,
      description: board.description,
      xml: board.xml,
      selection: board.selection,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    }
  }

  toolResult(board, extra = {}) {
    return {
      boardId: board.boardId,
      sessionId: board.sessionId,
      revision: board.revision,
      pageId: board.pageId,
      pageName: board.pageName,
      title: board.title,
      ...extra,
    }
  }

  async createBoard(sessionId, args) {
    const owner = boundedIdentifier(sessionId, 'sessionId')
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw canvasError('invalid-input', '创建参数必须是对象。', 400)
    }
    const title = boundedText(args.title, 'title', 200)
    const description = args.description === undefined
      ? ''
      : boundedText(args.description, 'description', 4_000, { empty: true })
    return await this.withLock(`session:${sessionHash(owner)}`, async () => {
      const boardId = this.createId()
      if (!BOARD_ID.test(boardId)) throw canvasError('invalid-board-id', '画板 ID 生成器返回了无效值。', 500)
      const pageId = `page-${this.createId()}`
      const pageName = title
      const createdAt = this.now()
      const xml = createDiagramXml({
        title,
        description,
        pageId,
        pageName,
        nodes: args.nodes,
        edges: args.edges ?? [],
        visualTheme: args.visualTheme,
        preserveDrawioPalette: args.preserveDrawioPalette === true,
        now: createdAt,
      })
      const board = {
        schemaVersion: 1,
        boardId,
        sessionId: owner,
        title,
        description,
        pageId,
        pageName,
        revision: 1,
        xml,
        selection: {
          cellIds: [],
          cells: [],
          selectedAt: null,
        },
        createdAt,
        updatedAt: createdAt,
      }
      await this.writeBoard(board)
      await atomicWriteJson(this.activePath(owner), {
        schemaVersion: 1,
        sessionId: owner,
        boardId,
        updatedAt: createdAt,
      })
      return this.toolResult(board)
    })
  }

  async activateBoard(sessionId, boardId) {
    const owner = boundedIdentifier(sessionId, 'sessionId')
    const board = await this.readBoard(boardId)
    this.assertOwner(board, owner)
    return await this.withLock(`session:${sessionHash(owner)}`, async () => {
      await atomicWriteJson(this.activePath(owner), {
        schemaVersion: 1,
        sessionId: owner,
        boardId: board.boardId,
        updatedAt: this.now(),
      })
      return this.toolResult(board)
    })
  }

  async resolveBoard(sessionId, requestedBoardId) {
    const owner = boundedIdentifier(sessionId, 'sessionId')
    if (requestedBoardId !== undefined) {
      const board = await this.readBoard(requestedBoardId)
      this.assertOwner(board, owner)
      return board
    }
    const active = await readJson(this.activePath(owner))
    if (active?.boardId !== undefined) {
      try {
        const board = await this.readBoard(active.boardId)
        this.assertOwner(board, owner)
        return board
      } catch (error) {
        if (error?.code !== 'unknown-board') throw error
      }
    }
    const names = (await readdir(this.boardsRoot)).filter(name => name.endsWith('.json'))
    const boards = []
    for (const name of names) {
      try {
        const board = await readJson(join(this.boardsRoot, name))
        if (board?.sessionId === owner) boards.push(board)
      } catch {
        // Another interrupted write must not make this session unusable.
      }
    }
    boards.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))
      || String(right.boardId).localeCompare(String(left.boardId)))
    if (boards[0] === undefined) {
      throw canvasError('no-board', '当前会话还没有画板，请先调用 drawio_create。', 404)
    }
    await atomicWriteJson(this.activePath(owner), {
      schemaVersion: 1,
      sessionId: owner,
      boardId: boards[0].boardId,
      updatedAt: this.now(),
    })
    return boards[0]
  }

  async getBoard(sessionId, args = {}) {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw canvasError('invalid-input', '参数必须是对象。', 400)
    }
    return this.clientBoard(await this.resolveBoard(sessionId, args.boardId))
  }

  async getDiagram(sessionId, args = {}) {
    const board = await this.resolveBoard(sessionId, args.boardId)
    const page = pageRange(board.xml, args.pageId ?? board.pageId)
    return this.toolResult(board, {
      pageId: page.pageId,
      pageName: page.pageName,
      xml: board.xml,
    })
  }

  async getSelection(sessionId, args = {}) {
    const board = await this.resolveBoard(sessionId, args?.boardId)
    return this.toolResult(board, {
      selection: board.selection ?? { cellIds: [], cells: [], selectedAt: null },
    })
  }

  async openBoard(sessionId, args = {}) {
    const board = await this.resolveBoard(sessionId, args?.boardId)
    return await this.activateBoard(sessionId, board.boardId)
  }

  async updateSelection({
    boardId,
    sessionId,
    revision,
    pageId,
    cells,
  }) {
    return await this.withLock(boardId, async () => {
      const board = await this.readBoard(boardId)
      this.assertOwner(board, sessionId)
      finiteInteger(revision, 'revision', { minimum: 1 })
      if (revision !== board.revision) {
        throw canvasError(
          'revision-conflict',
          `画板已从修订 ${revision} 更新到 ${board.revision}，请刷新后重试。`,
          409,
          { currentRevision: board.revision },
        )
      }
      if (pageId !== board.pageId) {
        throw canvasError('unknown-page', '选区来自其他页面，已拒绝写入。', 409, { pageId: board.pageId })
      }
      if (!Array.isArray(cells) || cells.length > MAX_SELECTION_CELLS) {
        throw canvasError('invalid-selection', '选区必须是最多 512 个图元的数组。', 400)
      }
      const normalized = []
      const ids = new Set()
      for (const [index, cell] of cells.entries()) {
        if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) {
          throw canvasError('invalid-selection', `cells[${index}] 无效。`, 400)
        }
        const id = safeCellId(cell.id, `cells[${index}].id`)
        if (ids.has(id)) continue
        ids.add(id)
        normalized.push({
          id,
          type: cell.type === 'edge' ? 'edge' : 'vertex',
          label: typeof cell.label === 'string' ? cell.label.slice(0, 8_000) : '',
          ...(typeof cell.source === 'string' && CELL_ID.test(cell.source) ? { source: cell.source } : {}),
          ...(typeof cell.target === 'string' && CELL_ID.test(cell.target) ? { target: cell.target } : {}),
          ...(typeof cell.parent === 'string' && CELL_ID.test(cell.parent) ? { parent: cell.parent } : {}),
        })
      }
      board.selection = {
        cellIds: normalized.map(cell => cell.id),
        cells: normalized,
        selectedAt: this.now(),
      }
      board.updatedAt = board.selection.selectedAt
      await this.writeBoard(board)
      return this.toolResult(board, { selection: board.selection })
    })
  }

  async saveBoard({
    boardId,
    sessionId,
    expectedRevision,
    xml,
    pageId,
    pageName,
  }) {
    return await this.withLock(boardId, async () => {
      const board = await this.readBoard(boardId)
      this.assertOwner(board, sessionId)
      finiteInteger(expectedRevision, 'expectedRevision', { minimum: 1 })
      if (expectedRevision !== board.revision) {
        throw canvasError(
          'revision-conflict',
          `画板已从修订 ${expectedRevision} 更新到 ${board.revision}，未覆盖较新的修改。`,
          409,
          { currentRevision: board.revision },
        )
      }
      if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
        throw canvasError('invalid-diagram', '图稿 XML 为空或超过 4 MiB。', 400)
      }
      const normalizedXml = normalizeCompressedDiagram(xml)
      if (Buffer.byteLength(normalizedXml, 'utf8') > MAX_XML_BYTES) {
        throw canvasError('invalid-diagram', '解码后的图稿 XML 超过 4 MiB。', 400)
      }
      const page = pageRange(normalizedXml, pageId ?? board.pageId)
      board.xml = normalizedXml
      board.pageId = page.pageId
      board.pageName = pageName === undefined
        ? page.pageName
        : boundedText(pageName, 'pageName', 200)
      board.revision += 1
      board.updatedAt = this.now()
      await this.writeBoard(board)
      return this.clientBoard(board)
    })
  }

  async editBoard(sessionId, args) {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw canvasError('invalid-input', '编辑参数必须是对象。', 400)
    }
    const resolved = await this.resolveBoard(sessionId, args.boardId)
    return await this.withLock(resolved.boardId, async () => {
      const board = await this.readBoard(resolved.boardId)
      this.assertOwner(board, sessionId)
      finiteInteger(args.expectedRevision, 'expectedRevision', { minimum: 1 })
      if (args.expectedRevision !== board.revision) {
        throw canvasError(
          'revision-conflict',
          `画板已从修订 ${args.expectedRevision} 更新到 ${board.revision}，未写入任何图元。`,
          409,
          { currentRevision: board.revision },
        )
      }
      const edited = updateDiagramCells(board.xml, {
        pageId: args.pageId,
        cellIds: args.cellIds ?? [],
        sets: args.sets ?? [],
        operations: args.operations ?? [],
        visualTheme: args.visualTheme,
        preserveDrawioPalette: args.preserveDrawioPalette === true,
      })
      board.xml = edited.xml
      board.pageId = edited.pageId
      board.pageName = edited.pageName
      board.revision += 1
      board.updatedAt = this.now()
      await this.writeBoard(board)
      const changedCellIds = new Set(args.cellIds ?? [])
      for (const operation of args.operations ?? []) {
        if (typeof operation?.id === 'string') changedCellIds.add(operation.id)
      }
      return this.toolResult(board, {
        changedCellIds: [...changedCellIds],
      })
    })
  }

  toolDefinitions() {
    const boardInput = {
      boardId: { type: 'string', description: '画板 UUID；省略时使用当前会话最近创建的画板。' },
    }
    const boardIdOnly = outputSchema(BOARD_PROPERTIES, Object.keys(BOARD_PROPERTIES))
    return [
      {
        name: 'drawio_create',
        description: '用户要在对话里绘图时，直接用此工具生成可编辑画板。先确定一套明确的视觉方向，再绘制结构与样式。'
          + '用户指定风格或颜色的部分最高优先级；否则根据主题、受众和场景选择 visualTheme：金融、法律、战略流程用 editorial，技术架构用 technical，'
          + '教育或生活主题用 warm，黑白报告用 monochrome。禁止使用 draw.io 默认蓝色 #dae8fc、绿色 #d5e8d4、紫色 #e1d5e7、黄色 #fff2cc、红色 #f8cecc。'
          + '默认由服务端按 role 套用高级配色；只有用户明确要求具体颜色或自定义风格确有必要时才传 style，并将 preserveDrawioPalette 设为 true。'
          + '通过 role 标记 start、end、process、decision、outcome、warning、note。保持同级节点等宽、主干对齐、留白充足，异常或回退分支放到两侧并减少交叉。'
          + '完成后宿主会添加画布卡片。'
          + '正文只简述结果，可提示点击下方“打开画布”。画布入口由宿主提供，请勿输出文件路径、Markdown 链接或另存副本来充当入口。',
        parameters: outputSchema({
          title: { type: 'string' },
          description: { type: 'string' },
          visualTheme: {
            type: 'string',
            enum: ['auto', 'editorial', 'technical', 'warm', 'monochrome'],
            description: '根据主题主动选择视觉方向；auto 使用克制的 editorial 默认方案。',
          },
          preserveDrawioPalette: {
            type: 'boolean',
            description: '仅在用户明确要求 draw.io 标准配色或精确颜色时设为 true。',
          },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                role: {
                  type: 'string',
                  enum: ['start', 'end', 'process', 'decision', 'outcome', 'warning', 'note'],
                },
                style: { type: 'string' },
              },
              required: ['id', 'label', 'x', 'y'],
              additionalProperties: false,
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                source: { type: 'string' },
                target: { type: 'string' },
                label: { type: 'string' },
                style: { type: 'string' },
              },
              required: ['id', 'source', 'target'],
              additionalProperties: false,
            },
          },
        }, ['title', 'nodes']),
        output: {
          schema: boardIdOnly,
          render: renderJson,
          presentationMeta: (_args, value) => boardMeta(value),
        },
        execute: async (args, exec) => await this.createBoard(executionSession(exec), args),
      },
      {
        name: 'drawio_get_selection',
        description: '读取当前会话绑定画板的实时选区。返回稳定的 cellIds、类型、标签和当前 revision。capability-center-drawio 的 pre-step context 会提供发送前选区；先核对 boardId、revision 和 ID，再更新图元。',
        parameters: outputSchema(boardInput),
        output: {
          schema: outputSchema({
            ...BOARD_PROPERTIES,
            selection: {
              type: 'object',
              properties: {
                cellIds: { type: 'array', items: { type: 'string' } },
                cells: { type: 'array', items: { type: 'object' } },
                selectedAt: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'null' },
                  ],
                },
              },
              required: ['cellIds', 'cells', 'selectedAt'],
              additionalProperties: false,
            },
          }, [...Object.keys(BOARD_PROPERTIES), 'selection']),
          render: renderJson,
          presentationMeta: (_args, value) => boardMeta(value),
        },
        execute: async (args, exec) => await this.getSelection(executionSession(exec), args),
        isConcurrencySafe: () => true,
      },
      {
        name: 'drawio_get_diagram',
        description: '读取当前会话绑定画板的完整 draw.io XML、页面和 revision。用于手工编辑后重新读取原图。',
        parameters: outputSchema({
          ...boardInput,
          pageId: { type: 'string', description: '可选页面 ID；省略时读取画板活动页。' },
        }),
        output: {
          schema: outputSchema({
            ...BOARD_PROPERTIES,
            xml: { type: 'string' },
          }, [...Object.keys(BOARD_PROPERTIES), 'xml']),
          render: renderJson,
          presentationMeta: (_args, value) => boardMeta(value),
        },
        execute: async (args, exec) => await this.getDiagram(executionSession(exec), args),
        isConcurrencySafe: () => true,
      },
      {
        name: 'drawio_edit',
        description: '按稳定 cellIds 或结构变更原子修改同一张原图。sets 更新标签和 draw.io 样式；operations 可新增步骤、新增或删除连线、删除节点。'
          + '新增节点时沿用画板视觉语言，优先传 role 和 visualTheme，不要回退到 draw.io 默认粉彩色。用户明确要求具体颜色时才覆盖样式。'
          + '优先使用 capability-center-drawio pre-step context，并调用 drawio_get_selection 核对；必须传该画板的 expectedRevision。过期修订、跨会话画板或未知图元会失败且不写盘。',
        parameters: outputSchema({
          ...boardInput,
          expectedRevision: { type: 'integer' },
          pageId: { type: 'string' },
          visualTheme: {
            type: 'string',
            enum: ['auto', 'editorial', 'technical', 'warm', 'monochrome'],
          },
          preserveDrawioPalette: { type: 'boolean' },
          cellIds: { type: 'array', items: { type: 'string' } },
          sets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  enum: ['label', ...STYLE_PROPERTIES],
                },
                value: { type: 'string' },
              },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['add_node', 'add_edge', 'remove_cell'] },
                id: { type: 'string' },
                label: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                role: {
                  type: 'string',
                  enum: ['start', 'end', 'process', 'decision', 'outcome', 'warning', 'note'],
                },
                style: { type: 'string' },
                source: { type: 'string' },
                target: { type: 'string' },
              },
              required: ['kind', 'id'],
              additionalProperties: false,
            },
          },
        }, ['expectedRevision', 'pageId']),
        output: {
          schema: outputSchema({
            ...BOARD_PROPERTIES,
            changedCellIds: { type: 'array', items: { type: 'string' } },
          }, [...Object.keys(BOARD_PROPERTIES), 'changedCellIds']),
          render: renderJson,
          presentationMeta: (_args, value) => boardMeta(value),
        },
        execute: async (args, exec) => await this.editBoard(executionSession(exec), args),
      },
      {
        name: 'drawio_open',
        description: '激活当前会话内的画板。宿主在回复下方生成“打开画布”卡片，请勿在正文构造画布链接或文件路径。',
        parameters: outputSchema(boardInput),
        output: {
          schema: boardIdOnly,
          render: renderJson,
          presentationMeta: (_args, value) => boardMeta(value),
        },
        execute: async (args, exec) => await this.openBoard(executionSession(exec), args),
        isConcurrencySafe: () => true,
      },
    ]
  }

  registerTools(registry) {
    if (typeof registry?.register !== 'function') return []
    const disposers = []
    for (const definition of this.toolDefinitions()) disposers.push(registry.register(definition))
    return disposers
  }

  async bodyJson(req, maximum = MAX_XML_BYTES + 64 * 1024) {
    const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (essence !== 'application/json') {
      throw canvasError('unsupported-media-type', 'Content-Type 必须是 application/json。', 415)
    }
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.byteLength
      if (size > maximum) throw canvasError('payload-too-large', '请求体过大。', 413)
      chunks.push(Buffer.from(chunk))
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object')
      return value
    } catch {
      throw canvasError('invalid-json', '请求体必须是 JSON 对象。', 400)
    }
  }

  sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value))
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(body.byteLength))
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(body)
  }

  async handle(req, res, route, url) {
    if (route === '/api/drawio/active' && ['GET', 'HEAD'].includes(req.method)) {
      const sessionId = boundedIdentifier(url.searchParams.get('session') ?? '', 'session')
      const board = await this.resolveBoard(sessionId)
      this.sendJson(res, 200, { board: this.clientBoard(board) })
      return true
    }
    const match = /^\/api\/drawio\/boards\/([^/]+)(\/(?:selection|activate))?$/u.exec(route)
    if (match === null) return false
    const boardId = match[1]
    const selectionRoute = match[2] === '/selection'
    const activateRoute = match[2] === '/activate'
    try {
      if (!selectionRoute && !activateRoute && ['GET', 'HEAD'].includes(req.method)) {
        const sessionId = boundedIdentifier(url.searchParams.get('session') ?? '', 'session')
        const board = await this.readBoard(boardId)
        this.assertOwner(board, sessionId)
        this.sendJson(res, 200, { board: this.clientBoard(board) })
        return true
      }
      if (!selectionRoute && !activateRoute && req.method === 'PUT') {
        const body = await this.bodyJson(req)
        const sessionId = boundedIdentifier(body.sessionId, 'sessionId')
        const saved = await this.saveBoard({
          boardId,
          sessionId,
          expectedRevision: body.expectedRevision,
          xml: body.xml,
          pageId: body.pageId,
          pageName: body.pageName,
        })
        this.sendJson(res, 200, { board: saved })
        return true
      }
      if (selectionRoute && req.method === 'POST') {
        const body = await this.bodyJson(req, 1024 * 1024)
        const sessionId = boundedIdentifier(body.sessionId, 'sessionId')
        const updated = await this.updateSelection({
          boardId,
          sessionId,
          revision: body.revision,
          pageId: body.pageId,
          cells: body.cells,
        })
        this.sendJson(res, 200, { board: updated })
        return true
      }
      if (activateRoute && req.method === 'POST') {
        const body = await this.bodyJson(req, 64 * 1024)
        const sessionId = boundedIdentifier(body.sessionId, 'sessionId')
        const activated = await this.activateBoard(sessionId, boardId)
        this.sendJson(res, 200, activated)
        return true
      }
      throw canvasError('method-not-allowed', 'Method not allowed', 405)
    } catch (error) {
      const status = Number(error?.status)
      this.sendJson(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, {
        code: error?.code ?? 'internal-error',
        message: messageOf(error),
        details: error?.details,
      })
      return true
    }
  }
}

export const DRAWIO_TOOL_NAMES = new Set(TOOL_NAMES)
export const DRAWIO_LIMITS = Object.freeze({
  maxXmlBytes: MAX_XML_BYTES,
  maxSelectionCells: MAX_SELECTION_CELLS,
})
