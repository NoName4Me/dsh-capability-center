import { randomUUID } from 'node:crypto'

export const inject = ['sessions', 'agents']

export const MAX_CONTINUATIONS = 5
export const MAX_PAUSED_SESSIONS = 100
const MAX_RECENT_ACTIVITY = 30

export const SOURCE_KIND = 'dsh-intranet-auto-continue'

export const CONTINUE_PROMPT = '请继续完成当前任务中尚未完成的工作。先检查现有结果和剩余步骤；已经完成的工具调用或有副作用的操作不要重复执行。只有确认仍缺少必要步骤时才继续执行，并在完成后简要说明实际结果。'

export const DEFAULT_TIMING = Object.freeze({
  transientMs: 5_000,
  throttledMs: 30_000,
  maxMs: 5 * 60_000,
})

const TRANSIENT_CODES = new Set([
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
  'EMPTY_RESPONSE',
])

const PERMANENT_REASONS = new Map([
  ['AUTH', 'auth'],
  ['INVALID_CREDENTIAL', 'auth'],
  ['MISSING_CREDENTIAL', 'auth'],
  ['QUOTA', 'quota'],
  ['ACCOUNT_QUOTA', 'quota'],
  ['CONTEXT_WINDOW_EXCEEDED', 'context-window'],
  ['UNKNOWN_MODEL', 'unsupported-model'],
  ['MODEL_UNSUPPORTED', 'unsupported-model'],
])

const RELEVANT_SESSION_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'developer/message',
  'system/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'request/header',
  'request/context',
  'model/selection',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

function isPositiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function copyTiming(overrides) {
  const transientMs = overrides.transientMs ?? DEFAULT_TIMING.transientMs
  const throttledMs = overrides.throttledMs ?? DEFAULT_TIMING.throttledMs
  const maxMs = overrides.maxMs ?? DEFAULT_TIMING.maxMs
  if (!isPositiveFiniteNumber(transientMs)
    || !isPositiveFiniteNumber(throttledMs)
    || !isPositiveFiniteNumber(maxMs)
    || transientMs > maxMs
    || throttledMs > maxMs) {
    throw new TypeError('auto-continue timing values must be positive and bounded by maxMs')
  }
  return { transientMs, throttledMs, maxMs }
}

function createContinuationMessage() {
  const content = Object.freeze([
    Object.freeze({ type: 'text', text: CONTINUE_PROMPT }),
  ])
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: Object.freeze({ kind: SOURCE_KIND }),
  })
}

function isTopLevelSession(session) {
  const header = session?.header
  if (!isRecord(header) || header.origin === 'subagent') return false
  if (header.delegationDepth === undefined) return true
  return Number.isSafeInteger(header.delegationDepth) && header.delegationDepth === 0
}

function emptyInbox(agent) {
  const nextTurn = agent?.inbox?.nextTurn
  const nextStep = agent?.inbox?.nextStep
  return Array.isArray(nextTurn)
    && Array.isArray(nextStep)
    && nextTurn.length === 0
    && nextStep.length === 0
}

function classifyTurnEnd(reason, timing) {
  if (reason?.kind === 'completed') return null
  if (reason?.kind === 'max-tokens') return { reason: 'max-tokens', delayMs: timing.transientMs }
  if (['aborted', 'blocked', 'interrupted'].includes(reason?.kind)) return { reason: reason.kind }
  const failure = reason?.error
  const status = failure?.status
  const retryAfter = failure?.providerRetryAfterMs
  if (reason?.kind !== 'error' || !isRecord(failure)
    || (status !== undefined && (!Number.isSafeInteger(status) || status < 100 || status > 599))
    || (retryAfter !== undefined && !isPositiveFiniteNumber(retryAfter))) {
    return { reason: 'unknown-failure' }
  }
  let baseDelayMs
  if (TRANSIENT_CODES.has(failure.code) && !(status >= 400 && status < 500)) {
    baseDelayMs = timing.transientMs
  } else if (failure.code === 'RATE_LIMIT' && (status === undefined || status === 429)) {
    baseDelayMs = timing.throttledMs
  } else if (failure.code === 'SERVER' && (status === undefined || status >= 500)) {
    baseDelayMs = timing.throttledMs
  } else {
    return { reason: status === 401 || status === 403 ? 'auth' : PERMANENT_REASONS.get(failure.code) ?? 'non-retryable' }
  }
  const delayMs = Math.max(baseDelayMs, retryAfter ?? 0)
  return delayMs > timing.maxMs ? { reason: 'retry-after-too-long' } : { reason: failure.code, delayMs }
}

function readPolicy(config) {
  const value = typeof config?.get === 'function' ? config.get() : config
  const max = value?.maxContinuations
  return {
    enabled: value?.enabled !== false,
    maxContinuations: Number.isInteger(max) && max >= 1 && max <= MAX_CONTINUATIONS ? max : 1,
    pausedSessions: new Set(Array.isArray(value?.pausedSessions) ? value.pausedSessions : []),
  }
}

