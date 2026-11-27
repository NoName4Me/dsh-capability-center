import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { Writable } from 'node:stream'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { deflateRawSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  DrawioCanvasService,
  DRAWIO_TOOL_NAMES,
  createDiagramXml,
  updateDiagramCells,
} from '../capabilities/drawio/index.js'
import {
  createDrawioDesignContext,
  createDrawioSelectionContext,
} from '../capabilities/drawio/plugin.js'
import { dist, python, root, tempRoot } from './helpers.js'

const runFile = promisify(execFile)

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

async function fixture() {
  const temp = await tempRoot('capability-center-drawio-')
  let nextId = 1
  const service = new DrawioCanvasService({
    dataRoot: temp,
    createId: () => uuid(nextId++),
    now: () => '2026-11-19T00:00:00.000Z',
  })
  await service.initialize()
  return {
    temp,
    service,
    async close() {
      await rm(temp, { recursive: true, force: true })
    },
  }
}

function diagramArgs(title = '流程') {
  return {
    title,
    nodes: [
      { id: 'alpha', label: 'Alpha', x: 10, y: 20 },
      { id: 'beta', label: 'Beta', x: 210, y: 20 },
      { id: 'gamma', label: 'Gamma', x: 410, y: 20 },
    ],
    edges: [
      { id: 'alpha-beta', source: 'alpha', target: 'beta' },
      { id: 'beta-gamma', source: 'beta', target: 'gamma' },
    ],
  }
}

function compressedPage(modelXml) {
  const encoded = encodeURIComponent(modelXml)
    .replaceAll('%20', ' ')
    .replaceAll('%3D', '=')
    .replaceAll('%2F', '/')
    .replaceAll('%3A', ':')
    .replaceAll('%22', '"')
  return encodeURIComponent(deflateRawSync(Buffer.from(encoded, 'utf8')).toString('base64'))
}

