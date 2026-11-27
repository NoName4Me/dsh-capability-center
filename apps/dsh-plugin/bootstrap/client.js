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
    const RELOAD_DSH = 'capability-center/reload-dsh';
    const UPDATES_CHANGED = 'capability-center/updates-changed';
    const SERVER_STORAGE_KEY = 'capability-center.serverUrl';
    const OFFLINE_STORAGE_KEY = 'capability-center.offline';
    const REFRESH_PENDING_KEY = 'capability-center.refresh-pending';
    const REFRESH_CLAIM_KEY = 'capability-center.refresh-claim';
    const PLUGIN_REFRESH_KEY = 'capability-center.plugin-refresh-required';
    const REQUEST_ID = /^[A-Za-z0-9_-]{8,96}$/;
    const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const DRAFT_MESSAGE_KEYS = new Set(['type', 'requestId', 'itemId', 'prompt', 'origin']);
    const RELOAD_MESSAGE_KEYS = new Set(['type', 'target', 'itemId', 'version', 'action', 'origin']);
    const UPDATES_MESSAGE_KEYS = new Set(['type', 'origin']);
    const DRAFT_TIMEOUT_MS = 15_000;
    const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;
    const UPDATE_CHECK_DEBOUNCE_MS = 250;
    const REFRESH_TOAST_MS = 8_000;
    const MAX_REMEMBERED_REQUESTS = 100;
    const MAX_PROMPT_LENGTH = 4_000;

    function isDraftMessage(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      return keys.length === DRAFT_MESSAGE_KEYS.size
        && keys.every(key => DRAFT_MESSAGE_KEYS.has(key))
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

    function isReloadMessage(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      return keys.length === RELOAD_MESSAGE_KEYS.size
        && keys.every(key => RELOAD_MESSAGE_KEYS.has(key))
        && value.type === RELOAD_DSH
        && ['plugin', 'core'].includes(value.target)
        && typeof value.itemId === 'string'
        && (value.target === 'core' ? value.itemId === 'capability-center-core' : ITEM_ID.test(value.itemId))
        && typeof value.version === 'string'
        && value.version.length > 0
        && value.version.length <= 80
        && (value.target === 'core'
          ? value.action === 'activate'
          : ['install', 'update'].includes(value.action))
        && value.origin === window.location.origin;
    }

    function isUpdatesMessage(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      return keys.length === UPDATES_MESSAGE_KEYS.size
        && keys.every(key => UPDATES_MESSAGE_KEYS.has(key))
        && value.type === UPDATES_CHANGED
        && value.origin === window.location.origin;
    }

    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          if (Object.is(value, next)) return;
          value = next;
          for (const listener of listeners) listener();
        },
      };
    }

    function readStorage(key) {
      try {
        return window.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }

    function readSession(key) {
      try {
        return window.sessionStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }

    function removeSession(key) {
      try {
        window.sessionStorage?.removeItem(key);
      } catch {
        // Session storage can be unavailable in hardened host contexts.
      }
    }

    function writeSession(key, value) {
      try {
        window.sessionStorage?.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    }

    function claimRefreshNotice(owner) {
      const raw = readSession(REFRESH_CLAIM_KEY);
      if (raw !== null) {
        try {
          const claim = JSON.parse(raw);
          if (typeof claim?.at === 'number' && Date.now() - claim.at < 10_000) return false;
        } catch {
          // A malformed stale claim can be replaced.
        }
      }
      return writeSession(REFRESH_CLAIM_KEY, JSON.stringify({ owner, at: Date.now() }));
    }

    function releaseRefreshClaim() {
      removeSession(REFRESH_CLAIM_KEY);
    }

    function removePluginRefresh(itemId, version) {
      const raw = readSession(PLUGIN_REFRESH_KEY);
      if (raw === null) return;
      try {
        const values = JSON.parse(raw);
        if (typeof values !== 'object' || values === null || Array.isArray(values)) return;
        if (values[itemId]?.version !== version) return;
        delete values[itemId];
        if (Object.keys(values).length === 0) removeSession(PLUGIN_REFRESH_KEY);
        else writeSession(PLUGIN_REFRESH_KEY, JSON.stringify(values));
      } catch {
        removeSession(PLUGIN_REFRESH_KEY);
      }
    }

    function refreshNotice(raw) {
      if (typeof raw !== 'string') return undefined;
      try {
        const value = JSON.parse(raw);
        if (!['plugin', 'core'].includes(value?.target)
          || typeof value?.itemId !== 'string'
          || (value.target === 'core'
            ? value.itemId !== 'capability-center-core'
            : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.itemId))
          || typeof value?.version !== 'string'
          || value.version.length === 0
          || value.version.length > 80
          || (value.target === 'core'
            ? value.action !== 'activate'
            : !['install', 'update'].includes(value.action))) return undefined;
        return {
          target: value.target,
          itemId: value.itemId,
          version: value.version,
          action: value.action,
        };
      } catch {
        return undefined;
      }
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
        const updateBadge = createStore(false);
        const refreshNoticeStore = createStore(undefined);
        let checkController;
        let checkInterval;
        let checkDebounce;
        let toastTimer;
        const restoredNotice = refreshNotice(readSession(REFRESH_PENDING_KEY));

        function useStore(store) {
          return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        }

        async function checkForUpdates() {
          if (bridgeDisposed || typeof window.fetch !== 'function') return;
          checkController?.abort();
          const controller = new AbortController();
          checkController = controller;
          const serverUrl = readStorage(SERVER_STORAGE_KEY)?.trim() ?? '';
          const offline = readStorage(OFFLINE_STORAGE_KEY) === 'true';
          const query = !offline && serverUrl !== ''
            ? `?server=${encodeURIComponent(serverUrl)}`
            : '';
          try {
            const response = await window.fetch(`${PREFIX}/api/updates${query}`, {
              headers: { accept: 'application/json' },
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (controller.signal.aborted || bridgeDisposed) return;
            updateBadge.set(payload?.attention === true);
          } catch {
            // A transport failure is not evidence that a previously confirmed update disappeared.
          }
        }

        async function verifyRefreshNotice(notice) {
          if (notice === undefined || bridgeDisposed || typeof window.fetch !== 'function') return;
          if (!claimRefreshNotice('host')) return;
          for (const delay of [250, 800, 1_400, 2_400]) {
            await new Promise(resolve => setTimeout(resolve, delay));
            if (bridgeDisposed) return;
            try {
              const endpoint = notice.target === 'plugin'
                ? `${PREFIX}/api/refresh-state?itemId=${encodeURIComponent(notice.itemId)}`
                : `${PREFIX}/api/refresh-state`;
              const response = await window.fetch(endpoint, {
                headers: { accept: 'application/json' },
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const payload = await response.json();
              let message;
              if (notice.target === 'core') {
                if (payload?.core?.ready !== true
                  || payload.core.activeVersion !== notice.version) continue;
                message = `能力中心核心 v${notice.version} 已生效。`;
                removeSession(PLUGIN_REFRESH_KEY);
              } else {
                const item = payload?.plugins?.[notice.itemId];
                if (item?.ready !== true || item.currentVersion !== notice.version) continue;
                message = notice.action === 'install'
                  ? `${item.name || notice.itemId} v${notice.version} 已安装并生效。`
                  : `${item.name || notice.itemId} v${notice.version} 已更新并生效。`;
                removePluginRefresh(notice.itemId, notice.version);
              }
              if (!bridgeDisposed) {
                refreshNoticeStore.set({ message, version: notice.version, id: Date.now() });
              }
              return;
            } catch {
              // Retry briefly while the refreshed plugin manager finishes startup.
            }
          }
          removeSession(REFRESH_PENDING_KEY);
          releaseRefreshClaim();
        }

        function scheduleUpdateCheck(delay = UPDATE_CHECK_DEBOUNCE_MS) {
          clearTimeout(checkDebounce);
          checkDebounce = setTimeout(() => { void checkForUpdates(); }, delay);
        }

        function reloadAfterNotice({ target, itemId, version, action }) {
          checkController?.abort();
          const notice = {
            target,
            itemId,
            version,
            action,
          };
          writeSession(REFRESH_PENDING_KEY, JSON.stringify(notice));
          setTimeout(() => {
            if (!bridgeDisposed) window.location.reload();
          }, 40);
        }

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
              throw new Error('请先在 DSH 中添加或打开一个工作区，再点击“去使用”。');
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
          if (bridgeDisposed || event.origin !== window.location.origin || event.source !== frameWindow) return;
          if (isDraftMessage(event.data)) {
            void openDraft(event.data, event.source, event.origin);
            return;
          }
          if (isUpdatesMessage(event.data)) {
            scheduleUpdateCheck(0);
            return;
          }
          if (isReloadMessage(event.data)) {
            reloadAfterNotice(event.data);
          }
        };

        const onStorage = event => {
          if (event.key !== SERVER_STORAGE_KEY && event.key !== OFFLINE_STORAGE_KEY) return;
          scheduleUpdateCheck();
        };

        const onOnline = () => scheduleUpdateCheck(0);
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') scheduleUpdateCheck();
        };
        const onPageHide = () => {
          checkController?.abort();
          clearTimeout(checkDebounce);
        };

        ctx.effect(() => {
          window.addEventListener('message', onMessage);
          window.addEventListener('storage', onStorage);
          window.addEventListener('online', onOnline);
          window.addEventListener('pagehide', onPageHide);
          document.addEventListener('visibilitychange', onVisibilityChange);
          if (restoredNotice !== undefined) {
            void verifyRefreshNotice(restoredNotice);
          }
          scheduleUpdateCheck(0);
          checkInterval = setInterval(() => {
            void checkForUpdates();
          }, UPDATE_CHECK_INTERVAL_MS + Math.floor(Math.random() * 60_000));
          return () => {
            bridgeDisposed = true;
            checkController?.abort();
            clearInterval(checkInterval);
            clearTimeout(checkDebounce);
            clearTimeout(toastTimer);
            window.removeEventListener('message', onMessage);
            window.removeEventListener('storage', onStorage);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('pagehide', onPageHide);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            for (const controller of pendingControllers) {
              controller.abort(new Error('能力中心已关闭。'));
            }
          };
        }, 'capability-center: iframe bridge and update watcher');

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
              border: 0,
              background: 'transparent',
            },
            referrerPolicy: 'no-referrer',
          }));
        }

        function CapabilityCenterIcon(props) {
          const size = typeof props.size === 'number' ? props.size : 18;
          const hasUpdates = useStore(updateBadge);
          return h('span', {
            'aria-hidden': true,
            style: {
              position: 'relative',
              display: 'inline-grid',
              width: size,
              height: size,
              flex: 'none',
              placeItems: 'center',
            },
          },
          h('span', {
            style: {
              width: size,
              height: size,
              background: 'currentColor',
              WebkitMask: `url("${PREFIX}/icon.svg") center / contain no-repeat`,
              mask: `url("${PREFIX}/icon.svg") center / contain no-repeat`,
            },
          }),
          hasUpdates === true && h('span', {
            style: {
              position: 'absolute',
              top: -2,
              right: -2,
              width: 7,
              height: 7,
              borderRadius: '50%',
              border: '2px solid var(--dsw-alias-bg-base, #fff)',
              background: '#d92d20',
              boxShadow: '0 2px 5px rgb(120 18 12 / 28%)',
            },
          }));
        }

        function RefreshToast() {
          const notice = useStore(refreshNoticeStore);
          React.useEffect(() => {
            if (notice === undefined) return undefined;
            removeSession(REFRESH_PENDING_KEY);
            releaseRefreshClaim();
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => refreshNoticeStore.set(undefined), REFRESH_TOAST_MS);
            return () => clearTimeout(toastTimer);
          }, [notice?.id]);
          if (notice === undefined) return null;
          return h('div', {
            role: 'status',
            'aria-live': 'polite',
            style: {
              position: 'fixed',
              right: 20,
              bottom: 20,
              zIndex: 2147483647,
              display: 'flex',
              maxWidth: 360,
              alignItems: 'center',
              gap: 12,
              padding: '11px 12px 11px 14px',
              border: '1px solid var(--dsw-alias-border-l1, #dce2ed)',
              borderRadius: 12,
              background: 'var(--dsw-alias-bg-layer-1, #fff)',
              boxShadow: '0 14px 36px rgb(20 30 55 / 18%)',
              color: 'var(--dsw-alias-label-primary, #182033)',
              fontSize: 13,
              lineHeight: '19px',
            },
          },
          h('span', { style: { minWidth: 0, flex: 1 } }, notice.message),
          h('button', {
            type: 'button',
            onClick: () => {
              refreshNoticeStore.set(undefined);
            },
            style: {
              minHeight: 30,
              padding: '0 9px',
              border: 0,
              borderRadius: 7,
              background: 'var(--dsw-alias-interactive-bg-hover, #e8edf6)',
              color: 'inherit',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          }, '关闭'));
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
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'capability-center.refresh-toast',
          label: () => '能力中心',
        }, RefreshToast));
      },
    };
    return module.exports;
  },
});
