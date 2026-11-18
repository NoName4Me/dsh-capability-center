import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { test } from 'node:test'
import { readZip } from '../src/engine/lib/archive.js'
import { readBoundedUrl } from '../src/bootstrap/lib/http-transport.js'
import { satisfies } from '../src/engine/lib/semver.js'
import { CoreService } from '../src/engine/service.js'
import {
  apply,
  AutoContinueController,
  CONTINUE_PROMPT,
  DEFAULT_TIMING,
  inject,
  SOURCE_KIND,
} from '../src/capabilities/dsh-intranet-auto-continue/index.js'
import {
  dist,
  distributionServer,
  fakeContext,
  root,
  sha256,
  tempRoot,
} from './helpers.js'

const AUTO_ID = 'dsh-intranet-auto-continue'
const AUTO_NAME = 'dsh-intranet-auto-continue'
const AUTO_VERSION = '1.1.0'
const AUTO_ENTRY_ID = 'include:dsh-intranet-auto-continue'

function bundleInfo(overrides = {}) {
  return {
    name: AUTO_NAME,
    official: false,
    availability: 'profile',
    version: AUTO_VERSION,
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
    ...overrides,
  }
}

function serviceFor(home, context) {
  return new CoreService(context, {
    version: '0.2.6',
    dataRoot: join(home, 'capability-center'),
    http: { readBoundedUrl },
    dshHome: home,
  })
}

async function waitFor(service, operation) {
  return await service.waitForOperation(operation.id)
}

function readTarGz(bytes) {
  const archive = gunzipSync(bytes)
  const entries = new Map()
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '')
    const name = prefix === '' ? rawName : `${prefix}/${rawName}`
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim()
    const size = Number.parseInt(sizeText || '0', 8)
    const type = header.subarray(156, 157).toString('ascii') || '0'
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > archive.byteLength) {
      throw new Error(`invalid tar entry ${name}`)
    }
    if (type === '0' || type === '\0') entries.set(name, archive.subarray(bodyStart, bodyEnd))
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function makeHost({ timing, sessionId = 'session-1', header = {}, live = true } = {}) {
  const listeners = new Map()
  const timers = []
  const cleanups = []
  const sessions = new Map()
  const agents = new Map()
  const session = {
    id: sessionId,
    header: {
      id: sessionId,
      version: 4,
      createdAt: 1,
      isSeeded: false,
      ...header,
    },
    seq: 0,
  }
  const agent = {
    id: sessionId,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followups: [],
    followup(message) {
      this.followups.push(message)
    },
  }
  if (live) {
    sessions.set(sessionId, session)
    agents.set(sessionId, agent)
  }
  const ctx = {
    sessions: { get: id => sessions.get(id) },
    agents: { get: id => agents.get(id) },
    on(name, callback, options) {
      assert.deepEqual(options, { global: true })
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      set.add(callback)
      return () => set.delete(callback)
    },
    effect(start) {
      cleanups.push(start())
    },
  }
  const host = {
    session,
    agent,
    sessions,
    agents,
    timers,
    ctx,
    start() {
      apply(ctx)
      return host
    },
    controller(options = {}) {
      return new AutoContinueController(ctx, {
        timing,
        setTimeout(callback, delayMs) {
          const timer = { callback, delayMs, cleared: false, fired: false }
          timers.push(timer)
          return timer
        },
        clearTimeout(timer) {
          timer.cleared = true
        },
        ...options,
      })
    },
    emitSession(type, data, seq = session.seq) {
      if (seq >= session.seq) session.seq = seq + 1
      const event = { type, seq, time: seq, data }
      for (const callback of listeners.get('session/event') ?? []) callback(session, event)
      return event
    },
    emit(name, payload) {
      const normalized = name.startsWith('agent/')
        && !['agent/disposed'].includes(name)
        ? { agent, ...payload }
        : payload
      for (const callback of listeners.get(name) ?? []) callback(normalized)
    },
    setStatus(status) {
      agent.status = status
      host.emit('agent/status', { agent, status })
    },
    insert(message) {
      agent.inbox.nextTurn.push(message)
      host.emit('agent/inbox/inserted', { agent, message })
    },
    activeTimers() {
      return timers.filter(timer => !timer.cleared && !timer.fired)
    },
    runTimer(timer = host.activeTimers()[0]) {
      assert.ok(timer, 'expected an active timer')
      timer.fired = true
      timer.callback()
    },
    dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    },
  }
  return host
}