export class AutoContinueController {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.timing = copyTiming(options.timing ?? {})
    this.setTimer = options.setTimeout ?? setTimeout
    this.clearTimer = options.clearTimeout ?? clearTimeout
    this.states = new Map()
    this.recent = []
    this.readConfig = options.readConfig ?? (() => undefined)
    this.disposers = []
    this.disposed = false

    this.listen('session/event', (session, event) => this.onSessionEvent(session, event))
    this.listen('agent/status', payload => this.onAgentStatus(payload))
    this.listen('agent/inbox/inserted', payload => this.onInboxActivity(payload))
    this.listen('agent/inbox/claimed', payload => this.onInboxActivity(payload))
    this.listen('agent/inbox/discarded', payload => this.onInboxActivity(payload))
    this.listen('agent/disposed', ({ agent } = {}) => this.onAgentDisposed(agent))
    this.listen('session/disposed', session => this.onSessionDisposed(session))
  }

  listen(event, handler) {
    const dispose = this.ctx.on(event, handler, { global: true })
    if (typeof dispose === 'function') this.disposers.push(dispose)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.states.values()) this.clearPending(state)
    this.states.clear()
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
  }

  eligiblePair(session, agent = this.ctx.agents.get(session?.id)) {
    if (this.disposed
      || !session
      || !isNonEmptyString(session.id)
      || this.ctx.sessions.get(session.id) !== session
      || !isTopLevelSession(session)
      || !agent
      || agent.id !== session.id
      || agent.session !== session
      || this.ctx.agents.get(session.id) !== agent) {
      return undefined
    }
    return { session, agent }
  }

  stateFor(session) {
    const pair = this.eligiblePair(session)
    if (pair === undefined) return undefined
    const current = this.states.get(session.id)
    if (current !== undefined) {
      if (current.session === session && current.agent === pair.agent) return current
      this.removeState(current)
    }
    const state = {
      session,
      agent: pair.agent,
      turn: undefined,
      chain: undefined,
      inputTurn: undefined,
      expectedMessageId: undefined,
      latestRelevantSeq: -1,
      toolCalls: new Set(),
      toolError: false,
      toolOutcomeUncertain: false,
      pending: undefined,
    }
    this.states.set(session.id, state)
    return state
  }

  stateForAgent(agent) {
    if (!agent) return undefined
    const state = this.states.get(agent.id)
    if (state === undefined) return undefined
    if (state.agent !== agent || state.session !== agent.session) {
      this.removeState(state)
      return undefined
    }
    return state
  }

  activity() {
    return this.recent.slice()
  }

  record(state, result, reason, attempt) {
    this.recent.unshift({ at: Date.now(), sessionId: state.session.id, result, reason, attempt })
    if (this.recent.length > MAX_RECENT_ACTIVITY) this.recent.pop()
  }

  policyBlock(state, chain) {
    const policy = readPolicy(this.readConfig())
    if (!policy.enabled) return 'disabled'
    if (policy.pausedSessions.has(state.session.id)) return 'session-paused'
    if (chain.attempts >= policy.maxContinuations) return 'limit'
    return undefined
  }

  configurationChanged() {
    for (const state of this.states.values()) {
      if (state.pending === undefined) continue
      const reason = this.policyBlock(state, state.pending.chain)
      if (reason) this.clearPending(state, reason)
    }
  }

  clearPending(state, reason) {
    const pending = state.pending
    if (pending === undefined) return
    this.clearTimer(pending.timer)
    state.pending = undefined
    state.chain = undefined
    if (reason) this.record(state, 'cancelled', reason, pending.chain.attempts + 1)
  }

  removeState(state) {
    this.clearPending(state, 'session-closed')
    if (this.states.get(state.session.id) === state) this.states.delete(state.session.id)
  }

  onSessionEvent(session, event) {
    if (this.disposed || !session || !event || !Number.isSafeInteger(event.seq)) return
    if (!RELEVANT_SESSION_EVENTS.has(event.type)) return
    const state = this.stateFor(session)
    if (state === undefined) return

    if (state.pending !== undefined && event.seq >= state.pending.afterRelevantSeq) {
      const settingsChanged = ['model/selection', 'permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)
      this.clearPending(state, settingsChanged ? 'session-settings-changed' : 'session-activity')
    }
    state.latestRelevantSeq = event.seq

    switch (event.type) {
      case 'turn/start':
        this.onTurnStart(state, event)
        break
      case 'user/message':
        this.onUserMessage(state, event)
        break
      case 'tool/call':
        this.onToolCall(state, event)
        break
      case 'tool/result':
        this.onToolResult(state, event)
        break
      case 'turn/end':
        this.onTurnEnd(state, event)
        break
      default:
        break
    }
  }

  onTurnStart(state, event) {
    const turn = event.data?.turn
    if (!Number.isSafeInteger(turn) || turn <= 0) {
      state.turn = undefined
      state.toolCalls.clear()
      state.toolError = false
      state.toolOutcomeUncertain = true
      return
    }
    state.turn = turn
    state.inputTurn = undefined
    state.toolCalls.clear()
    state.toolError = false
    state.toolOutcomeUncertain = false
  }

  onUserMessage(state, event) {
    const message = event.data
    if (state.turn === undefined || message?.role !== 'user'
      || !isNonEmptyString(message.id) || !Array.isArray(message.content)) return
    if (message.source?.kind === 'user') {
      state.chain = { attempts: 0 }
      state.expectedMessageId = undefined
      state.inputTurn = state.turn
    } else if (message.source?.kind === SOURCE_KIND && message.id === state.expectedMessageId) {
      state.expectedMessageId = undefined
      state.inputTurn = state.turn
    }
  }

  onToolCall(state, event) {
    if (state.turn === undefined) {
      state.toolOutcomeUncertain = true
      return
    }
    const data = event.data
    const turn = data?.turn
    const callId = data?.callId
    if (turn !== state.turn
      || !isNonEmptyString(callId)
      || !isNonEmptyString(data?.name)
      || typeof data?.arguments !== 'string') {
      state.toolOutcomeUncertain = true
      return
    }
    state.toolCalls.add(callId)
  }

  onToolResult(state, event) {
    if (state.turn === undefined) {
      state.toolOutcomeUncertain = true
      return
    }
    const data = event.data
    const message = data?.message
    const callId = message?.toolCallId
    const valid = data?.turn === state.turn
      && Number.isSafeInteger(data?.step)
      && data.step > 0
      && isRecord(message)
      && message.role === 'tool'
      && isNonEmptyString(callId)
      && isRecord(message.source)
      && message.source.kind === 'tool'
      && message.source.callId === callId
      && Array.isArray(message.content)
      && (message.isError === undefined || typeof message.isError === 'boolean')
      && state.toolCalls.has(callId)
    if (!valid) {
      state.toolOutcomeUncertain = true
      return
    }
    state.toolCalls.delete(callId)
    if (message.isError === true) state.toolError = true
  }

  onTurnEnd(state, event) {
    const turn = event.data?.turn
    const chain = state.inputTurn === turn && state.turn === turn ? state.chain : undefined
    const toolRisk = state.toolError || state.toolOutcomeUncertain || state.toolCalls.size > 0
    state.turn = undefined
    state.inputTurn = undefined
    state.expectedMessageId = undefined
    state.chain = undefined
    state.toolCalls.clear()
    state.toolError = false
    state.toolOutcomeUncertain = false
    if (chain === undefined) return

    const outcome = classifyTurnEnd(event.data?.reason, this.timing)
    if (outcome === null) return
    const skip = toolRisk ? 'tool-outcome' : outcome.delayMs === undefined ? outcome.reason : this.policyBlock(state, chain)
    if (skip) {
      this.record(state, 'skipped', skip)
      return
    }
    this.schedule(state, chain, outcome)
  }

  schedule(state, chain, outcome) {
    const pending = {
      session: state.session,
      agent: state.agent,
      chain,
      reason: outcome.reason,
      afterRelevantSeq: state.latestRelevantSeq,
      timer: undefined,
    }
    pending.timer = this.setTimer(() => this.fire(pending), outcome.delayMs)
    state.pending = pending
  }

  fire(pending) {
    if (this.disposed) return
    const state = this.states.get(pending.session.id)
    if (state?.pending !== pending) return
    state.pending = undefined

    const policyBlock = this.policyBlock(state, pending.chain)
    if (policyBlock) {
      this.record(state, 'cancelled', policyBlock, pending.chain.attempts + 1)
      return
    }
    if (this.eligiblePair(pending.session, pending.agent) === undefined
      || state.turn !== undefined
      || state.latestRelevantSeq !== pending.afterRelevantSeq
      || pending.agent.status !== 'idle'
      || !emptyInbox(pending.agent)) {
      this.record(state, 'cancelled', 'session-unavailable', pending.chain.attempts + 1)
      return
    }

    const message = createContinuationMessage()
    const attempt = ++pending.chain.attempts
    state.chain = pending.chain
    state.expectedMessageId = message.id
    try {
      pending.agent.followup(message)
      this.record(state, 'sent', pending.reason, attempt)
    } catch {
      state.chain = undefined
      state.expectedMessageId = undefined
      this.record(state, 'cancelled', 'send-failed', attempt)
    }
  }

  onAgentStatus({ agent, status } = {}) {
    const state = this.stateForAgent(agent)
    if (state !== undefined && status !== 'idle') this.clearPending(state, 'session-activity')
  }

  onInboxActivity({ agent } = {}) {
    const state = this.stateForAgent(agent)
    if (state !== undefined) this.clearPending(state, 'session-activity')
  }

  onAgentDisposed(agent) {
    const state = agent === undefined ? undefined : this.states.get(agent.id)
    if (state !== undefined && state.agent === agent) this.removeState(state)
  }

  onSessionDisposed(session) {
    const state = session === undefined ? undefined : this.states.get(session.id)
    if (state !== undefined && state.session === session) this.removeState(state)
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const controller = new AutoContinueController(ctx)
    return () => controller.dispose()
  }, 'dsh-intranet-auto-continue: continuation state machine')
}
