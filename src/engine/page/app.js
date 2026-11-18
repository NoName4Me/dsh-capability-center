(() => {
  'use strict';

  const STORAGE_KEY = 'capability-center.serverUrl';
  const TYPE_LABELS = { skill: '技能', plugin: '插件', python: 'Python 库', composite: '组合' };
  const OPEN_DRAFT = 'capability-center/open-draft';
  const OPEN_DRAFT_ACK = 'capability-center/open-draft-ack';
  const DRAFT_ACK_TIMEOUT_MS = 16_000;
  const state = {
    catalog: [],
    localStates: {},
    online: false,
    onlineError: null,
    filter: 'all',
    query: '',
    loading: false,
    error: null,
    serverUrl: localStorage.getItem(STORAGE_KEY) || '',
    operations: new Map(),
    openItems: new Set(),
    draftAttempts: new Map(),
    pendingDraftRequests: new Map(),
    core: null,
    coreCheck: null,
    coreBusy: false,
    migration: false,
    recoveryRequired: false,
    recoveryMessages: [],
  };

  const elements = {
    sourceForm: document.getElementById('source-form'),
    serverUrl: document.getElementById('server-url'),
    connectButton: document.getElementById('connect-button'),
    offlineButton: document.getElementById('offline-button'),
    connection: document.getElementById('connection'),
    connectionText: document.getElementById('connection-text'),
    summary: document.getElementById('catalog-summary'),
    statePanel: document.getElementById('state-panel'),
    list: document.getElementById('capability-list'),
    filters: document.getElementById('filters'),
    search: document.getElementById('search-input'),
    coreVersion: document.getElementById('core-version'),
    coreCheck: document.getElementById('core-check'),
    coreStage: document.getElementById('core-stage'),
    coreNotice: document.getElementById('core-notice'),
    migrationNotice: document.getElementById('migration-notice'),
    recoveryNotice: document.getElementById('recovery-notice'),
  };

  const HOST_TOKENS = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
  ];

  function systemScheme() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function syncHostTheme() {
    let scheme = systemScheme();
    let tokenSource = null;
    let hostDocument = null;
    try {
      if (window.parent !== window) {
        hostDocument = window.parent.document;
        const hostRoot = hostDocument.documentElement;
        const hostBody = hostDocument.body;
        const source = hostBody ?? hostRoot;
        const sourceScheme = hostRoot.dataset.dsThemeSource;
        if (hostBody?.hasAttribute('data-ds-dark-theme')) {
          scheme = 'dark';
        } else if (hostBody) {
          scheme = 'light';
        } else if (sourceScheme === 'dark' || sourceScheme === 'light') {
          scheme = sourceScheme;
        } else if (window.parent.getComputedStyle(hostRoot).colorScheme.includes('dark')) {
          scheme = 'dark';
        }
        tokenSource = source;
      }
    } catch {
      scheme = systemScheme();
    }

    document.documentElement.dataset.theme = scheme;
    document.documentElement.style.colorScheme = scheme;
    if (hostDocument !== null && tokenSource !== null) {
      const computed = window.parent.getComputedStyle(tokenSource);
      const tokens = HOST_TOKENS.map(token => [token, computed.getPropertyValue(token).trim()]);
      for (const token of HOST_TOKENS) document.documentElement.style.removeProperty(token);
      for (const [token, value] of tokens) {
        if (value) document.documentElement.style.setProperty(token, value);
      }
    }
  }

  function el(tag, attributes = {}, text = undefined) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) continue;
      if (name === 'className') node.className = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2).toLowerCase(), value);
      else if (value === true) node.setAttribute(name, '');
      else node.setAttribute(name, String(value));
    }
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function setConnection(kind, text) {
    elements.connection.dataset.state = kind;
    elements.connectionText.textContent = text;
  }

  function setLoading(loading) {
    state.loading = loading;
    elements.connectButton.disabled = loading;
    elements.offlineButton.disabled = loading;
    elements.connectButton.textContent = loading ? '正在刷新' : '保存并刷新';
    elements.coreCheck.disabled = loading || state.coreBusy || !state.serverUrl;
  }

  function showState(title, detail, kind = 'empty') {
    elements.statePanel.hidden = false;
    elements.statePanel.dataset.state = kind;
    elements.statePanel.replaceChildren();
    const mark = el('div', { className: 'empty-mark', 'aria-hidden': 'true' });
    mark.innerHTML = kind === 'error'
      ? '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="17"/><path d="M24 14v12M24 32v.2"/></svg>'
      : '<svg viewBox="0 0 48 48"><rect x="7" y="7" width="14" height="14" rx="2"/><rect x="27" y="7" width="14" height="14" rx="2"/><rect x="7" y="27" width="14" height="14" rx="2"/><path d="M34 27v14M27 34h14"/></svg>';
    elements.statePanel.append(mark, el('strong', {}, title), el('span', {}, detail));
  }

  function parseVersion(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(value ?? ''));
    return match === null ? null : {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] === undefined ? [] : match[4].split('.'),
    };
  }

  function compareVersions(leftValue, rightValue) {
    const left = parseVersion(leftValue);
    const right = parseVersion(rightValue);
    if (left === null || right === null) return 0;
    for (let index = 0; index < 3; index += 1) {
      if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index];
    }
    if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
    if (left.prerelease.length === 0) return 1;
    if (right.prerelease.length === 0) return -1;
    return left.prerelease.join('.').localeCompare(right.prerelease.join('.'));
  }

  function applyPayload(payload) {
    state.catalog = Array.isArray(payload.catalog?.items) ? payload.catalog.items : [];
    state.localStates = payload.localStates || {};
    state.online = payload.online === true;
    state.onlineError = payload.onlineError || null;
    state.error = null;
    state.migration = payload.legacyManagerEnabled === true;
    state.recoveryRequired = payload.recoveryRequired === true;
    state.recoveryMessages = payload.recoveryMessages || [];
    if (payload.core) state.core = { ...(state.core || {}), ...payload.core };
    const visibleCount = state.catalog.filter(item => item.hidden !== true).length;
    elements.summary.textContent = `${payload.catalog?.name || '能力目录'} · ${visibleCount} 项 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 更新`;
    renderStatusMessages();
  }

  async function load(serverUrl) {
    state.loading = true;
    setLoading(true);
    setConnection('loading', '正在读取');
    showState('正在读取能力', '目录不可用时仍会显示本机账本。', 'empty');
    elements.list.replaceChildren();
    try {
      const query = serverUrl ? `?server=${encodeURIComponent(serverUrl)}` : '';
      const response = await fetch(`/capability-center/api/status${query}`, {
        headers: { accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      applyPayload(payload);
      setConnection(state.online ? 'online' : 'offline', state.online ? '目录可用' : '本机账本');
      if (state.onlineError) showState('目录暂不可用', `${state.onlineError} 已安装能力仍可检查和卸载。`, 'empty');
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.catalog = [];
      state.localStates = {};
      setConnection('error', '读取失败');
      elements.summary.textContent = '本机账本与目录均未读取';
      showState('读取失败', state.error, 'error');
    } finally {
      state.loading = false;
      setLoading(false);
      render();
    }
  }

  async function submitServer(event) {
    event?.preventDefault();
    const serverUrl = elements.serverUrl.value.trim();
    if (!serverUrl) {
      state.error = '请填写内网分发服务器地址。';
      renderStatusMessages();
      return;
    }
    localStorage.setItem(STORAGE_KEY, serverUrl);
    state.serverUrl = serverUrl;
    elements.coreCheck.disabled = false;
    await load(serverUrl);
  }

  async function loadOffline() {
    await load('');
  }

  function localState(item) {
    return state.localStates[item.id] || {};
  }

  function statusFor(item) {
    const local = localState(item);
    if (!local.installed) {
      if (item.delisted) return { kind: 'warning', label: '已下架', detail: '本机仍保留安装记录，可检查或卸载。' };
      return { kind: 'idle', label: '未安装', detail: local.detail || '本机账本未记录。' };
    }
    const current = local.currentVersion || item.version;
    if (compareVersions(item.version, current) > 0 && state.online && !item.delisted) {
      return { kind: 'warning', label: '可更新', detail: `本机 ${current}，目录 ${item.version}` };
    }
    if (local.ready) return { kind: 'ready', label: '可使用', detail: local.detail || '自动检查通过' };
    if (local.activation === 'restart-required') {
      return { kind: 'warning', label: '等待重启', detail: local.detail || '安装已保存，运行态尚未生效' };
    }
    if (local.legacy) return { kind: 'warning', label: '旧版已检测', detail: local.detail || '保留原安装，可检查或卸载' };
    return { kind: 'warning', label: '检查异常', detail: local.detail || '运行“检查与修复”查看原因' };
  }

  function visibleItems() {
    return state.catalog.filter(item => {
      if (item.hidden === true) return false;
      const local = localState(item);
      if (state.filter === 'installed' && !local.installed) return false;
      if (!['all', 'installed'].includes(state.filter) && item.type !== state.filter) return false;
      if (!state.query) return true;
      const haystack = `${item.name} ${item.description} ${item.id} ${item.version}`.toLocaleLowerCase('zh-CN');
      return haystack.includes(state.query.toLocaleLowerCase('zh-CN'));
    });
  }

  function render() {
    elements.list.replaceChildren();
    if (state.loading) return;
    if (state.error) return;
    const items = visibleItems();
    if (items.length === 0) {
      showState(
        state.catalog.length === 0 ? '本机暂无能力记录' : '没有匹配的能力',
        state.catalog.length === 0 ? '连接内网目录后即可安装能力；已安装项不需要分发服务也能管理。' : '清空搜索或切换类型后重试。',
        'empty',
      );
      return;
    }
    elements.statePanel.hidden = true;
    for (const item of items) elements.list.append(renderItem(item));
  }

  function primaryAction(item, status, busy) {
    const local = localState(item);
    const operation = state.operations.get(item.id);
    if (busy) {
      return el('button', { className: 'button button-primary', type: 'button', disabled: true },
        operation?.phase || '处理中');
    }
    if (!local.installed) {
      return el('button', {
        className: 'button button-primary',
        type: 'button',
        disabled: !state.online,
        title: state.online ? '' : '安装需要先连接内网目录',
        onclick: () => runAction(item, 'install'),
      }, '安装');
    }
    if (status.label === '可更新') {
      return el('button', {
        className: 'button button-primary',
        type: 'button',
        onclick: () => runAction(item, 'update'),
      }, '更新');
    }
    if (local.ready) {
      return el('button', {
        className: 'button button-primary',
        type: 'button',
        onclick: () => openTrialDraft(item),
      }, '试用');
    }
    return el('button', {
      className: 'button',
      type: 'button',
      onclick: () => runAction(item, 'diagnose'),
    }, '检查与修复');
  }

  function renderItem(item) {
    const status = statusFor(item);
    const local = localState(item);
    const operation = state.operations.get(item.id);
    const busy = operation && !operation.terminal;
    const trialPending = state.draftAttempts.get(item.id)?.status === 'pending';
    const listItem = el('li', { className: 'capability-item', 'data-item-id': item.id });
    const row = el('div', { className: 'capability-row' });
    row.append(el('span', { className: 'type-label' }, TYPE_LABELS[item.type] || item.type));

    const main = el('div', { className: 'capability-main' });
    const nameLine = el('div', { className: 'capability-name-line' });
    nameLine.append(
      el('strong', { className: 'capability-name' }, item.name),
      el('span', { className: 'version' }, `v${local.currentVersion || item.version}`),
    );
    main.append(nameLine, el('p', { className: 'capability-description' }, item.description));

    const localStateNode = el('span', {
      className: 'local-state',
      'data-state': status.kind,
      title: status.detail,
    }, status.label);

    const actions = el('div', { className: 'row-actions' });
    const primary = primaryAction(item, status, busy || trialPending);
    if (trialPending) primary.textContent = '正在新建';
    actions.append(primary);
    const more = el('details', { className: 'row-more' });
    more.append(el('summary', {}, '更多'));
    const menu = el('div', { className: 'more-menu' });
    menu.append(el('button', {
      type: 'button',
      disabled: busy || !local.installed,
      onclick: () => { more.open = false; runAction(item, 'diagnose'); },
    }, '检查与修复'));
    menu.append(el('button', {
      type: 'button',
      disabled: busy || !local.installed || local.preexisting
        || state.draftAttempts.get(item.id)?.status === 'pending',
      title: local.preexisting ? '旧版插件由 DSH 插件页管理，能力中心不会移除。' : undefined,
      onclick: () => {
        if (local.preexisting) return;
        more.open = false;
        runAction(item, 'uninstall');
      },
    }, local.preexisting ? '卸载（到插件页）' : '卸载'));
    if (local.preexisting) {
      menu.append(el('span', { className: 'more-note' }, '此项需到“DSH 插件页”管理'));
    }
    menu.append(el('button', {
      type: 'button',
      onclick: () => {
        more.open = false;
        state.openItems.add(item.id);
        render();
        detailsRoot(item.id)?.scrollIntoView?.({ block: 'nearest' });
      },
    }, '详情'));
    more.append(menu);
    actions.append(more);
    row.append(main, localStateNode, actions);
    listItem.append(row, renderDraftFeedback(item.id));

    if (operation || state.openItems.has(item.id)) {
      const details = el('section', { className: 'capability-details', 'data-details-for': item.id });
      details.append(renderUsage(item));
      details.append(renderDetailGrid(item, status));
      if (operation) details.append(renderOperation(item, operation));
      listItem.append(details);
    }
    return listItem;
  }

  function renderUsage(item) {
    const usage = item.usage || {};
    const section = el('section', { className: 'usage-guide', 'aria-label': '使用说明' });
    section.append(el('h3', {}, '使用说明'));
    const steps = el('ol', { className: 'usage-steps' });
    for (const step of usage.steps || []) steps.append(el('li', {}, step));
    section.append(steps);
    const fields = el('dl', { className: 'usage-fields' });
    if (usage.inputs) fields.append(el('dt', {}, '需要输入'), el('dd', {}, usage.inputs));
    if (usage.output) fields.append(el('dt', {}, '得到输出'), el('dd', {}, usage.output));
    if (usage.example) fields.append(el('dt', {}, '示例'), el('dd', { className: 'usage-example' }, usage.example));
    section.append(fields);
    return section;
  }

  function renderDetailGrid(item, status) {
    const local = localState(item);
    const grid = el('dl', { className: 'detail-grid' });
    const values = [
      ['条目 ID', item.id],
      ['类型', TYPE_LABELS[item.type] || item.type],
      ['版本', `目录 ${item.version}${local.currentVersion ? ` / 本机 ${local.currentVersion}` : ''}`],
      ['来源', local.source || (item.delisted ? '本机缓存' : '内网目录')],
      ['制品', item.artifact?.path || '组合能力（无独立制品）'],
      ['SHA-256', item.artifact?.sha256 || '由固定依赖版本约束'],
      ['本机状态', status.detail],
      ['依赖', (item.dependencies || []).map(value => `${value.id}@${value.version}`).join('、') || '无'],
    ];
    for (const [label, value] of values) grid.append(el('dt', {}, label), el('dd', {}, value));
    return grid;
  }

  function renderDraftFeedback(itemId) {
    const host = el('div', {
      className: 'draft-feedback-host',
      'data-draft-host': itemId,
      'aria-live': 'polite',
    });
    const attempt = state.draftAttempts.get(itemId);
    if (attempt) host.append(el('div', { className: 'draft-feedback', 'data-state': attempt.status }, attempt.message));
    return host;
  }

  function renderOperation(item, operation) {
    const root = el('section', {
      className: 'operation',
      'data-status': operation.status,
      'aria-label': `${item.name} ${operation.action}状态`,
      tabindex: '-1',
    });
    const head = el('div', { className: 'operation-head' });
    const label = { install: '安装', update: '更新', diagnose: '检查', uninstall: '卸载' }[operation.action] || operation.action;
    head.append(
      el('span', { className: 'operation-title' }, `${label}进度`),
      el('span', { className: 'operation-phase' }, operation.error ? `失败：${operation.error}` : operation.phase),
    );
    const track = el('div', {
      className: 'progress-track',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(Math.round((operation.progress || 0) * 100)),
    });
    const value = el('div', { className: 'progress-value' });
    value.style.width = `${Math.round((operation.progress || 0) * 100)}%`;
    track.append(value);
    root.append(head, track);
    if (operation.error) root.append(el('p', { className: 'operation-error' }, operation.error));
    if (operation.logs?.length) {
      const logs = el('ol', { className: 'log-list' });
      for (const entry of operation.logs) logs.append(el('li', {}, entry.message));
      root.append(logs);
    }
    return root;
  }

  function detailsRoot(itemId) {
    return elements.list.querySelector(`[data-item-id="${itemId}"] [data-details-for="${itemId}"]`);
  }

  async function runAction(item, action) {
    const current = state.operations.get(item.id);
    if (current && !current.terminal) return;
    const placeholder = {
      action,
      status: 'queued',
      phase: '正在提交',
      progress: 0,
      logs: [],
      terminal: false,
    };
    state.operations.set(item.id, placeholder);
    state.openItems.add(item.id);
    render();
    operationRoot(item.id)?.focus();
    try {
      const response = await fetch(`/capability-center/api/actions/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-capability-center': '1',
        },
        body: JSON.stringify({ serverUrl: state.serverUrl, itemId: item.id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      state.operations.set(item.id, payload.operation);
      updateOperation(item, payload.operation);
      await pollOperation(item, payload.operation.id);
    } catch (error) {
      state.operations.set(item.id, {
        ...placeholder,
        status: 'failed',
        terminal: true,
        phase: '失败',
        progress: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      render();
      operationRoot(item.id)?.focus();
    }
  }

  async function pollOperation(item, id) {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const response = await fetch(`/capability-center/api/operations/${encodeURIComponent(id)}`, {
        headers: { accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      const operation = payload.operation;
      state.operations.set(item.id, operation);
      updateOperation(item, operation);
      if (operation.terminal) {
        await load(state.serverUrl);
        return;
      }
    }
  }

  function updateOperation(item, operation) {
    const itemNode = elements.list.querySelector(`[data-item-id="${item.id}"]`);
    if (!itemNode || !operation) return;
    state.openItems.add(item.id);
    render();
    operationRoot(item.id)?.focus();
  }

  function operationRoot(itemId) {
    return elements.list.querySelector(`[data-item-id="${itemId}"] .operation`);
  }

  function draftRequestId() {
    try {
      return globalThis.crypto.randomUUID().replaceAll('-', '_');
    } catch {
      return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    }
  }

  function setDraftAttempt(itemId, attempt) {
    state.draftAttempts.set(itemId, attempt);
    updateDraftFeedback(itemId);
    render();
  }

  function updateDraftFeedback(itemId) {
    const host = elements.list.querySelector(`[data-draft-host="${itemId}"]`);
    if (!host) return;
    host.replaceChildren();
    const attempt = state.draftAttempts.get(itemId);
    if (attempt) host.append(el('div', { className: 'draft-feedback', 'data-state': attempt.status }, attempt.message));
  }

  async function openTrialDraft(item) {
    const existing = state.draftAttempts.get(item.id);
    if (existing?.status === 'pending') return;
    if (window.parent === window) {
      setDraftAttempt(item.id, {
        status: 'error',
        message: '独立预览无法创建 DSH 会话。请从 DSH 侧栏“能力中心”打开后试用。',
      });
      return;
    }
    const requestId = draftRequestId();
    const timer = setTimeout(() => {
      const pending = state.pendingDraftRequests.get(requestId);
      if (!pending) return;
      state.pendingDraftRequests.delete(requestId);
      setDraftAttempt(item.id, { status: 'error', message: '等待 DSH 确认超时，请重新打开能力中心后再试。' });
    }, DRAFT_ACK_TIMEOUT_MS);
    state.pendingDraftRequests.set(requestId, { itemId: item.id, timer });
    setDraftAttempt(item.id, { status: 'pending', message: '正在验证试用提示词并新建 DSH 会话。' });
    try {
      const response = await fetch('/capability-center/api/trials/prepare', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-capability-center': '1',
        },
        body: JSON.stringify({
          serverUrl: state.serverUrl,
          itemId: item.id,
          requestId,
          source: 'capability-center-frame',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      window.parent.postMessage({
        type: OPEN_DRAFT,
        requestId,
        itemId: item.id,
        prompt: payload.prompt,
        origin: window.location.origin,
      }, window.location.origin);
    } catch (error) {
      clearTimeout(timer);
      state.pendingDraftRequests.delete(requestId);
      setDraftAttempt(item.id, {
        status: 'error',
        message: `试用未打开：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  function handleDraftAck(event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = event.data;
    if (typeof message !== 'object' || message === null
      || message.type !== OPEN_DRAFT_ACK
      || typeof message.requestId !== 'string'
      || typeof message.ok !== 'boolean') return;
    const pending = state.pendingDraftRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingDraftRequests.delete(message.requestId);
    if (message.ok) {
      setDraftAttempt(pending.itemId, {
        status: 'success',
        message: '已在新会话中填入试用提示词；草稿尚未发送，请检查后手动发送。',
      });
      return;
    }
    const error = typeof message.error === 'string' && message.error.trim()
      ? message.error.trim().slice(0, 240)
      : 'DSH 未能创建新会话草稿。';
    setDraftAttempt(pending.itemId, { status: 'error', message: `试用未打开：${error}` });
  }

  function renderStatusMessages() {
    elements.migrationNotice.hidden = !state.migration;
    elements.recoveryNotice.hidden = !state.recoveryRequired;
    if (state.recoveryRequired) {
      elements.recoveryNotice.replaceChildren(
        el('strong', {}, '需要恢复确认'),
        el('span', {}, state.recoveryMessages.join('；') || '检测到未完成操作，已停止自动修改。'),
      );
    }
    elements.coreVersion.textContent = state.core?.version ? `v${state.core.version}` : '不可用';
    elements.coreCheck.disabled = state.loading || state.coreBusy || !state.serverUrl;
    const check = state.coreCheck;
    const pending = state.core?.pending ?? null;
    if (pending?.version) {
      elements.coreNotice.hidden = false;
      elements.coreNotice.replaceChildren(
        el('strong', {}, `核心 v${pending.version} 已准备更新`),
        el('span', {}, '当前运行时继续使用稳定版本。请在你方便时重启 DSH，下一次启动会自动切换；失败会回退上一核心。'),
        el('button', { className: 'button button-quiet', type: 'button', onclick: () => { elements.coreNotice.hidden = true; } }, '知道了'),
      );
      elements.coreStage.hidden = true;
    } else if (state.coreCheck?.updateAvailable) {
      elements.coreNotice.hidden = false;
      elements.coreNotice.replaceChildren(
        el('strong', {}, `核心 v${state.coreCheck.latestVersion} 可用`),
        el('span', {}, '先下载并校验内网 ZIP，准备完成后不会自动重启或打断当前任务。'),
      );
      elements.coreStage.hidden = false;
      elements.coreStage.textContent = state.coreBusy ? '正在准备' : '准备更新';
      elements.coreStage.disabled = state.coreBusy;
    } else {
      elements.coreNotice.hidden = true;
      elements.coreStage.hidden = true;
    }
  }

  async function loadCoreStatus() {
    try {
      const response = await fetch('/capability-center/api/core/status', { headers: { accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      state.core = payload;
    } catch (error) {
      state.core = { version: null, error: error instanceof Error ? error.message : String(error) };
    }
    renderStatusMessages();
  }

  async function checkCoreUpdate() {
    if (!state.serverUrl || state.coreBusy) return;
    state.coreBusy = true;
    elements.coreCheck.disabled = true;
    elements.coreCheck.textContent = '正在检查';
    try {
      const response = await fetch(`/capability-center/api/core/check?server=${encodeURIComponent(state.serverUrl)}`, {
        headers: { accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      state.coreCheck = payload;
    } catch (error) {
      state.coreCheck = null;
      elements.coreNotice.hidden = false;
      elements.coreNotice.replaceChildren(
        el('strong', {}, '核心更新检查失败'),
        el('span', {}, error instanceof Error ? error.message : String(error)),
      );
    } finally {
      state.coreBusy = false;
      elements.coreCheck.disabled = false;
      elements.coreCheck.textContent = '检查更新';
      renderStatusMessages();
    }
  }

  async function stageCoreUpdate() {
    if (!state.serverUrl || state.coreBusy) return;
    state.coreBusy = true;
    renderStatusMessages();
    try {
      const response = await fetch('/capability-center/api/core/stage', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-capability-center': '1',
        },
        body: JSON.stringify({ serverUrl: state.serverUrl }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      await loadCoreStatus();
      state.core.pending = { version: payload.version };
    } catch (error) {
      elements.coreNotice.hidden = false;
      elements.coreNotice.replaceChildren(
        el('strong', {}, '核心更新准备失败'),
        el('span', {}, `${error instanceof Error ? error.message : String(error)} 当前核心继续运行。`),
      );
    } finally {
      state.coreBusy = false;
      renderStatusMessages();
    }
  }

  elements.sourceForm.addEventListener('submit', submitServer);
  elements.offlineButton.addEventListener('click', loadOffline);
  elements.coreCheck.addEventListener('click', checkCoreUpdate);
  elements.coreStage.addEventListener('click', stageCoreUpdate);
  window.addEventListener('message', handleDraftAck);
  elements.filters.addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const candidate of elements.filters.querySelectorAll('[data-filter]')) {
      candidate.setAttribute('aria-pressed', String(candidate === button));
    }
    render();
  });
  elements.search.addEventListener('input', () => {
    state.query = elements.search.value.trim();
    render();
  });

  syncHostTheme();
  if (window.parent !== window) {
    try {
      const observer = new MutationObserver(syncHostTheme);
      observer.observe(window.parent.document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-ds-theme-source', 'data-theme'],
      });
      if (window.parent.document.body) {
        observer.observe(window.parent.document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
        });
      }
    } catch {
      // Parent theme observation is optional when host access is unavailable.
    }
  }
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncHostTheme);

  elements.serverUrl.value = state.serverUrl;
  setLoading(false);
  void Promise.all([loadCoreStatus(), load(state.serverUrl)]);
})();