function humanMessage(id = 'human-1', sourceKind = 'user') {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: 'do the task' }],
    source: { kind: sourceKind },
  }
}

function beginHumanTurn(host, { turn = 1, id = `human-${turn}` } = {}) {
  const message = humanMessage(id)
  host.emitSession('turn/start', { turn })
  host.emit('agent/inbox/claimed', { message, turn })
  host.emitSession('user/message', message)
  return message
}

function endTurn(host, turn, reason) {
  host.emitSession('turn/end', { turn, reason })
  host.setStatus('idle')
}

function transientReason(code = 'TIMEOUT', extra = {}) {
  return {
    kind: 'error',
    error: {
      message: 'not inspected by the plugin',
      code,
      ...extra,
    },
  }
}

test('plugin exports the host injection contract and registers a disposable observer', () => {
  assert.deepEqual(inject, ['sessions', 'agents'])
  const host = makeHost().start()
  try {
    beginHumanTurn(host)
    endTurn(host, 1, transientReason())
    assert.equal(host.agent.followups.length, 0)
  } finally {
    host.dispose()
  }
})

test('one transient failure sends one frozen plugin-source followup and never spins generated turns', () => {
  const host = makeHost()
  const controller = host.controller()
  try {
    beginHumanTurn(host)
    endTurn(host, 1, transientReason('TRANSPORT'))
    assert.equal(host.agent.followups.length, 0)
    host.runTimer()

    assert.equal(host.agent.followups.length, 1)
    const [message] = host.agent.followups
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, SOURCE_KIND)
    assert.match(message.id, /^[0-9a-f-]{36}$/u)
    assert.equal(message.content[0].text, CONTINUE_PROMPT)
    assert.equal(Object.isFrozen(message), true)
    assert.equal(Object.isFrozen(message.source), true)
    assert.equal(Object.isFrozen(message.content), true)
    assert.equal(Object.isFrozen(message.content[0]), true)

    host.setStatus('running')
    host.emit('agent/inbox/inserted', { message })
    host.emitSession('turn/start', { turn: 2 })
    host.emitSession('user/message', message)
    endTurn(host, 2, transientReason('STREAM_CLOSED'))
    assert.equal(host.activeTimers().length, 0)

    host.emitSession('turn/start', { turn: 3 })
    host.emitSession('user/message', humanMessage('human-after', SOURCE_KIND))
    endTurn(host, 3, transientReason('EMPTY_RESPONSE'))
    assert.equal(host.activeTimers().length, 0)

    beginHumanTurn(host, { turn: 4, id: 'human-new-chain' })
    endTurn(host, 4, { kind: 'error', error: { code: 'TIMEOUT' } })
    assert.equal(host.activeTimers().length, 1)
  } finally {
    controller.dispose()
  }
})

test('configured limit counts only confirmed plugin follow-ups in the same human-led chain', () => {
  const host = makeHost()
  const controller = host.controller({ readConfig: () => ({ maxContinuations: 3 }) })
  try {
    beginHumanTurn(host)
    endTurn(host, 1, transientReason())
    for (let turn = 2; turn <= 4; turn++) {
      host.runTimer()
      const message = host.agent.followups.at(-1)
      host.emitSession('turn/start', { turn })
      host.emitSession('user/message', message)
      endTurn(host, turn, transientReason())
    }
    assert.equal(host.agent.followups.length, 3)
    assert.equal(host.activeTimers().length, 0)
    assert.deepEqual(controller.activity().map(({ result, reason, attempt }) => [result, reason, attempt]), [
      ['skipped', 'limit', undefined],
      ['sent', 'TIMEOUT', 3], ['sent', 'TIMEOUT', 2], ['sent', 'TIMEOUT', 1],
    ])

    host.emitSession('turn/start', { turn: 5 })
    host.emitSession('user/message', host.agent.followups[0])
    endTurn(host, 5, transientReason())
    assert.equal(host.activeTimers().length, 0, 'old plugin messages cannot start a new chain')

    beginHumanTurn(host, { turn: 6 })
    endTurn(host, 6, transientReason())
    host.runTimer()
    assert.equal(host.agent.followups.length, 4)
    assert.equal(controller.activity()[0].attempt, 1)
  } finally {
    controller.dispose()
  }
})

