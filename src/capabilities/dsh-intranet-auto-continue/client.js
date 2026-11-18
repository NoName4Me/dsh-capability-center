window.__ModuleLoader__.load({
  id: 'dsh-intranet-auto-continue',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const id = 'dsh-intranet-auto-continue'
    const slot = 'plugins.bundle.config'
    const activityUrl = '/api/dsh-intranet-auto-continue/activity'

    const reasons = {
      TIMEOUT: '模型请求超时',
      TRANSPORT: '连接中断',
      STREAM_CLOSED: '模型输出流提前结束',
      EMPTY_RESPONSE: '模型返回空响应',
      RATE_LIMIT: '模型服务限流',
      SERVER: '模型服务异常',
      'max-tokens': '达到输出上限',
      'retry-after-too-long': '服务要求等待过久',
      'unknown-failure': '结束原因不明',
      'non-retryable': '错误不符合续跑条件',
      auth: '模型认证失败或无权访问',
      quota: '模型服务额度不足',
      'context-window': '超出模型上下文长度',
      'unsupported-model': '模型不可用或不受支持',
      aborted: '会话已主动停止',
      blocked: '操作受策略限制',
      interrupted: '会话已中断',
      'tool-outcome': '工具执行失败或结果不确定',
      disabled: '自动续跑总开关已关闭',
      'session-paused': '该会话已暂停续跑',
      limit: '已达到本次任务的续跑次数上限',
      'session-settings-changed': '会话模型或权限设置已更改',
      'session-activity': '会话有新操作',
      'session-closed': '会话已关闭',
      'session-unavailable': '会话已忙碌、离开或有待处理消息',
      'send-failed': 'DSH 未确认接收续跑消息',
    }
    const outcomes = { sent: '已发送', skipped: '已跳过', cancelled: '已取消' }
    const secondary = 'var(--dsw-alias-label-secondary, inherit)'
    const border = 'var(--dsw-alias-border-l1, currentColor)'
    const fieldStyle = {
      font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: '1px solid ' + border, borderRadius: 6, padding: '6px 8px', maxWidth: '100%',
    }
    const actionStyle = { ...fieldStyle, cursor: 'pointer' }
    const button = (label, props = {}) => h('button', { type: 'button', style: actionStyle, ...props }, label)
    const rowStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center' }
    const headingStyle = { margin: '0 0 8px', fontWeight: 600, fontSize: 14 }
    const textStyle = { margin: '4px 0 10px', color: secondary }

    function ConfigPage({ form, sessions }) {
      const snapshot = React.useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form))
      const sessionList = React.useSyncExternalStore(sessions.subscribe.bind(sessions), sessions.getSnapshot.bind(sessions))
      const [draft, setDraft] = React.useState(null)
      const [selected, select] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [feedback, setFeedback] = React.useState('')
      const [activity, setActivity] = React.useState(null)
      const [activityError, setActivityError] = React.useState(false)
      const [refreshCount, refresh] = React.useReducer(count => count + 1, 0)
      const sectionId = React.useId()
      const sessionSelect = React.useRef(null)

      React.useEffect(() => {
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        void fetch(activityUrl, { signal }).then(response => {
          if (!response.ok) throw new Error('activity load failed')
          return response.json()
        }).then(value => {
          if (controller.signal.aborted) return
          setActivity(value)
          setActivityError(false)
        }).catch(() => {
          if (!controller.signal.aborted) setActivityError(true)
        })
        return () => controller.abort()
      }, [refreshCount])

      const config = snapshot.value
      const enabled = draft?.enabled ?? (config?.enabled !== false)
      const count = draft?.count ?? String(config?.maxContinuations ?? 1)
      const paused = config?.pausedSessions ?? []
      const maximum = activity?.maxContinuations ?? 5
      const pausedMaximum = activity?.maxPausedSessions ?? 100
      const countValid = /^\d+$/.test(count) && Number(count) >= 1 && Number(count) <= maximum
      const busy = saving || snapshot.status !== 'ready' || !snapshot.writable
      const stale = draft !== null && draft.revision !== snapshot.revision
      const records = activity?.records ?? []
      const titles = sessionList.byId ?? {}
      const visibleIds = (sessionList.ids ?? []).filter(key => titles[key]?.origin !== 'subagent')
      const options = [...new Set([...paused, ...records.map(record => record.sessionId), ...visibleIds])]
      const selectedSession = options.includes(selected) ? selected : ''
      const isPaused = paused.includes(selectedSession)
      const title = key => titles[key]?.displayTitle || titles[key]?.title || key

      function edit(changes) {
        setFeedback('')
        setDraft({ enabled, count, revision: draft?.revision ?? snapshot.revision, ...changes })
      }

      async function save(operations, revision, afterSave = () => {}) {
        setSaving(true)
        setFeedback('')
        try {
          if (await form.mutate(operations, revision)) {
            afterSave()
            setFeedback('已保存，立即生效。')
            refresh()
          } else {
            setFeedback('保存失败或配置已变化。请核对当前设置后重试。')
          }
        } catch {
          setFeedback('保存失败，请重试。')
        } finally {
          setSaving(false)
        }
      }

      function savePolicy(event) {
        event.preventDefault()
        if (busy || stale || !countValid || draft === null) return
        const operations = []
        if (enabled !== config.enabled) operations.push({ op: 'set', path: ['enabled'], value: enabled })
        if (Number(count) !== config.maxContinuations) operations.push({ op: 'set', path: ['maxContinuations'], value: Number(count) })
        if (operations.length === 0) {
          setDraft(null)
          return
        }
        void save(operations, draft.revision, () => setDraft(null))
      }

      function togglePause() {
        if (busy || !selectedSession || draft || (!isPaused && paused.length >= pausedMaximum)) return
        const next = isPaused ? paused.filter(key => key !== selectedSession) : [...paused, selectedSession]
        void save([{ op: 'set', path: ['pausedSessions'], value: next }], snapshot.revision)
      }

      return h('section', { 'aria-labelledby': sectionId, style: { paddingBlock: 12, display: 'grid', gap: 16 } },
        h('div', null,
          h('h3', { id: sectionId, style: headingStyle }, '续跑设置'),
          snapshot.status !== 'ready' && h('p', { role: 'status', style: textStyle },
            snapshot.status === 'loading' ? '正在读取设置…' : '当前 DSH 未提供续跑设置。'),
          snapshot.status === 'ready' && !snapshot.writable && h('p', { style: textStyle }, '当前 DSH 配置为只读。'),
          h('form', { onSubmit: savePolicy },
            h('div', { style: { ...rowStyle, columnGap: 22 } },
              h('label', { style: rowStyle },
                h('input', { type: 'checkbox', checked: enabled, disabled: busy, onChange: event => edit({ enabled: event.target.checked }) }),
                '启用自动续跑'),
              h('label', { style: rowStyle },
                '每项任务最多续跑',
                h('input', {
                  type: 'number', min: 1, max: maximum, step: 1, required: true, value: count,
                  style: { ...fieldStyle, width: '4.5em' }, disabled: busy,
                  onChange: event => edit({ count: event.target.value }),
                }),
                '次'),
              button(saving ? '保存中…' : '保存设置', { type: 'submit', disabled: busy || !countValid || !draft || stale }),
              draft && button('放弃更改', { disabled: saving, onClick: () => setDraft(null) })),
            h('p', { style: textStyle }, stale ? '设置已在另一处更改。放弃当前编辑后可重新修改。' : '默认续跑 1 次。发送新消息后重新计数。'))),
        h('div', { style: { borderTop: '1px solid ' + border, paddingTop: 12 } },
          h('h3', { style: headingStyle }, '会话暂停'),
          h('div', { style: rowStyle },
            h('select', {
              'aria-label': '选择会话', disabled: busy || options.length === 0, style: { ...fieldStyle, width: 'min(100%, 20rem)' },
              ref: sessionSelect, value: selectedSession, onChange: event => select(event.target.value),
            },
              h('option', { value: '' }, options.length ? '选择会话' : '暂无会话'),
              ...options.map(key => h('option', { key, value: key }, title(key) + (paused.includes(key) ? '（已暂停）' : '')))),
            button(isPaused ? '恢复该会话' : '暂停该会话', {
              disabled: busy || !selectedSession || Boolean(draft) || (!isPaused && paused.length >= pausedMaximum),
              onClick: togglePause,
            })),
          h('p', { style: textStyle }, draft ? '请先保存或放弃上方设置。' : '暂停后会取消该会话正在等待的续跑。'),
          h('div', { role: 'status' }, feedback)),
        h('div', { style: { borderTop: '1px solid ' + border, paddingTop: 12 } },
          h('div', { style: { ...rowStyle, justifyContent: 'space-between' } },
            h('h3', { style: headingStyle }, '最近续跑记录'),
            button('刷新记录', { onClick: refresh })),
          h('p', { style: textStyle }, activityError ? '读取记录失败，请刷新重试。' : '最多显示 30 条，DSH 重启后清空。'),
          !activityError && !activity && h('p', { role: 'status' }, '正在读取记录…'),
          activity && records.length === 0 && h('p', { style: textStyle }, '暂无续跑记录。'),
          records.length > 0 && h('ol', { style: { margin: 0, padding: 0, listStyle: 'none' } },
            ...records.map((record, index) => h('li', {
              key: record.at + ':' + index, style: { borderTop: '1px solid ' + border, paddingBlock: 7, overflowWrap: 'anywhere' },
            },
              h('div', { style: rowStyle },
                h('strong', null, outcomes[record.result] ?? '状态未知'),
                h('time', { dateTime: new Date(record.at).toISOString(), style: { color: secondary, fontVariantNumeric: 'tabular-nums' } },
                  new Date(record.at).toLocaleString('zh-CN', { hour12: false })),
                record.attempt !== undefined && h('span', null, '第 ' + record.attempt + ' 次')),
              h('div', null, reasons[record.reason] ?? '原因未知'),
              button(title(record.sessionId), {
                onClick: () => {
                  select(record.sessionId)
                  sessionSelect.current?.focus()
                },
                title: '选择此会话',
              }))))),
      )
    }

    return {
      inject: ['slots', 'configForms', 'sessions'],
      apply(ctx) {
        const form = ctx.configForms.get(id)
        const sessions = ctx.sessions.list
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key: id }, ({ view }) =>
          view === 'page' ? h(ConfigPage, { form, sessions }) : null))
      },
    }
  },
})