async function assertWellFormedXml(text) {
  const temp = await tempRoot('capability-center-drawio-xml-')
  const path = join(temp, 'diagram.xml')
  try {
    await writeFile(path, text)
    await runFile(python, [
      '-c',
      'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])',
      path,
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function visitSchema(value, path = '', violations = []) {
  if (value === null || typeof value !== 'object') return violations
  if (Array.isArray(value)) {
    for (const item of value) visitSchema(item, path, violations)
    return violations
  }
  for (const [key, child] of Object.entries(value)) {
    if ([
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
      'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
      'uniqueItems', 'minProperties', 'maxProperties',
    ].includes(key)) {
      violations.push(`${path}/${key}`)
    }
    if (key === 'type' && Array.isArray(child)) violations.push(`${path}/type[]`)
    visitSchema(child, `${path}/${key}`, violations)
  }
  return violations
}

test('tool schemas use only the exact rc.2 JSON Schema subset and expose stable names', async () => {
  const temp = await tempRoot('capability-center-drawio-schema-')
  try {
    const service = new DrawioCanvasService({ dataRoot: temp })
    const definitions = service.toolDefinitions()
    assert.deepEqual(new Set(definitions.map(tool => tool.name)), DRAWIO_TOOL_NAMES)
    assert.deepEqual(visitSchema(definitions), [])
    const selection = definitions.find(tool => tool.name === 'drawio_get_selection')
    assert.deepEqual(
      selection.output.schema.properties.selection.properties.selectedAt.oneOf,
      [{ type: 'string' }, { type: 'null' }],
    )
    const create = definitions.find(tool => tool.name === 'drawio_create')
    assert.deepEqual(
      create.parameters.properties.visualTheme.enum,
      ['auto', 'editorial', 'technical', 'warm', 'monochrome'],
    )
    assert.equal(create.parameters.properties.preserveDrawioPalette.type, 'boolean')
    assert.deepEqual(
      create.parameters.properties.nodes.items.properties.role.enum,
      ['start', 'end', 'process', 'decision', 'outcome', 'warning', 'note'],
    )
    const edit = definitions.find(tool => tool.name === 'drawio_edit')
    assert.ok(edit.parameters.properties.visualTheme)
    assert.equal(edit.parameters.properties.preserveDrawioPalette.type, 'boolean')
    assert.ok(edit.parameters.properties.operations.items.properties.role)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('boards remain session-owned and explicit activation wins over last-created fallback', async () => {
  const current = await fixture()
  try {
    const first = await current.service.createBoard('session-a', diagramArgs('第一张'))
    const second = await current.service.createBoard('session-a', diagramArgs('第二张'))
    assert.notEqual(first.boardId, second.boardId)
    await current.service.activateBoard('session-a', first.boardId)
    assert.equal((await current.service.getSelection('session-a', {})).boardId, first.boardId)
    await assert.rejects(
      current.service.getSelection('session-b', { boardId: first.boardId }),
      error => error?.code === 'board-session-mismatch' && error?.status === 403,
    )
    await current.service.openBoard('session-a', { boardId: second.boardId })
    assert.equal((await current.service.getSelection('session-a', {})).boardId, second.boardId)
  } finally {
    await current.close()
  }
})

test('default diagrams use the editorial role palette and an infinite canvas', () => {
  const xml = createDiagramXml({
    title: '角色',
    pageId: 'page-roles',
    pageName: '角色',
    nodes: [
      { id: 'start', label: '开始', role: 'start', x: 0, y: 0 },
      { id: 'process', label: '处理', role: 'process', x: 180, y: 0 },
      { id: 'decision', label: '检查', role: 'decision', x: 360, y: 0 },
      { id: 'outcome', label: '完成', role: 'outcome', x: 540, y: 0 },
      { id: 'approved', label: '审批通过', x: 720, y: 0 },
      { id: 'approval-decision', label: '审批是否通过？', x: 900, y: 0 },
      { id: 'warning', label: '异常', role: 'warning', x: 180, y: 140 },
      { id: 'note', label: '备注', role: 'note', x: 360, y: 140 },
    ],
    edges: [
      { id: 'start-process', source: 'start', target: 'process' },
      { id: 'process-decision', source: 'process', target: 'decision' },
    ],
  })
  assert.match(xml, /page="0"/u)
  assert.match(xml, /background="#FAFAF8"/u)
  assert.match(xml, /id="start"[^>]*style="[^"]*fillColor=#1F2933[^"]*fontColor=#FFFFFF/u)
  assert.match(xml, /id="process"[^>]*style="[^"]*fillColor=#FFFDF8[^"]*strokeColor=#A8A29E/u)
  assert.match(xml, /id="decision"[^>]*style="[^"]*shape=rhombus[^"]*fillColor=#FFF7E5/u)
  assert.match(xml, /id="outcome"[^>]*style="[^"]*fillColor=#F1F7F4[^"]*strokeColor=#78978A/u)
  assert.match(xml, /id="approved"[^>]*style="[^"]*fillColor=#F1F7F4[^"]*strokeColor=#78978A/u)
  assert.doesNotMatch(xml, /id="approved"[^>]*style="[^"]*shape=rhombus/u)
  assert.match(xml, /id="approval-decision"[^>]*style="[^"]*shape=rhombus/u)
  assert.match(xml, /id="warning"[^>]*style="[^"]*fillColor=#FFF4F0[^"]*strokeColor=#C47C6B/u)
  assert.match(xml, /id="note"[^>]*style="[^"]*dashed=1[^"]*fillColor=#F8F7F3/u)
  assert.match(xml, /id="start-process"[^>]*style="[^"]*strokeColor=#7C746C/u)
})

test('explicit styles win, legacy draw.io fills are refined by default, and preservation is opt-in', () => {
  const base = {
    title: '样式',
    pageId: 'page-styles',
    pageName: '样式',
    nodes: [
      {
        id: 'explicit',
        label: '用户颜色',
        x: 0,
        y: 0,
        style: 'fillColor=#123456;strokeColor=#332211;fontColor=#FFFFFF;',
      },
      {
        id: 'legacy',
        label: '旧颜色',
        x: 180,
        y: 0,
        style: 'fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#123456;',
      },
    ],
  }
  const refined = createDiagramXml(base)
  assert.match(refined, /id="explicit"[^>]*fillColor=#123456[^>]*strokeColor=#332211/u)
  assert.doesNotMatch(refined, /id="legacy"[^>]*fillColor=#dae8fc/u)
  assert.match(refined, /id="legacy"[^>]*fillColor=#F4F7FA[^>]*strokeColor=#7790A8[^>]*fontColor=#24384B/u)

  const preserved = createDiagramXml({ ...base, preserveDrawioPalette: true })
  assert.match(
    preserved,
    /id="legacy"[^>]*fillColor=#dae8fc[^>]*strokeColor=#6c8ebf[^>]*fontColor=#123456/u,
  )

  const added = updateDiagramCells(refined, {
    pageId: 'page-styles',
    operations: [
      {
        kind: 'add_node',
        id: 'added-warning',
        label: '失败',
        role: 'warning',
        x: 360,
        y: 0,
      },
    ],
  })
  assert.match(added.xml, /id="added-warning"[^>]*fillColor=#FFF4F0/u)
})

test('selection snapshots are revision-bound and a stale selection cannot replace newer state', async () => {
  const current = await fixture()
  try {
    const created = await current.service.createBoard('session-a', diagramArgs())
    const selected = await current.service.updateSelection({
      boardId: created.boardId,
      sessionId: 'session-a',
      revision: 1,
      pageId: created.pageId,
      cells: [
        { id: 'alpha', type: 'vertex', label: 'Alpha' },
        { id: 'beta', type: 'vertex', label: 'Beta' },
      ],
    })
    assert.deepEqual(selected.selection.cellIds, ['alpha', 'beta'])
    const edited = await current.service.editBoard('session-a', {
      boardId: created.boardId,
      expectedRevision: 1,
      pageId: created.pageId,
      cellIds: ['alpha', 'beta'],
      sets: [{ name: 'fillColor', value: '#1e88e5' }],
    })
    assert.equal(edited.revision, 2)
    await assert.rejects(
      current.service.updateSelection({
        boardId: created.boardId,
        sessionId: 'session-a',
        revision: 1,
        pageId: created.pageId,
        cells: [{ id: 'gamma', type: 'vertex', label: 'Gamma' }],
      }),
      error => error?.code === 'revision-conflict' && error?.details?.currentRevision === 2,
    )
    const board = await current.service.readBoard(created.boardId)
    assert.deepEqual(board.selection.cellIds, ['alpha', 'beta'])
  } finally {
    await current.close()
  }
})

test('edits retain the original board and preserve replacement-pattern characters in labels', async () => {
  const current = await fixture()
  try {
    const created = await current.service.createBoard('session-a', diagramArgs())
    const originalXml = (await current.service.readBoard(created.boardId)).xml
    const edited = await current.service.editBoard('session-a', {
      boardId: created.boardId,
      expectedRevision: 1,
      pageId: created.pageId,
      cellIds: ['alpha', 'beta'],
      sets: [
        { name: 'label', value: '付款 $& $1 $$' },
        { name: 'fillColor', value: '#2196f3' },
      ],
    })
    assert.equal(edited.boardId, created.boardId)
    assert.equal(edited.revision, 2)
    const board = await current.service.readBoard(created.boardId)
    assert.notEqual(board.xml, originalXml)
    assert.match(board.xml, /value="付款 \$&amp; \$1 \$\$"/u)
    assert.match(board.xml, /fillColor=#2196f3/u)
    assert.equal((board.xml.match(/id="alpha"/gu) ?? []).length, 1)
  } finally {
    await current.close()
  }
})

test('structural operations update labels, add nodes and edges, and remove descendants plus incident edges', async () => {
  const xml = createDiagramXml({
    title: '结构',
    pageId: 'page-structure',
    pageName: '结构',
    nodes: [
      { id: 'group', label: '组', x: 0, y: 0, width: 300, height: 300 },
      { id: 'child', label: '子节点', x: 10, y: 10 },
      { id: 'keep', label: '保留', x: 400, y: 0 },
    ],
    edges: [
      { id: 'child-keep', source: 'child', target: 'keep' },
      { id: 'keep-group', source: 'keep', target: 'group' },
    ],
  }).replace(
    'parent="1"><mxGeometry x="10" y="10"',
    'parent="group"><mxGeometry x="10" y="10"',
  )
  const added = updateDiagramCells(xml, {
    pageId: 'page-structure',
    cellIds: ['keep'],
    sets: [{ name: 'label', value: '保留步骤' }],
    operations: [
      { kind: 'add_node', id: 'new', label: '新增步骤', x: 700, y: 0 },
      { kind: 'add_edge', id: 'new-edge', source: 'keep', target: 'new' },
    ],
  })
  assert.match(added.xml, /value="保留步骤"/u)
  assert.match(added.xml, /id="new"/u)
  assert.match(added.xml, /source="keep" target="new"/u)
  const removed = updateDiagramCells(added.xml, {
    pageId: 'page-structure',
    operations: [{ kind: 'remove_cell', id: 'group' }],
  })
  assert.doesNotMatch(removed.xml, /id="group"/u)
  assert.doesNotMatch(removed.xml, /id="child"/u)
  assert.doesNotMatch(removed.xml, /id="child-keep"/u)
  assert.doesNotMatch(removed.xml, /id="keep-group"/u)
  assert.doesNotMatch(removed.xml, /<mxGeometry[^>]*(?:x="10" y="10")/u)
  await assertWellFormedXml(removed.xml)
})

test('wrapped UserObject label and style additions stay on the correct start tags', async () => {
  const xml = '<mxfile><diagram id="p" name="P"><mxGraphModel><root>'
    + '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<UserObject id="wrapped" parent="1"><mxCell vertex="1">'
    + '<mxGeometry x="1" y="2" width="3" height="4" as="geometry"/>'
    + '</mxCell></UserObject></root></mxGraphModel></diagram></mxfile>'
  const updated = updateDiagramCells(xml, {
    pageId: 'p',
    cellIds: ['wrapped'],
    sets: [
      { name: 'label', value: '标签 $&' },
      { name: 'fillColor', value: '#ff0000' },
    ],
  })
  assert.match(
    updated.xml,
    /<UserObject id="wrapped" parent="1" label="标签 \$&amp;">/u,
  )
  assert.match(
    updated.xml,
    /<mxCell vertex="1" style="fillColor=#ff0000">/u,
  )
  assert.doesNotMatch(updated.xml, /<\/mxCell style=/u)
  await assertWellFormedXml(updated.xml)
})

test('mixed compressed and uncompressed pages are normalized independently and bounded', async () => {
  const firstModel = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="a" value="A" vertex="1" parent="1" style="rounded=1;">'
    + '<mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>'
    + '</root></mxGraphModel>'
  const secondModel = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="b" value="B" vertex="1" parent="1" style="rounded=1;">'
    + '<mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>'
    + '</root></mxGraphModel>'
  const mixed = `<mxfile><diagram id="p1" name="One">${compressedPage(firstModel)}</diagram>`
    + `<diagram id="p2" name="Two">${secondModel}</diagram></mxfile>`
  const updated = updateDiagramCells(mixed, {
    pageId: 'p1',
    cellIds: ['a'],
    sets: [{ name: 'fillColor', value: '#00ff00' }],
  })
  assert.match(updated.xml, /id="a"[^>]*fillColor=#00ff00/u)
  assert.match(updated.xml, /<diagram id="p2" name="Two"><mxGraphModel>/u)
  await assertWellFormedXml(updated.xml)

  const oversized = deflateRawSync(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20))
  const bomb = `<mxfile><diagram id="p" name="P">${
    encodeURIComponent(oversized.toString('base64'))
  }</diagram></mxfile>`
  assert.throws(
    () => updateDiagramCells(bomb, {
      pageId: 'p',
      cellIds: ['missing'],
      sets: [{ name: 'fillColor', value: '#fff' }],
    }),
    error => error?.status === 413 && /超过 4 MiB/u.test(error.message),
  )
})

test('concurrent mutation and manual save both use compare-and-swap, leaving one exact winner', async () => {
  const current = await fixture()
  try {
    const created = await current.service.createBoard('session-a', diagramArgs())
    const board = await current.service.readBoard(created.boardId)
    const outcomes = await Promise.allSettled([
      current.service.editBoard('session-a', {
        boardId: created.boardId,
        expectedRevision: 1,
        pageId: created.pageId,
        cellIds: ['alpha'],
        sets: [{ name: 'fillColor', value: '#111111' }],
      }),
      current.service.saveBoard({
        boardId: created.boardId,
        sessionId: 'session-a',
        expectedRevision: 1,
        pageId: created.pageId,
        xml: board.xml.replace('value="Gamma"', 'value="Gamma manual"'),
      }),
    ])
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = outcomes.find(result => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'revision-conflict')
    const winner = await current.service.readBoard(created.boardId)
    assert.equal(winner.revision, 2)
    assert.notEqual(
      winner.xml.includes('Gamma manual'),
      winner.xml.includes('fillColor=#111111'),
    )
  } finally {
    await current.close()
  }
})

test('unknown pages and cells fail without changing the board revision', async () => {
  const current = await fixture()
  try {
    const created = await current.service.createBoard('session-a', diagramArgs())
    const before = await current.service.readBoard(created.boardId)
    await assert.rejects(
      current.service.editBoard('session-a', {
        boardId: created.boardId,
        expectedRevision: 1,
        pageId: created.pageId,
        cellIds: ['missing'],
        sets: [{ name: 'fillColor', value: '#fff' }],
      }),
      error => error?.code === 'unknown-cell',
    )
    await assert.rejects(
      current.service.editBoard('session-a', {
        boardId: created.boardId,
        expectedRevision: 1,
        pageId: 'missing-page',
        operations: [{ kind: 'remove_cell', id: 'alpha' }],
      }),
      error => error?.code === 'unknown-page',
    )
    const after = await current.service.readBoard(created.boardId)
    assert.equal(after.revision, before.revision)
    assert.equal(after.xml, before.xml)
  } finally {
    await current.close()
  }
})

test('client gates only plain idle sends and pre-step context carries the exact selection', async () => {
  const source = await readFile(
    join(root, 'capabilities', 'drawio', 'client.js'),
    'utf8',
  )
  const insertion = '\n    module.exports = {'
  const instrumented = source.replace(
    insertion,
    '\n    globalThis.__canGateCanvasSubmit = canGateCanvasSubmit;'
      + insertion,
  )
  assert.notEqual(instrumented, source)
  const context = {
    localStorage: {
      getItem() { return null },
      removeItem() {},
      setItem() {},
    },
    window: {
      __ModuleLoader__: {
        load(definition) {
          definition.factory(name => {
            if (name === 'react') return { createElement() {}, createContext() {} }
            throw new Error(`Unexpected client dependency: ${name}`)
          })
        },
      },
    },
  }
  runInNewContext(instrumented, context)
  const canGate = context.__canGateCanvasSubmit
  assert.equal(typeof canGate, 'function')
  const event = {
    defaultPrevented: false,
    isComposing: false,
    keyCode: 13,
    repeat: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  }
  const input = { phase: 'plain' }
  const idle = { running: false }
  assert.equal(canGate(event, input, idle, '把这两个改蓝'), true)
  for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey']) {
    assert.equal(canGate({ ...event, [modifier]: true }, input, idle, '把这两个改蓝'), false)
  }
  assert.equal(canGate({ ...event, isComposing: true }, input, idle, '把这两个改蓝'), false)
  assert.equal(canGate(event, input, { running: true }, '把这两个改蓝'), false)
  assert.equal(canGate(event, { phase: 'claimed' }, idle, '把这两个改蓝'), false)
  assert.equal(canGate(event, input, idle, '/compact'), false)

  const pluginContext = createDrawioSelectionContext({
    boardId: uuid(9),
    revision: 3,
    pageId: 'page-1',
    selection: {
      cellIds: ['alpha', 'beta'],
      cells: [],
      selectedAt: '2026-11-19T00:00:00.000Z',
    },
  })
  assert.equal(pluginContext.role, 'user')
  assert.equal(pluginContext.source.kind, 'capability-center-drawio')
  assert.equal(pluginContext.source.form, 'snapshot')
  assert.equal(pluginContext.source.selectedCellCount, 2)
  assert.match(pluginContext.content[0].text, /selectedCellIds=alpha,beta/u)
  assert.match(pluginContext.content[0].text, /drawio_get_selection/u)

  const designContext = createDrawioDesignContext({
    boardId: uuid(10),
    revision: 4,
    pageId: 'page-2',
    selection: { cellIds: [], cells: [], selectedAt: null },
  })
  assert.equal(designContext.role, 'user')
  assert.equal(designContext.source.form, 'guideline')
  assert.equal(designContext.source.sections[0].name, 'drawio-design')
  assert.match(designContext.content[0].text, /page-2/u)
  assert.match(designContext.content[0].text, /explicit style, colors/u)
  assert.match(designContext.content[0].text, /#dae8fc/u)
})

test('minimal editor canvas setup uses a static DOM snapshot and bounded load retries', async () => {
  const source = await readFile(
    join(root, 'capabilities', 'drawio', 'client.js'),
    'utf8',
  )
  const configurationSource = source.slice(
    source.indexOf('function disableEditorPageView'),
    source.indexOf('const bindGraph'),
  )
  assert.doesNotMatch(source, /windowValue === undefined \|\| ui === undefined/u)
  assert.match(
    source,
    /const windowValue = graphWindowRef\.current \?\? iframeRef\.current\?\.contentWindow/u,
  )
  assert.match(source, /页面视图\|page\\s\*view/u)
  assert.match(source, /if \(pageView\?\.checked === true\) pageView\.click\(\)/u)
  assert.match(
    source,
    /\[\.\.\.documentValue\.querySelectorAll\('\.mxWindowTitle'\)\]/u,
  )
  assert.match(source, /for \(const title of titles\)/u)
  assert.match(source, /if \(typeof close\?\.click === 'function'\) \{[\s\S]*?close\.click\(\);/u)
  assert.match(source, /closeMinimalEditorWindows\(windowValue, \['形状', '格式'\]\)/u)
  assert.match(
    source,
    /let container = titleCell\.closest\('\.mxWindow'\);[\s\S]*?while \(container\?\.parentElement\?\.classList\.contains\('mxWindow'\)\) \{[\s\S]*?container = container\.parentElement;[\s\S]*?container\.style\.display = 'none'/u,
  )
  assert.doesNotMatch(configurationSource, /\.mxWindow > \.mxWindow/u)
  assert.match(source, /CANVAS_CONFIGURATION_RETRY_DELAYS_MS = \[80, 300, 800\]/u)
  assert.match(source, /CANVAS_CONFIGURATION_SETTLE_MS = 300/u)
  assert.doesNotMatch(configurationSource, /MutationObserver/u)
  assert.match(source, /configuringCanvasRef\.current = true/u)
  assert.match(source, /if \(configuringCanvasRef\.current\) return;[\s\S]*?dirtyRef\.current = true/u)
  assert.match(
    source,
    /message\.event === 'autosave' \|\| message\.event === 'save'[\s\S]*?if \(configuringCanvasRef\.current\) return;[\s\S]*?saveXml\(message\.xml\)/u,
  )
  assert.match(
    source,
    /if \(!disposedRef\.current\) configuringCanvasRef\.current = false/u,
  )
})

test('canvas layout collapses only an expanded global sidebar and restores its own state', async () => {
  const source = await readFile(
    join(root, 'capabilities', 'drawio', 'client.js'),
    'utf8',
  )
  assert.match(source, /document\.querySelector\('\[data-shell-bottom\]'\)\?\.parentElement/u)
  assert.match(
    source,
    /hasAttribute\('data-sidebar-collapsed'\) === false[\s\S]*?layout\.toggleSidebar\(\)[\s\S]*?collapsedSidebarRef\.current = true/u,
  )
  assert.match(
    source,
    /if \(!collapsedSidebarRef\.current\) return;[\s\S]*?getAttribute\('data-sidebar-collapsed'\) === 'true'[\s\S]*?layout\.toggleSidebar\(\)[\s\S]*?collapsedSidebarRef\.current = false/u,
  )
  assert.doesNotMatch(source, /getAttribute\('data-sidebar-collapsed'\) === 'false'/u)
  const panelSource = source.slice(
    source.indexOf('function DrawioCanvasPanel'),
    source.indexOf('function DrawioHeaderAction'),
  )
  assert.doesNotMatch(panelSource, /data-sidebar-collapsed[\s\S]{0,160}\.classList/u)
})

test('built plugin contains deterministic same-origin editor assets, licenses, and provenance', async () => {
  const archive = join(dist, 'packages', 'capability-center-drawio-0.2.0.tgz')
  const bytes = await readFile(archive)
  assert.ok(bytes.byteLength < 32 * 1024 * 1024)
  const catalog = JSON.parse(await readFile(join(dist, 'catalog.json'), 'utf8'))
  const entry = catalog.items.find(item => item.id === 'capability-center-drawio')
  assert.ok(entry)
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    entry.artifact.sha256,
  )
  assert.equal(bytes.byteLength, entry.artifact.bytes)
  const { stdout: names } = await runFile('tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 })
  for (const name of [
    'package/atomic.js',
    'package/client.js',
    'package/plugin.js',
    'package/README.md',
    'package/drawio/.version',
    'package/drawio/LICENSE',
    'package/drawio/img/LICENSE',
    'package/drawio/js/app.min.js',
    'package/drawio-provenance.json',
  ]) {
    assert.match(names, new RegExp(`^${name.replaceAll('.', '\\.')}$`, 'mu'))
  }
  const { stdout: version } = await runFile(
    'tar',
    ['-xOf', archive, 'package/drawio/.version'],
  )
  assert.equal(version.trim(), 'v32.0.2')
  const { stdout: provenanceText } = await runFile(
    'tar',
    ['-xOf', archive, 'package/drawio-provenance.json'],
  )
  const provenance = JSON.parse(provenanceText)
  assert.equal(provenance.package, '@next-ai-drawio/mcp-server')
  assert.equal(provenance.version, '0.4.15')
  assert.equal(provenance.license, 'Apache-2.0')
  assert.equal(provenance.drawioVersion, 'v32.0.2')
  const client = await readFile(join(root, 'capabilities', 'drawio', 'client.js'), 'utf8')
  assert.match(client, /convertValueToString\(cell\)/u)
  assert.doesNotMatch(client, /mxUtils\?\.getTextContent/u)
  assert.match(client, /导出 \.drawio/u)
  assert.match(client, /new Blob\(\[xml\]/u)
  assert.match(client, /setPageVisible\?\.\(false\)/u)
  assert.match(client, /disableEditorPageView\(windowValue\)/u)
  assert.match(client, /closeMinimalEditorWindows\(windowValue, \['形状', '格式'\]\)/u)
})

test('the built plugin serves the editor with same-origin MIME, CSP, and traversal rejection', async () => {
  const temp = await tempRoot('capability-center-drawio-static-')
  const home = join(temp, 'home')
  const extracted = join(temp, 'package')
  await mkdir(extracted, { recursive: true })
  const archive = join(dist, 'packages', 'capability-center-drawio-0.2.0.tgz')
  await runFile('tar', ['-xzf', archive, '-C', extracted])
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let handler
  const disposers = []
  const hostEvents = []
  let preStepListener
  const toolDefinitions = []
  try {
    const plugin = await import(pathToFileURL(join(extracted, 'package', 'plugin.js')).href)
    const tools = {
      register(definition) {
        toolDefinitions.push(definition)
        return () => undefined
      },
    }
    const ctx = {
      tools,
      logger: { warn() {} },
      on(name, listener) {
        hostEvents.push(name)
        if (name === 'agent/pre-step') preStepListener = listener
        return () => undefined
      },
      effect(callback) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      inject(_names, callback) {
        callback({
          effect(callbackValue) {
            const dispose = callbackValue()
            if (typeof dispose === 'function') disposers.push(dispose)
            return dispose
          },
          webServer: {
            register(spec) {
              handler = spec.handler
              return () => undefined
            },
          },
          connection: {
            requestRejection() {
              return undefined
            },
          },
        })
      },
    }
    plugin.apply(ctx)
    assert.equal(typeof handler, 'function')
    assert.deepEqual(hostEvents, ['agent/pre-step'])
    const index = await requestStatic(handler, '/capability-center-drawio/drawio/index.html')
    assert.equal(index.status, 200)
    assert.match(index.headers['content-type'], /text\/html/u)
    assert.match(index.headers['content-security-policy'], /default-src 'self'/u)
    assert.equal(index.headers['cross-origin-resource-policy'], 'same-origin')
    const script = await requestStatic(handler, '/capability-center-drawio/drawio/js/app.min.js')
    assert.equal(script.status, 200)
    assert.match(script.headers['content-type'], /javascript/u)
    const traversal = await requestStatic(
      handler,
      '/capability-center-drawio/drawio/%252e%252e/plugin.js',
    )
    assert.equal(traversal.status, 404)
    const mutation = await requestStatic(
      handler,
      '/capability-center-drawio/api/drawio/active?session=fixture',
      'POST',
      {},
    )
    assert.equal(mutation.status, 403)

    const create = toolDefinitions.find(definition => definition.name === 'drawio_create')
    const agent = { id: 'session-context' }
    const step = (text, turn, kind = 'user') => preStepListener({
      agent, turn, step: 1, signal: new AbortController().signal,
      messages: [{ role: 'user', source: { kind }, content: [{ type: 'text', text }] }],
    }, async () => ({ kind: 'enter', messages: [] }))
    const args = { title: 'OAuth', nodes: [{ id: 'alpha', label: 'Alpha', x: 0, y: 0 }] }
    await step('oauth授权登陆是什么流程', 1)
    await assert.rejects(create.execute(args, { agent }), { code: 'drawing-not-requested' })
    await step('请画一张 OAuth 授权登录流程图', 2)
    const created = await create.execute({
      title: 'Context',
      nodes: [{ id: 'alpha', label: 'Alpha', x: 0, y: 0 }],
    }, { agent })
    await step('不用画图，只解释 OAuth 的流程', 3)
    await assert.rejects(create.execute(args, { agent }), { code: 'drawing-not-requested' })
    await step('请画一张 OAuth 授权登录流程图', 4, 'capability-center-drawio')
    await assert.rejects(create.execute(args, { agent }), { code: 'drawing-not-requested' })
    const selection = await requestStatic(
      handler,
      `/capability-center-drawio/api/drawio/boards/${created.boardId}/selection`,
      'POST',
      undefined,
      {
        sessionId: 'session-context',
        revision: created.revision,
        pageId: created.pageId,
        cells: [{ id: 'alpha', type: 'vertex', label: 'Alpha' }],
      },
    )
    assert.equal(selection.status, 200, selection.body.toString('utf8'))
    const decision = await preStepListener({
      agent: { id: 'session-context' },
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 1)
    assert.match(decision.messages[0].content[0].text, /selectedCellIds=alpha/u)
    assert.equal(decision.messages[0].source.kind, 'capability-center-drawio')
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(temp, { recursive: true, force: true })
  }
})

async function requestStatic(handler, url, method = 'GET', extraHeaders = undefined, bodyValue = undefined) {
  const chunks = []
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  let status = 0
  let headers = {}
  response.writeHead = (nextStatus, nextHeaders = {}) => {
    status = nextStatus
    headers = nextHeaders
    return response
  }
  response.setHeader = (name, value) => {
    status = status || 200
    headers[name] = value
    return response
  }
  const request = {
    method,
    url,
    headers: {
      ...(extraHeaders ?? {
        'x-capability-center': '1',
        'sec-fetch-site': 'same-origin',
      }),
      ...(bodyValue === undefined ? {} : { 'content-type': 'application/json' }),
    },
    async *[Symbol.asyncIterator]() {
      if (bodyValue !== undefined) yield Buffer.from(JSON.stringify(bodyValue))
    },
  }
  await handler(request, response)
  await new Promise(resolve => {
    if (response.writableFinished) resolve()
    else response.once('finish', resolve)
  })
  return {
    status,
    headers,
    body: Buffer.concat(chunks),
  }
}