test('settings changes cancel waiting runs and recent activity stays bounded', () => {
  const config = { enabled: true, maxContinuations: 2, pausedSessions: [] }
  const host = makeHost()
  const controller = host.controller({ readConfig: () => ({ get: () => config }) })
  try {
    beginHumanTurn(host)
    endTurn(host, 1, transientReason())
    config.pausedSessions.push(host.session.id)
    controller.configurationChanged()
    assert.equal(host.activeTimers().length, 0)
    assert.equal(controller.activity()[0].reason, 'session-paused')
    assert.equal(controller.activity()[0].result, 'cancelled')

    config.pausedSessions = ['another-session']
    beginHumanTurn(host, { turn: 2 })
    endTurn(host, 2, transientReason())
    const timer = host.activeTimers()[0]
    config.enabled = false
    controller.configurationChanged()
    host.runTimer(timer)
    assert.equal(host.agent.followups.length, 0)
    assert.equal(controller.activity()[0].reason, 'disabled')
    for (let turn = 3; turn <= 36; turn++) {
      beginHumanTurn(host, { turn })
      endTurn(host, turn, transientReason())
    }
    const records = controller.activity()
    assert.equal(records.length, 30)
    assert.ok(records.every(record => record.result === 'skipped' && record.reason === 'disabled'))
    assert.ok(!JSON.stringify(records).includes('not inspected by the plugin'))
  } finally {
    controller.dispose()
  }
})

test('normal completion, explicit abort, unknown and permanent failures do not schedule', () => {
  const host = makeHost()
  const controller = host.controller()
  try {
    beginHumanTurn(host, { turn: 1 })
    endTurn(host, 1, { kind: 'completed' })
    assert.equal(host.activeTimers().length, 0)

    beginHumanTurn(host, { turn: 2 })
    endTurn(host, 2, { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(host.activeTimers().length, 0)

    beginHumanTurn(host, { turn: 3 })
    endTurn(host, 3, transientReason('AUTH', { status: 401 }))
    assert.equal(host.activeTimers().length, 0)

    beginHumanTurn(host, { turn: 4 })
    endTurn(host, 4, transientReason('SERVER_ERROR', { status: 503 }))
    assert.equal(host.activeTimers().length, 0)
  } finally {
    controller.dispose()
  }
})

test('the exact transient codes and max-tokens outcome schedule one recovery', () => {
  for (const reason of [
    transientReason('TIMEOUT'),
    transientReason('TRANSPORT'),
    transientReason('STREAM_CLOSED'),
    transientReason('EMPTY_RESPONSE'),
    { kind: 'max-tokens' },
  ]) {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, reason)
      assert.equal(host.activeTimers().length, 1)
      assert.equal(host.activeTimers()[0].delayMs, DEFAULT_TIMING.transientMs)
    } finally {
      controller.dispose()
    }
  }
})

test('tool errors, malformed results and unresolved calls suppress continuation', () => {
  for (const variant of ['error', 'malformed', 'pending']) {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      host.emitSession('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'write',
        arguments: '{}',
      })
      if (variant !== 'pending') {
        host.emitSession('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 'tool-result-1',
            role: 'tool',
            toolCallId: variant === 'malformed' ? '' : 'call-1',
            source: {
              kind: 'tool',
              callId: variant === 'malformed' ? '' : 'call-1',
            },
            content: [{ type: 'text', text: 'ignored' }],
            isError: variant === 'error',
          },
        })
      }
      endTurn(host, 1, transientReason())
      assert.equal(host.activeTimers().length, 0, variant)
    } finally {
      controller.dispose()
    }
  }
})

test('successful tool results may omit the optional isError field', () => {
  const host = makeHost()
  const controller = host.controller()
  try {
    beginHumanTurn(host)
    host.emitSession('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-success',
      name: 'read',
      arguments: '{}',
    })
    host.emitSession('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-result-success',
        role: 'tool',
        toolCallId: 'call-success',
        source: { kind: 'tool', callId: 'call-success' },
        content: [{ type: 'text', text: 'ignored' }],
      },
    })
    endTurn(host, 1, transientReason())
    assert.equal(host.activeTimers().length, 1)
  } finally {
    controller.dispose()
  }
})

