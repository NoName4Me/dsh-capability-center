window.__ModuleLoader__.load({
  id: 'capability-center',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'capability-center';
    const PREFIX = '/capability-center';
    const OPEN_DRAFT = 'capability-center/open-draft';
    const OPEN_DRAFT_ACK = 'capability-center/open-draft-ack';
    const REQUEST_ID = /^[A-Za-z0-9_-]{8,96}$/;
    const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const MESSAGE_KEYS = new Set(['type', 'requestId', 'itemId', 'prompt', 'origin']);
    const DRAFT_TIMEOUT_MS = 15_000;
    const MAX_REMEMBERED_REQUESTS = 100;
    const MAX_PROMPT_LENGTH = 4_000;

    function isMessage(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      return keys.length === MESSAGE_KEYS.size
        && keys.every(key => MESSAGE_KEYS.has(key))
        && value.type === OPEN_DRAFT
        && typeof value.requestId === 'string'
        && REQUEST_ID.test(value.requestId)
        && typeof value.itemId === 'string'
        && ITEM_ID.test(value.itemId)
        && typeof value.prompt === 'string'
        && value.prompt.trim().length > 0
        && value.prompt.length <= MAX_PROMPT_LENGTH
        && !value.prompt.includes('\0')
        && value.origin === window.location.origin;
    }

    function errorText(error) {
      const text = error instanceof Error ? error.message : String(error || '创建会话草稿失败。');
      return text.slice(0, 240);
    }

    function abortable(operation, signal) {
      if (signal.aborted) return Promise.reject(signal.reason || new Error('请求已中止。'));
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error('请求已中止。'));
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(operation).then(
          value => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    }

    function recentWorkspaceId(workspaceSnapshot, sessionSnapshot) {
      if (workspaceSnapshot?.phase !== 'ready' || sessionSnapshot?.phase !== 'ready') return undefined;
      let selected;
      let selectedTime = Number.NEGATIVE_INFINITY;
      for (const workspace of workspaceSnapshot.items || []) {
        let latest = Number.NEGATIVE_INFINITY;
        for (const sessionId of workspace.sessionIds || []) {
          const session = sessionSnapshot.byId?.[sessionId];
          if (session !== undefined && Number.isFinite(session.updatedAt)) {
            latest = Math.max(latest, session.updatedAt);
          }
        }
        if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt);
        if (!Number.isFinite(latest)) latest = Number.NEGATIVE_INFINITY;
        if (selected === undefined || latest > selectedTime) {
          selected = workspace.workspaceId;
          selectedTime = latest;
        }
      }
      return selected;
    }

    module.exports = {
      inject: ['slots', 'sessions', 'workspaces', 'conversation', 'uiWorkspace'],
      apply(ctx) {
        const sessions = ctx.get('sessions') ?? ctx.sessions;
        const workspaces = ctx.get('workspaces') ?? ctx.workspaces;
        const conversation = ctx.get('conversation') ?? ctx.conversation;
        const workspaceNavigation = ctx.get('uiWorkspace') ?? ctx.uiWorkspace;
        let frameWindow;
        let bridgeDisposed = false;
        const pendingItems = new Set();
        const pendingControllers = new Set();
        const rememberedRequests = new Set();

        function postAck(source, origin, requestId, ok, error) {
          if (!source || typeof source.postMessage !== 'function') return;
          const payload = { type: OPEN_DRAFT_ACK, requestId, ok };
          if (!ok) payload.error = errorText(error);
          try {
            source.postMessage(payload, origin);
          } catch {
            // The frame may have closed while the session request settled.
          }
        }

        async function openDraft(message, source, origin) {
          const { requestId, itemId, prompt } = message;
          if (bridgeDisposed) {
            postAck(source, origin, requestId, false, '能力中心已关闭，请重新打开。');
            return;
          }
          if (rememberedRequests.has(requestId) || pendingItems.has(itemId)) {
            postAck(source, origin, requestId, false, '该试用正在打开，请勿重复点击。');
            return;
          }
          rememberedRequests.add(requestId);
          while (rememberedRequests.size > MAX_REMEMBERED_REQUESTS) {
            rememberedRequests.delete(rememberedRequests.values().next().value);
          }
          pendingItems.add(itemId);
          const controller = new AbortController();
          pendingControllers.add(controller);
          const timer = setTimeout(() => {
            controller.abort(new Error('等待 DSH 创建会话超时。'));
          }, DRAFT_TIMEOUT_MS);
          let reference;
          try {
            if (typeof sessions?.create !== 'function' || typeof sessions.retain !== 'function'
              || typeof conversation?.input?.requestDraftInitialization !== 'function'
              || typeof workspaceNavigation?.openSession !== 'function') {
              throw new Error('当前 DSH 缺少创建新会话草稿所需的公开接口。');
            }
            const workspaceId = recentWorkspaceId(
              workspaces?.list?.getSnapshot?.(),
              sessions.list?.getSnapshot?.(),
            );
            if (workspaceId === undefined) {
              throw new Error('请先在 DSH 中添加或打开一个工作区，再使用“试用”。');
            }
            const sessionId = await abortable(sessions.create({ workspaceId }), controller.signal);
            if (bridgeDisposed || controller.signal.aborted) {
              throw controller.signal.reason || new Error('请求已中止。');
            }
            reference = sessions.retain(sessionId, {
              source: 'workspaceOperation',
              signal: controller.signal,
            });
            await abortable(reference.ready, controller.signal);
            if (bridgeDisposed || controller.signal.aborted || source !== frameWindow) {
              throw controller.signal.reason || new Error('请求已中止。');
            }
            const result = conversation.input.requestDraftInitialization(reference.binding, {
              prompt,
              clearPreviousDraft: false,
            });
            if (result !== 'applied') {
              throw new Error(result === 'blocked'
                ? '新会话暂时无法写入草稿，请稍后重试。'
                : '新会话没有接受试用提示词。');
            }
            if (bridgeDisposed || controller.signal.aborted || source !== frameWindow) {
              throw controller.signal.reason || new Error('请求已中止。');
            }
            workspaceNavigation.openSession(sessionId);
            postAck(source, origin, requestId, true);
          } catch (error) {
            postAck(source, origin, requestId, false, error);
          } finally {
            clearTimeout(timer);
            reference?.release();
            pendingControllers.delete(controller);
            pendingItems.delete(itemId);
          }
        }

        const onMessage = event => {
          if (bridgeDisposed || event.origin !== window.location.origin || event.source !== frameWindow
            || !isMessage(event.data)) return;
          void openDraft(event.data, event.source, event.origin);
        };

        ctx.effect(() => {
          window.addEventListener('message', onMessage);
          return () => {
            bridgeDisposed = true;
            window.removeEventListener('message', onMessage);
            for (const controller of pendingControllers) {
              controller.abort(new Error('能力中心已关闭。'));
            }
          };
        }, 'capability-center: iframe draft bridge');

        function CapabilityCenterFrame() {
          return h('div', {
            style: {
              width: '100%',
              height: '100%',
              minHeight: 0,
              overflow: 'hidden',
              background: 'var(--dsw-alias-bg-base)',
            },
          }, h('iframe', {
            ref: node => { frameWindow = node?.contentWindow ?? undefined; },
            src: `${PREFIX}/`,
            title: '能力中心',
            style: {
              display: 'block',
              width: '100%',
              height: '100%',
              minHeight: '560px',
              border: 0,
              background: 'transparent',
            },
            referrerPolicy: 'no-referrer',
          }));
        }

        function CapabilityCenterIcon(props) {
          const size = typeof props.size === 'number' ? props.size : 18;
          return h('svg', {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block' },
          },
          h('rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.2 }),
          h('rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.2 }),
          h('rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.2 }),
          h('path', { d: 'M17 13.5v7M13.5 17h7' }));
        }

        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, CapabilityCenterFrame);
        });
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 15,
          label: '能力中心',
        }, CapabilityCenterIcon));
      },
    };
    return module.exports;
  },
});