test('429 and 5xx use bounded throttle scheduling and malformed structured fields fail closed', () => {
  {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, transientReason('RATE_LIMIT', {
        status: 429,
        providerRetryAfterMs: 120_000,
      }))
      assert.equal(host.activeTimers()[0].delayMs, 120_000)
    } finally {
      controller.dispose()
    }
  }

  for (const reason of [
    transientReason('RATE_LIMIT', { status: 400 }),
    transientReason('SERVER', { status: 429 }),
    transientReason('RATE_LIMIT', {
      status: 429,
      providerRetryAfterMs: DEFAULT_TIMING.maxMs + 1,
    }),
    transientReason('TIMEOUT', { providerRetryAfterMs: 0 }),
  ]) {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, reason)
      assert.equal(host.activeTimers().length, 0)
    } finally {
      controller.dispose()
    }
  }

  {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, transientReason('SERVER', { status: 503 }))
      assert.equal(host.activeTimers()[0].delayMs, DEFAULT_TIMING.throttledMs)
    } finally {
      controller.dispose()
    }
  }
})

test('subagent and non-live pairs are ignored, and every pre-send recheck is conservative', () => {
  {
    const host = makeHost({ header: { origin: 'subagent', delegationDepth: 1 } })
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, transientReason())
      assert.equal(host.activeTimers().length, 0)
    } finally {
      controller.dispose()
    }
  }

  for (const invalidate of [
    host => host.setStatus('running'),
    host => host.agent.inbox.nextStep.push(humanMessage('queued')),
    host => host.sessions.delete(host.session.id),
    host => host.agents.delete(host.agent.id),
    host => host.emitSession('turn/start', { turn: 2 }),
  ]) {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, transientReason())
      assert.equal(host.activeTimers().length, 1)
      invalidate(host)
      const timer = host.timers[0]
      if (!timer.cleared) host.runTimer(timer)
      assert.equal(host.agent.followups.length, 0, invalidate.toString())
    } finally {
      controller.dispose()
    }
  }
})

test('real-host sequence turn/end at 16, session title at 17, and idle at 18 still sends once', () => {
  const host = makeHost()
  const controller = host.controller()
  try {
    host.session.seq = 14
    host.emitSession('turn/start', { turn: 1 }, 14)
    host.emitSession('user/message', humanMessage('human-regression'), 15)
    host.emitSession('turn/end', { turn: 1, reason: transientReason() }, 16)
    host.emitSession('session/title', {
      title: 'metadata only',
      messageSeqs: [2],
      source: { kind: 'model', provider: 'provider' },
    }, 17)
    host.setStatus('idle')
    assert.equal(host.activeTimers().length, 1)
    host.runTimer()
    assert.equal(host.agent.followups.length, 1)
  } finally {
    controller.dispose()
  }
})

test('model and permission setting changes cancel pending work', () => {
  for (const [type, data] of [
    ['model/selection', { provider: 'provider', model: 'model' }],
    ['permission/preset', { preset: 'workspace-write' }],
    ['sandbox/mode', { mode: 'read-only' }],
    ['approval/policy', { policy: 'never' }],
  ]) {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, transientReason())
      assert.equal(host.activeTimers().length, 1, type)
      host.emitSession(type, data)
      assert.equal(host.activeTimers().length, 0, type)
      host.runTimer(host.timers[0])
      assert.equal(host.agent.followups.length, 0, type)
    } finally {
      controller.dispose()
    }
  }
})

test('new input, disposal, explicit abort and plugin unload cancel pending work', () => {
  {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, transientReason())
      host.insert(humanMessage('intervening'))
      assert.equal(host.activeTimers().length, 0)
      host.runTimer(host.timers[0])
      assert.equal(host.agent.followups.length, 0)
    } finally {
      controller.dispose()
    }
  }

  for (const disposeEvent of ['agent', 'session']) {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host)
      endTurn(host, 1, transientReason())
      if (disposeEvent === 'agent') {
        host.emit('agent/disposed', { agent: host.agent })
      } else {
        host.emit('session/disposed', host.session)
      }
      assert.equal(host.activeTimers().length, 0)
    } finally {
      controller.dispose()
    }
  }

  {
    const host = makeHost()
    const controller = host.controller()
    try {
      beginHumanTurn(host, { turn: 1 })
      endTurn(host, 1, transientReason())
      assert.equal(host.activeTimers().length, 1)
      host.emitSession('turn/start', { turn: 2 })
      endTurn(host, 2, { kind: 'aborted', reason: { kind: 'user' } })
      assert.equal(host.activeTimers().length, 0)
    } finally {
      controller.dispose()
    }
  }

  {
    const host = makeHost()
    const controller = host.controller()
    beginHumanTurn(host)
    endTurn(host, 1, transientReason())
    assert.equal(host.activeTimers().length, 1)
    controller.dispose()
    assert.equal(host.activeTimers().length, 0)
    assert.equal(host.agent.followups.length, 0)
  }
})

test('plugin-bundle health distinguishes missing, disabled, failed, pending and active runtime', async () => {
  const item = {
    id: AUTO_ID,
    type: 'plugin',
    version: AUTO_VERSION,
    install: { packageName: AUTO_NAME },
  }
  const row = { rowId: AUTO_ID, moduleName: AUTO_NAME, entryId: AUTO_ENTRY_ID }
  const livePlugin = {
    entryId: AUTO_ENTRY_ID,
    moduleName: AUTO_NAME,
    enabled: true,
    fiberPhase: 'active',
    patchId: AUTO_ID,
  }
  const cases = [
    {
      expected: 'missing',
      context: fakeContext(),
    },
    {
      expected: 'disabled',
      context: fakeContext({
        bundles: [[AUTO_NAME, bundleInfo({ enabled: false, rows: [row] })]],
        listPlugins: async () => [livePlugin],
      }),
    },
    {
      expected: 'failed',
      context: fakeContext({
        bundles: [[AUTO_NAME, bundleInfo({ rows: [row] })]],
        listPlugins: async () => [{ ...livePlugin, fiberPhase: 'failed' }],
      }),
    },
    {
      expected: 'restart-required',
      context: fakeContext({
        bundles: [[AUTO_NAME, bundleInfo({ rows: [{ rowId: AUTO_ID, moduleName: AUTO_NAME }] })]],
      }),
    },
  ]
  const temp = await tempRoot('capability-center-plugin-health-')
  try {
    for (const fixture of cases) {
      const service = serviceFor(join(temp, fixture.expected), fixture.context)
      const health = await service.checkPluginBundle(item, { bundle: { application: 'restart-required' } })
      assert.equal(health.status, fixture.expected)
    }

    const missingVersionService = serviceFor(join(temp, 'missing-version'), fakeContext({
      bundles: [[AUTO_NAME, bundleInfo({ version: undefined, rows: [row] })]],
      listPlugins: async () => [livePlugin],
    }))
    const missingVersion = await missingVersionService.checkPluginBundle(
      item,
      { bundle: { application: 'restart-required' } },
    )
    assert.equal(missingVersion.status, 'failed')
    assert.match(missingVersion.detail, /未知/u)

    const entry = { bundle: { application: 'restart-required', restartReason: 'no-hmr' } }
    const activeService = serviceFor(join(temp, 'active'), fakeContext({
      bundles: [[AUTO_NAME, bundleInfo({ rows: [row] })]],
      listPlugins: async () => [livePlugin],
    }))
    const active = await activeService.checkPluginBundle(item, entry)
    assert.equal(active.status, 'ready')
    assert.equal(entry.bundle.application, 'applied')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('catalog installs, activates, diagnoses and uninstalls the auto-continue plugin', async () => {
  const inspectionHome = await tempRoot('capability-center-auto-inspect-')
  const manualHome = await tempRoot('capability-center-auto-manual-')
  const installHome = await tempRoot('capability-center-auto-install-')
  const server = await distributionServer()
  try {
    const inspection = serviceFor(inspectionHome, fakeContext())
    await inspection.initialize()
    const summary = await inspection.inspect(server.base)
    const item = summary.catalog.items.find(candidate => candidate.id === AUTO_ID)
    assert.ok(item)
    assert.equal(item.hidden, undefined)
    assert.equal(item.type, 'plugin')
    assert.equal(item.version, AUTO_VERSION)
    assert.equal(item.artifact.path, `packages/dsh-intranet-auto-continue-${AUTO_VERSION}.tgz`)
    assert.match(item.trial.prompt, /不会通过试用自动发送/u)
    const artifactBytes = await readFile(join(dist, item.artifact.path))
    assert.equal(item.artifact.sha256, sha256(artifactBytes))
    assert.equal(item.artifact.bytes, artifactBytes.byteLength)
    await inspection.dispose()

    const activeBundle = bundleInfo({ rows: [{
      rowId: AUTO_ID,
      moduleName: AUTO_NAME,
      entryId: AUTO_ENTRY_ID,
    }] })
    const manualContext = fakeContext({
      bundles: [[AUTO_NAME, activeBundle]],
      listPlugins: async () => [{
        entryId: AUTO_ENTRY_ID,
        moduleName: AUTO_NAME,
        enabled: true,
        fiberPhase: 'active',
        patchId: AUTO_ID,
      }],
    })
    const manual = serviceFor(manualHome, manualContext)
    await manual.initialize()
    const manualSummary = await manual.inspect(server.base)
    assert.equal(manualSummary.localStates[AUTO_ID].installed, false)
    const rejected = await waitFor(manual, manual.startAction(server.base, AUTO_ID, 'install'))
    assert.equal(rejected.status, 'failed')
    assert.match(rejected.error, /已存在但没有能力中心所有权记录/u)
    assert.equal(manualContext.calls.some(call => call.kind === 'installBundle'), false)
    await manual.dispose()

    let installedOptions
    const installContext = fakeContext({
      installBundle: async (spec, options, bundles) => {
        installedOptions = options
        bundles.set(AUTO_NAME, bundleInfo({
          rows: [{ rowId: AUTO_ID, moduleName: AUTO_NAME }],
        }))
        return {
          application: 'restart-required',
          changed: true,
          restartReason: 'no-hmr',
          stage: 'install',
          target: AUTO_NAME,
          version: AUTO_VERSION,
          bundle: AUTO_NAME,
        }
      },
      listPlugins: async () => [],
    })
    const installing = serviceFor(installHome, installContext)
    await installing.initialize()
    const installed = await waitFor(installing, installing.startAction(server.base, AUTO_ID, 'install'))
    assert.equal(installed.status, 'restart-required', installed.error)
    assert.deepEqual(installedOptions, { enabled: true, saveExact: true })
    assert.equal(installing.ledger.get(AUTO_ID).version, AUTO_VERSION)
    assert.equal(installing.ledger.get(AUTO_ID).bundle.application, 'restart-required')
    const bundlesAfterRestart = new Map([...installContext.bundles].map(([name, bundle]) => [
      name,
      {
        ...bundle,
        rows: bundle.rows.map(row => ({ ...row, entryId: AUTO_ENTRY_ID })),
      },
    ]))
    await installing.dispose()

    const failedContext = fakeContext({
      bundles: bundlesAfterRestart,
      listPlugins: async () => [{
        entryId: AUTO_ENTRY_ID,
        moduleName: AUTO_NAME,
        enabled: true,
        fiberPhase: 'failed',
        patchId: AUTO_ID,
      }],
    })
    const failed = serviceFor(installHome, failedContext)
    await failed.initialize()
    assert.equal(failed.ledger.get(AUTO_ID).latestHealth.status, 'failed')
    const persistedFailed = JSON.parse(await readFile(
      join(installHome, 'capability-center', 'data', 'ledger.json'),
      'utf8',
    ))
    assert.equal(persistedFailed.entries[AUTO_ID].latestHealth.status, 'failed')
    await failed.dispose()

    const liveContext = fakeContext({
      bundles: bundlesAfterRestart,
      listPlugins: async () => [{
        entryId: AUTO_ENTRY_ID,
        moduleName: AUTO_NAME,
        enabled: true,
        fiberPhase: 'active',
        patchId: AUTO_ID,
      }],
    })
    const live = serviceFor(installHome, liveContext)
    await live.initialize()
    assert.equal(live.ledger.get(AUTO_ID).latestHealth.status, 'ready')
    assert.equal(live.ledger.get(AUTO_ID).bundle.application, 'applied')
    const diagnosed = await waitFor(live, live.startAction(server.base, AUTO_ID, 'diagnose'))
    assert.equal(diagnosed.status, 'ready', diagnosed.error)
    const activeSummary = await live.inspect(server.base)
    assert.equal(activeSummary.localStates[AUTO_ID].ready, true)
    assert.equal(activeSummary.catalog.items.find(item => item.id === AUTO_ID).trialAvailable, false)
    const offlineSummary = await live.inspect('')
    assert.equal(offlineSummary.catalog.items.find(item => item.id === AUTO_ID).trialAvailable, false)
    await assert.rejects(
      live.prepareTrial('', AUTO_ID, 'request_no_trial', 'test', 'http://localhost'),
      { code: 'trial-unavailable' },
    )

    const removed = await waitFor(live, live.startAction(server.base, AUTO_ID, 'uninstall'))
    assert.equal(removed.status, 'ready', removed.error)
    assert.equal(live.ledger.get(AUTO_ID), undefined)
    assert.equal(liveContext.calls.some(call => call.kind === 'removeBundle' && call.name === AUTO_NAME), true)
    await live.dispose()
  } finally {
    await server.close()
    await Promise.all([
      rm(inspectionHome, { recursive: true, force: true }),
      rm(manualHome, { recursive: true, force: true }),
      rm(installHome, { recursive: true, force: true }),
    ])
  }
})

test('offline package, artifact manifest and ZIP distribute the catalog plugin TGZ', async () => {
  const packagePath = join(dist, 'packages', `dsh-intranet-auto-continue-${AUTO_VERSION}.tgz`)
  const bytes = await readFile(packagePath)
  const entries = readTarGz(bytes)
  assert.ok(entries.has('package/package.json'))
  assert.ok(entries.has('package/index.js'))
  assert.ok(entries.has('package/cordis.patch.yml'))
  assert.ok(entries.has('package/plugin.js'))
  assert.ok(entries.has('package/client.js'))
  assert.equal([...entries.keys()].some(name => name.includes('node_modules')), false)

  const manifest = JSON.parse(entries.get('package/package.json').toString('utf8'))
  assert.equal(manifest.name, 'dsh-intranet-auto-continue')
  assert.equal(manifest.version, AUTO_VERSION)
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.2 <0.2.3')
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2']) {
    assert.equal(satisfies(version, manifest.engines.dsh), true, version)
  }
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  for (const language of ['en', 'zh']) {
    const { meta } = JSON.parse(entries.get(`package/locale/${language}.json`).toString('utf8'))
    assert.ok(meta.title && meta.description, language)
    if (language === 'zh') assert.equal(meta.title, '自动续跑')
  }
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  const patch = entries.get('package/cordis.patch.yml').toString('utf8')
  assert.match(patch, /id: dsh-intranet-auto-continue/u)
  assert.match(patch, /name: dsh-intranet-auto-continue/u)

  const artifactManifest = JSON.parse(
    await readFile(join(dist, 'artifact-manifest.json'), 'utf8'),
  )
  assert.deepEqual(artifactManifest.artifacts.autoContinue, {
    path: `packages/dsh-intranet-auto-continue-${AUTO_VERSION}.tgz`,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  assert.equal(sha256(bytes), artifactManifest.artifacts.autoContinue.sha256)

  const archive = readZip(await readFile(join(root, 'capability-center-offline.zip')))
  const offlinePath = `capability-center/packages/dsh-intranet-auto-continue-${AUTO_VERSION}.tgz`
  assert.ok(archive.has(offlinePath))
  assert.equal(sha256(archive.get(offlinePath)), artifactManifest.artifacts.autoContinue.sha256)

  const bootstrap = readTarGz(await readFile(
    join(dist, 'packages', 'capability-center-0.2.6.tgz'),
  ))
  const bootstrapManifest = JSON.parse(bootstrap.get('package/package.json').toString('utf8'))
  assert.equal(bootstrapManifest.version, '0.2.6')
  assert.equal(bootstrapManifest.engines.dsh, '>=0.2.1-rc.2 <0.2.3')
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2']) {
    assert.equal(satisfies(version, bootstrapManifest.engines.dsh), true, version)
  }
})
