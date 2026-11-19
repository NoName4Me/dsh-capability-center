window.__ModuleLoader__.load({
  id: 'capability-center-drawio',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'capability-center-drawio';
    const CHAT_SLOT = 'capability-center.drawio.conversation';
    const PREFIX = '/capability-center-drawio';
    const CanvasSelection = React.createContext(null);
    const TOOL_NAMES = [
      'drawio_create',
      'drawio_get_selection',
      'drawio_get_diagram',
      'drawio_edit',
      'drawio_open',
    ];
    const STORAGE_KEY = 'capability-center.drawio.boards.v1';
    const LEGACY_STORAGE_KEY = 'capability-center.drawio.board';
    const SELECTION_DEBOUNCE_MS = 120;
    const SAVE_DEBOUNCE_MS = 700;
    const FALLBACK_SELECTION_POLL_MS = 900;
    const CANVAS_CONFIGURATION_RETRY_DELAYS_MS = [80, 300, 800];
    const CANVAS_CONFIGURATION_SETTLE_MS = 300;
    const CSS = `
      .cc-drawio-root { display:flex; width:100%; height:100%; min-width:0; min-height:0;
        overflow:hidden; background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-text-primary,#111); }
      .cc-drawio-left { display:flex; flex:0 1 auto; flex-direction:column; min-width:0; min-height:0;
        background:var(--dsw-alias-bg-base,#fff); }
      .cc-drawio-head { display:flex; flex:0 0 auto; align-items:center; gap:8px; min-height:48px;
        padding:6px 12px; box-sizing:border-box; border-bottom:1px solid var(--dsw-alias-border-secondary,#ddd);
        background:linear-gradient(180deg,var(--dsw-alias-bg-elevated,#fff),var(--dsw-alias-bg-base,#fbfbfa)); }
      .cc-drawio-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:15px;
        font-weight:650; letter-spacing:-.01em; }
      .cc-drawio-meta { margin-left:auto; color:var(--dsw-alias-text-secondary,#555); font-size:12px; white-space:nowrap; }
      .cc-drawio-status { display:flex; align-items:center; gap:8px; min-height:30px; padding:0 12px;
        box-sizing:border-box; border-bottom:1px solid var(--dsw-alias-border-secondary,#eee);
        color:var(--dsw-alias-text-secondary,#555); font-size:12px; }
      .cc-drawio-dot { width:7px; height:7px; border-radius:50%; background:#c58b00; }
      .cc-drawio-dot[data-ready="true"] { background:#15803d; }
      .cc-drawio-error { color:#b42318; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .cc-drawio-frame-wrap { position:relative; flex:1; min-height:0; background:#f6f6f6; }
      .cc-drawio-frame { display:block; width:100%; height:100%; border:0; background:#fff; }
      .cc-drawio-split { width:8px; cursor:col-resize; touch-action:none; flex:0 0 8px;
        background:var(--dsw-alias-border-secondary,#e6e8eb); }
      .cc-drawio-split:hover { background:var(--dsw-alias-bg-hover,#ececec); }
      .cc-drawio-chat { display:flex; flex:1 0 min(320px,48%); flex-direction:column; min-width:0; min-height:0;
        background:var(--dsw-alias-bg-elevated,#fff); }
      .cc-drawio-chat-bar { display:flex; align-items:center; min-height:48px; padding:0 16px;
        gap:10px; box-sizing:border-box; border-bottom:1px solid var(--dsw-alias-border-secondary,#ddd);
        font-size:13px; }
      .cc-drawio-chat-body { position:relative; flex:1; min-height:0; overflow:hidden; }
      .cc-drawio-chat-content { position:absolute; inset:0; display:flex; flex-direction:column; min-width:0; }
      .cc-drawio-chat-content [data-conversation-content] { height:100%; min-width:0; }
      .cc-drawio-chat-content [data-conversation-scroll] { min-height:0; overflow-y:auto; }
      .cc-drawio-chat-content [data-composer-seat] { position:sticky; bottom:0; flex:none; }
      .cc-drawio-selection-dock { display:flex; padding:0 4px 6px; }
      .cc-drawio-selection-chip, .cc-drawio-sent-selection { display:inline-flex; min-width:0; max-width:100%;
        align-items:center; gap:6px; padding:3px 4px 3px 10px; border:1px solid #a7bca8;
        border-radius:5px; color:#254b31; background:#edf6ed; font-size:12px; line-height:1.4; }
      .cc-drawio-sent-selection { display:flex; width:max-content; margin:5px 16px 0 auto; padding:4px 8px; }
      .cc-drawio-selection-chip > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .cc-drawio-selection-chip button { flex:none; display:grid; place-items:center; width:26px; height:26px;
        border:0; border-radius:5px; background:transparent; color:inherit; cursor:pointer; }
      .cc-drawio-selection-chip button:hover { background:#d5e8d6; }
      .cc-drawio-chat-content [data-presented-file]:has(> button[title$=".png" i],
        > button[title$=".jpg" i], > button[title$=".jpeg" i], > button[title$=".webp" i],
        > button[title$=".gif" i], > button[title$=".svg" i], > button[title$=".avif" i],
        > button[title$=".bmp" i]) { display:none; }
      .cc-drawio-chat-content [data-presented-files-row]:not(:has(> [data-presented-file]:not(:has(
        > button[title$=".png" i], > button[title$=".jpg" i], > button[title$=".jpeg" i],
        > button[title$=".webp" i], > button[title$=".gif" i], > button[title$=".svg" i],
        > button[title$=".avif" i], > button[title$=".bmp" i])))) { display:none; }
      .cc-drawio-action { border:0; border-radius:6px; background:transparent; color:#155eef;
        padding:5px 8px; cursor:pointer; font:inherit; white-space:nowrap; }
      .cc-drawio-action:hover { background:var(--dsw-alias-bg-hover,#eef3ff); }
      .cc-drawio-action:disabled { cursor:default; opacity:.55; }
      .cc-drawio-header-action { border:1px solid var(--dsw-alias-border-secondary,#ddd); border-radius:6px;
        background:var(--dsw-alias-bg-elevated,#fff); color:var(--dsw-alias-text-primary,#111); padding:5px 10px;
        cursor:pointer; font:inherit; font-size:12px; font-weight:550; }
      .cc-drawio-header-action:hover { background:var(--dsw-alias-bg-hover,#f4f4f4); }
      .cc-drawio-empty { display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:12px; width:100%; height:100%; padding:24px; box-sizing:border-box; text-align:center; }
      .cc-tool-card { border:1px solid var(--dsw-alias-border-secondary,#d9dde3); border-radius:12px;
        padding:12px 14px; margin:8px 0; background:var(--dsw-alias-bg-elevated,#fff);
        box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.035); }
      .cc-tool-row { display:flex; align-items:center; gap:10px; }
      .cc-tool-title { font-weight:600; min-width:0; overflow-wrap:anywhere; }
      .cc-tool-copy { margin-top:4px; color:var(--dsw-alias-text-secondary,#666); font-size:12px; }
      .cc-drawio-result { display:grid; gap:3px; min-width:0; }
      .cc-drawio-result-kind { color:var(--dsw-alias-text-secondary,#555); font-size:12px; }
      .cc-tool-card button.cc-drawio-action { border:1px solid #b8caf2; border-radius:8px;
        background:#edf4ff; color:#174ea6; padding:5px 10px; font-size:12px; font-weight:600; }
      .cc-tool-card button.cc-drawio-action:hover { background:#e2ecff; }
      @media (max-width: 720px) {
        .cc-drawio-head { flex-wrap:wrap; }
        .cc-drawio-title { flex-basis:100%; }
        .cc-drawio-meta { margin-left:0; margin-right:auto; }
      }
    `;

    function boundedBoard(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      if (typeof value.boardId !== 'string'
        || typeof value.sessionId !== 'string'
        || !Number.isSafeInteger(value.revision)
        || typeof value.pageId !== 'string'
        || typeof value.title !== 'string') return undefined;
      return {
        boardId: value.boardId.slice(0, 64),
        sessionId: value.sessionId.slice(0, 512),
        revision: Math.max(1, value.revision),
        pageId: value.pageId.slice(0, 512),
        pageName: typeof value.pageName === 'string' ? value.pageName.slice(0, 200) : value.title.slice(0, 200),
        title: value.title.slice(0, 200),
      };
    }

    function readStoredBoards() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
          const value = JSON.parse(raw);
          const boards = new Map();
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            for (const item of Object.values(value)) {
              const board = boundedBoard(item);
              if (board !== undefined) boards.set(board.sessionId, board);
            }
          }
          return boards;
        }
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        const board = legacy === null ? undefined : boundedBoard(JSON.parse(legacy));
        return new Map(board === undefined ? [] : [[board.sessionId, board]]);
      } catch {
        return new Map();
      }
    }

    const listeners = new Set();
    const storedBoards = readStoredBoards();
    let latestBoard;
    function persistBoards() {
      try {
        const value = {};
        for (const [sessionId, board] of storedBoards) value[sessionId] = board;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // A private browser profile may reject persistence; the live store still works.
      }
    }
    const boardStore = {
      notify() {
        for (const listener of [...listeners]) listener();
      },
      getSnapshot() {
        return latestBoard;
      },
      getForSession(sessionId) {
        return typeof sessionId === 'string' ? storedBoards.get(sessionId) : undefined;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish(next) {
        latestBoard = next;
        if (next === undefined) storedBoards.clear();
        else storedBoards.set(next.sessionId, next);
        persistBoards();
        this.notify();
      },
      activate(value, { preserveRevision = false } = {}) {
        const next = boundedBoard(value);
        if (next === undefined) return false;
        const current = storedBoards.get(next.sessionId);
        if (current?.boardId === next.boardId
          && current.revision > next.revision
          && preserveRevision) return false;
        if (current?.boardId === next.boardId
          && current.revision === next.revision
          && current.title === next.title) {
          latestBoard = current;
          return false;
        }
        this.publish(next);
        return true;
      },
      note(value) {
        const next = boundedBoard(value);
        if (next === undefined) return;
        const current = storedBoards.get(next.sessionId);
        if (current?.boardId === next.boardId && current.revision >= next.revision) return;
        this.publish(next);
      },
    };

    function useBoard(sessionId) {
      const [, refresh] = React.useState(0);
      React.useEffect(() => boardStore.subscribe(() => refresh(value => value + 1)), []);
      return typeof sessionId === 'string'
        ? boardStore.getForSession(sessionId)
        : boardStore.getSnapshot();
    }

    const selectionSyncControllers = new Map();
    function registerSelectionSyncController(sessionId, boardId, controller) {
      selectionSyncControllers.set(sessionId, { boardId, controller });
    }
    function unregisterSelectionSyncController(sessionId, controller) {
      if (selectionSyncControllers.get(sessionId)?.controller === controller) {
        selectionSyncControllers.delete(sessionId);
      }
    }
    function currentSelectionSyncController(sessionId) {
      return typeof sessionId === 'string'
        ? selectionSyncControllers.get(sessionId)?.controller
        : undefined;
    }
    function canGateCanvasSubmit(event, input, session, draft) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return false;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
      if (session?.running || input?.phase !== 'plain') return false;
      return !String(draft ?? '').trimStart().startsWith('/');
    }

    function apiUrl(board, suffix = '') {
      return `${PREFIX}/api/drawio/boards/${encodeURIComponent(board.boardId)}${suffix}`;
    }

    async function readJsonResponse(response) {
      const value = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = new Error(
          typeof value?.message === 'string' ? value.message : `画布请求失败（${response.status}）。`,
        );
        error.code = value?.code;
        error.status = response.status;
        error.details = value?.details;
        throw error;
      }
      return value;
    }

    async function fetchBoard(board) {
      const response = await fetch(
        `${apiUrl(board)}?session=${encodeURIComponent(board.sessionId)}`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      const value = await readJsonResponse(response);
      if (typeof value?.board?.xml !== 'string') throw new Error('画布响应缺少 XML。');
      return value.board;
    }

    async function fetchActiveBoard(sessionId) {
      const response = await fetch(
        `${PREFIX}/api/drawio/active?session=${encodeURIComponent(sessionId)}`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      const value = await readJsonResponse(response);
      if (typeof value?.board?.xml !== 'string') throw new Error('活动画板响应缺少 XML。');
      return value.board;
    }

    async function activateBoard(board) {
      const response = await fetch(apiUrl(board, '/activate'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-capability-center': '1',
        },
        body: JSON.stringify({ sessionId: board.sessionId }),
      });
      return await readJsonResponse(response);
    }

    async function openCanvas(board, selectPanel) {
      const current = await activateBoard(board);
      boardStore.activate(current);
      selectPanel(PANEL_ID);
    }

    function findBoardCall(snapshot, turn, names, allowPending = false) {
      if (turn === undefined) return undefined;
      const keys = snapshot.locations.getTurn(turn);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const node = snapshot.nodes.get(keys[index]);
        if (node?.kind !== 'tool-call') continue;
        const call = node.data.root;
        if (!names.includes(call.call?.name ?? call.name)) continue;
        if (allowPending || (call.kind === 'tool-result' && !call.isError && call.meta?.boardId)) return call;
      }
      return undefined;
    }

    const CREATE_TOOLS = ['drawio_create'];
    const RESULT_TOOLS = ['drawio_create', 'drawio_open', 'drawio_edit'];
    let pendingCreate;
    const lastAutoOpened = new Map();

    function useAutoCanvas(props, selectPanel, insideCanvas = false) {
      const running = props.useSession(state => state.running);
      const call = props.useChat(snapshot =>
        findBoardCall(snapshot, snapshot.timeline.turnOrder.at(-1), CREATE_TOOLS, true));
      React.useEffect(() => {
        const pending = pendingCreate?.sessionId === props.sessionId ? pendingCreate : undefined;
        if (call?.kind === 'tool-result' && pending?.callId === call.callId) {
          pendingCreate = undefined;
          const board = call.isError ? undefined : boundedBoard(call.meta);
          if (board?.sessionId === props.sessionId) boardStore.note(board);
          else if (insideCanvas && boardStore.getForSession(props.sessionId) === undefined) selectPanel(null);
          boardStore.notify();
          return;
        }
        if (!running && pending !== undefined) {
          pendingCreate = undefined;
          boardStore.notify();
          if (insideCanvas && boardStore.getForSession(props.sessionId) === undefined) selectPanel(null);
          return;
        }
        if (!running || call === undefined || call.isError
          || lastAutoOpened.get(props.sessionId) === call.callId) return;
        lastAutoOpened.set(props.sessionId, call.callId);
        if (call.kind === 'tool-result') {
          const board = boundedBoard(call.meta);
          if (board?.sessionId !== props.sessionId) return;
          boardStore.note(board);
        } else {
          pendingCreate = { sessionId: props.sessionId, callId: call.callId };
          boardStore.notify();
        }
        if (!insideCanvas) selectPanel(PANEL_ID);
      }, [call, running, props.sessionId, selectPanel, insideCanvas]);
    }

    function useLegacyCanvasLink({ sessionId, useChat }, selectPanel) {
      const chat = useChat(snapshot => snapshot);
      React.useEffect(() => {
        const onClick = event => {
          if (!(event.target instanceof Element)) return;
          const link = event.target.closest('button[title], a[href]');
          const content = link?.closest('[data-conversation-session]');
          if (content?.getAttribute('data-conversation-session') !== sessionId) return;
          const path = link.getAttribute('title') ?? link.getAttribute('href');
          if (path !== `${PREFIX}/drawio/` && path !== `${PREFIX}/drawio/index.html`) return;
          const turn = link.closest('[data-chat-turn]')?.getAttribute('data-chat-turn');
          if (turn === undefined || turn === null) return;
          const board = boundedBoard(findBoardCall(chat, Number(turn), RESULT_TOOLS)?.meta);
          if (board?.sessionId !== sessionId) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          openCanvas(board, selectPanel).catch(() => undefined);
        };
        window.addEventListener('click', onClick, true);
        return () => window.removeEventListener('click', onClick, true);
      }, [chat, sessionId, selectPanel]);
    }

    function postToFrame(frame, payload) {
      frame?.postMessage(JSON.stringify(payload), window.location.origin);
    }

    function disableEditorPageView(windowValue) {
      const documentValue = windowValue?.document;
      if (documentValue === undefined) return;
      const pageView = [...documentValue.querySelectorAll('input[title]')]
        .find(input => /^(?:页面视图|page\s*view)$/iu.test(String(input.getAttribute('title') ?? '').trim()));
      if (pageView?.checked === true) pageView.click();
    }

    function closeMinimalEditorWindows(windowValue, titles) {
      const documentValue = windowValue?.document;
      if (documentValue === undefined) return;
      for (const title of titles) {
        const titleCell = [...documentValue.querySelectorAll('.mxWindowTitle')]
          .find(cell => String(cell.textContent ?? '').trim() === title);
        if (titleCell === undefined) continue;
        try {
          const close = [...titleCell.querySelectorAll('img[title]')]
            .find(image => /^(关闭|close)$/iu.test(String(image.getAttribute('title') ?? '')));
          if (typeof close?.click === 'function') {
            close.click();
          } else {
            close?.dispatchEvent(new windowValue.MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: windowValue,
            }));
          }
          let container = titleCell.closest('.mxWindow');
          while (container?.parentElement?.classList.contains('mxWindow')) {
            container = container.parentElement;
          }
          if (container !== null && container.isConnected !== false
            && container.style.display !== 'none') {
            container.style.display = 'none';
          }
        } catch {
          // Keep each draw.io window independent so one unexpected DOM shape cannot block the other.
        }
      }
    }

    function labelText(windowValue, value) {
      const raw = String(value ?? '');
      if (raw === '' || !/[<&]/u.test(raw)) return raw;
      try {
        const Parser = windowValue.DOMParser;
        if (typeof Parser === 'function') {
          return new Parser().parseFromString(raw, 'text/html').body.textContent ?? '';
        }
      } catch {
        // Fall back to a conservative tag strip below.
      }
      return raw.replace(/<[^>]*>/gu, '');
    }

    function graphSelectionCells(windowValue, graph) {
      const cells = graph.getSelectionCells()
        .filter(cell => cell && typeof cell.id === 'string')
        .slice(0, 512)
        .map(cell => {
          let label = '';
          try {
            label = labelText(windowValue, graph.convertValueToString(cell));
          } catch {
            label = '';
          }
          return {
            id: cell.id,
            type: cell.edge === true ? 'edge' : 'vertex',
            label: String(label ?? '').slice(0, 8_000),
            ...(cell.source?.id ? { source: String(cell.source.id) } : {}),
            ...(cell.target?.id ? { target: String(cell.target.id) } : {}),
            ...(cell.parent?.id ? { parent: String(cell.parent.id) } : {}),
          };
        });
      return cells;
    }

    function protocolSelectionCells(value, pageId) {
      const pages = Array.isArray(value?.pages) ? value.pages : [];
      const page = pages.find(candidate => candidate?.id === pageId) ?? pages[0];
      if (!Array.isArray(page?.cells)) return [];
      return page.cells
        .filter(cell => typeof cell?.id === 'string')
        .slice(0, 512)
        .map(cell => ({
          id: cell.id,
          type: cell.type === 'edge' || cell.edge === true ? 'edge' : 'vertex',
          label: typeof cell.label === 'string' ? cell.label.slice(0, 8_000) : '',
          ...(typeof cell.source === 'string' ? { source: cell.source } : {}),
          ...(typeof cell.target === 'string' ? { target: cell.target } : {}),
          ...(typeof cell.parent === 'string' ? { parent: cell.parent } : {}),
        }));
    }

    function DrawioEditor({ board, onStatus, controllerRef }) {
      const iframeRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const boardRef = React.useRef(board);
      const revisionRef = React.useRef(board.revision);
      const loadedRevisionRef = React.useRef(0);
      const loadedXmlRef = React.useRef('');
      const protocolReadyRef = React.useRef(false);
      const editorReadyRef = React.useRef(false);
      const disposedRef = React.useRef(false);
      const graphRef = React.useRef(undefined);
      const editorUiRef = React.useRef(undefined);
      const graphWindowRef = React.useRef(undefined);
      const graphListenersRef = React.useRef([]);
      const selectionRef = React.useRef([]);
      const selectionSyncedRef = React.useRef(false);
      const pendingRestoreRef = React.useRef(undefined);
      const selectionTimerRef = React.useRef(undefined);
      const selectionQueueRef = React.useRef(Promise.resolve());
      const selectionSyncDirtyRef = React.useRef(false);
      const selectionSyncPromiseRef = React.useRef(undefined);
      const exportWaiterRef = React.useRef(undefined);
      const gestureTimerRef = React.useRef(undefined);
      const gestureCleanupRef = React.useRef(undefined);
      const saveTimerRef = React.useRef(undefined);
      const canvasConfigurationTimersRef = React.useRef([]);
      const configuringCanvasRef = React.useRef(false);
      const fallbackTimerRef = React.useRef(undefined);
      const pendingSaveXmlRef = React.useRef(undefined);
      const pendingSaveGenerationRef = React.useRef(0);
      const savingRef = React.useRef(false);
      const saveConflictRef = React.useRef(false);
      const saveDrainRef = React.useRef(Promise.resolve());
      const fetchQueueRef = React.useRef(Promise.resolve());
      const dirtyRef = React.useRef(false);
      const dirtyGenerationRef = React.useRef(0);
      const flushDirtyRef = React.useRef(() => undefined);
      boardRef.current = board;
      revisionRef.current = board.revision;

      const report = React.useCallback((status, detail = '') => {
        onStatus({
          status,
          detail: String(detail).slice(0, 240),
          selection: selectionRef.current,
        });
      }, [onStatus]);

      const persistSelection = React.useCallback(async snapshot => {
        try {
          const response = await fetch(apiUrl(snapshot.board, '/selection'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/json',
              'x-capability-center': '1',
            },
            body: JSON.stringify({
              sessionId: snapshot.board.sessionId,
              revision: snapshot.revision,
              pageId: snapshot.board.pageId,
              cells: snapshot.cells,
            }),
          });
          await readJsonResponse(response);
          selectionSyncedRef.current = true;
          if (!disposedRef.current && protocolReadyRef.current
            && boardRef.current.boardId === snapshot.board.boardId) {
            report('编辑器已就绪', `选区已同步 · ${snapshot.cells.length} 个图元`);
          }
        } catch (error) {
          selectionSyncedRef.current = false;
          if (disposedRef.current) return;
          if (error.status === 409) {
            report('选区冲突', '选区基于较旧修订，模型不会用旧 ID 覆盖新图；正在等待画板刷新。');
          } else {
            report('选区同步失败', error.message);
          }
          throw error;
        }
      }, [report]);

      const saveSelection = React.useCallback((cells, { immediate = false } = {}) => {
        selectionRef.current = cells;
        const snapshot = {
          board: { ...boardRef.current },
          revision: revisionRef.current,
          cells,
        };
        onStatus(value => ({
          ...value,
          selection: cells,
        }));
        if (selectionTimerRef.current !== undefined) clearTimeout(selectionTimerRef.current);
        if (immediate) selectionTimerRef.current = undefined;
        else {
          selectionTimerRef.current = window.setTimeout(() => {
            selectionTimerRef.current = undefined;
            const attempt = selectionQueueRef.current.then(() => persistSelection(snapshot));
            selectionQueueRef.current = attempt.catch(() => undefined);
          }, SELECTION_DEBOUNCE_MS);
          return selectionQueueRef.current;
        }
        const attempt = selectionQueueRef.current.then(() => persistSelection(snapshot));
        selectionQueueRef.current = attempt.catch(() => undefined);
        return attempt;
      }, [onStatus, persistSelection]);

      const flushSelection = React.useCallback((targetBoard = undefined) => {
        if (selectionTimerRef.current !== undefined) clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = undefined;
        if (!disposedRef.current) report('正在同步选区');
        const snapshot = {
          board: { ...(targetBoard ?? boardRef.current) },
          revision: targetBoard?.revision ?? revisionRef.current,
          cells: selectionRef.current,
        };
        const attempt = selectionQueueRef.current.then(() => persistSelection(snapshot));
        selectionQueueRef.current = attempt.catch(() => undefined);
        return attempt;
      }, [persistSelection, report]);

      const emitGraphSelection = React.useCallback(() => {
        const graph = graphRef.current;
        const windowValue = graphWindowRef.current;
        if (graph === undefined || windowValue === undefined) return;
        const cells = graphSelectionCells(windowValue, graph);
        saveSelection(cells);
      }, [saveSelection]);

      const requestSelectionExport = React.useCallback(() => {
        if (!protocolReadyRef.current || disposedRef.current) {
          return Promise.reject(new Error('画布协议尚未就绪。'));
        }
        if (exportWaiterRef.current !== undefined) return exportWaiterRef.current.promise;
        let resolve;
        let reject;
        const promise = new Promise((resolveValue, rejectValue) => {
          resolve = resolveValue;
          reject = rejectValue;
        });
        const timer = window.setTimeout(() => {
          if (exportWaiterRef.current?.promise === promise) exportWaiterRef.current = undefined;
          reject(new Error('画布选区导出超时。'));
        }, 2500);
        exportWaiterRef.current = { promise, resolve, reject, timer };
        postToFrame(iframeRef.current?.contentWindow, {
          action: 'export',
          format: 'json',
          selection: true,
          allPages: false,
          includeData: false,
          compressed: false,
        });
        return promise;
      }, []);

      const requestSelectionSync = React.useCallback(() => {
        selectionSyncDirtyRef.current = true;
        if (selectionSyncPromiseRef.current !== undefined) {
          return selectionSyncPromiseRef.current;
        }
        let syncPromise;
        syncPromise = (async () => {
          try {
            while (selectionSyncDirtyRef.current && !disposedRef.current) {
              selectionSyncDirtyRef.current = false;
              const graph = graphRef.current;
              const frame = graphWindowRef.current;
              const cells = graph !== undefined && frame !== undefined
                ? graphSelectionCells(frame, graph)
                : protocolSelectionCells(await requestSelectionExport(), boardRef.current.pageId);
              await saveSelection(cells, { immediate: true });
            }
          } catch (error) {
            selectionSyncDirtyRef.current = true;
            throw error;
          } finally {
            if (selectionSyncPromiseRef.current === syncPromise) {
              selectionSyncPromiseRef.current = undefined;
            }
          }
        })();
        selectionSyncPromiseRef.current = syncPromise;
        return syncPromise;
      }, [requestSelectionExport, saveSelection]);

      const attachSelectionGestures = React.useCallback(() => {
        gestureCleanupRef.current?.();
        gestureCleanupRef.current = undefined;
        const frame = iframeRef.current?.contentWindow;
        const documentValue = frame?.document;
        if (documentValue === undefined) return;
        const onGesture = () => {
          selectionSyncDirtyRef.current = true;
          if (gestureTimerRef.current !== undefined) clearTimeout(gestureTimerRef.current);
          gestureTimerRef.current = window.setTimeout(() => {
            gestureTimerRef.current = undefined;
            void requestSelectionSync().catch(() => undefined);
          }, 0);
        };
        documentValue.addEventListener('pointerup', onGesture, true);
        documentValue.addEventListener('keyup', onGesture, true);
        gestureCleanupRef.current = () => {
          documentValue.removeEventListener('pointerup', onGesture, true);
          documentValue.removeEventListener('keyup', onGesture, true);
        };
      }, [requestSelectionSync]);

      const scheduleSaveRequest = React.useCallback(() => {
        if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = undefined;
          if (disposedRef.current || !protocolReadyRef.current) return;
          postToFrame(iframeRef.current?.contentWindow, { action: 'save', exit: false });
        }, SAVE_DEBOUNCE_MS);
      }, []);

      const restoreGraphSelection = React.useCallback(() => {
        const pending = pendingRestoreRef.current;
        pendingRestoreRef.current = undefined;
        const graph = graphRef.current;
        if (graph === undefined || graph.getModel === undefined) return;
        if (!Array.isArray(pending) || pending.length === 0) return;
        const cells = pending
          .map(id => graph.getModel().getCell(id))
          .filter(Boolean);
        if (cells.length > 0) graph.setSelectionCells(cells);
      }, []);

      const applyCanvasConfiguration = React.useCallback(() => {
        if (disposedRef.current) return;
        const windowValue = graphWindowRef.current ?? iframeRef.current?.contentWindow;
        if (windowValue === undefined) return;
        const ui = editorUiRef.current;
        if (ui !== undefined) {
          try {
            ui.setPageVisible?.(false);
          } catch {}
        }
        disableEditorPageView(windowValue);
        closeMinimalEditorWindows(windowValue, ['形状', '格式']);
      }, []);

      const configureEditorCanvas = React.useCallback(() => {
        for (const timer of canvasConfigurationTimersRef.current) clearTimeout(timer);
        canvasConfigurationTimersRef.current = [];
        configuringCanvasRef.current = true;
        applyCanvasConfiguration();
        for (const delay of CANVAS_CONFIGURATION_RETRY_DELAYS_MS) {
          let timer;
          timer = window.setTimeout(() => {
            canvasConfigurationTimersRef.current = canvasConfigurationTimersRef.current
              .filter(candidate => candidate !== timer);
            applyCanvasConfiguration();
          }, delay);
          canvasConfigurationTimersRef.current.push(timer);
        }
        let settleTimer;
        settleTimer = window.setTimeout(() => {
          canvasConfigurationTimersRef.current = canvasConfigurationTimersRef.current
            .filter(candidate => candidate !== settleTimer);
          if (!disposedRef.current) configuringCanvasRef.current = false;
        }, Math.max(...CANVAS_CONFIGURATION_RETRY_DELAYS_MS) + CANVAS_CONFIGURATION_SETTLE_MS);
        canvasConfigurationTimersRef.current.push(settleTimer);
      }, [applyCanvasConfiguration]);

      const bindGraph = React.useCallback(() => {
        const windowValue = iframeRef.current?.contentWindow;
        if (windowValue === undefined || disposedRef.current) return;
        const loadPlugin = windowValue.Draw?.loadPlugin;
        if (typeof loadPlugin !== 'function' || graphRef.current !== undefined) return;
        try {
          loadPlugin(ui => {
            if (disposedRef.current) return;
            const graph = ui?.editor?.graph;
            if (graph === undefined) return;
            graphRef.current = graph;
            graphWindowRef.current = windowValue;
            const selectionHandler = () => emitGraphSelection();
            const modelHandler = () => {
              if (configuringCanvasRef.current) return;
              dirtyRef.current = true;
              dirtyGenerationRef.current += 1;
              scheduleSaveRequest();
            };
            graph.getSelectionModel().addListener(windowValue.mxEvent.CHANGE, selectionHandler);
            graph.getModel().addListener(windowValue.mxEvent.CHANGE, modelHandler);
            graphListenersRef.current = [
              [graph.getSelectionModel(), selectionHandler],
              [graph.getModel(), modelHandler],
            ];
            editorReadyRef.current = true;
            if (fallbackTimerRef.current !== undefined) {
              clearInterval(fallbackTimerRef.current);
              fallbackTimerRef.current = undefined;
            }
            editorUiRef.current = ui;
            selectionSyncedRef.current = false;
            report('正在同步选区');
            saveSelection(graphSelectionCells(windowValue, graph), { immediate: true });
            restoreGraphSelection();
            configureEditorCanvas();
          });
        } catch (error) {
          report('编辑器已加载', `即时选区接口不可用，使用 JSON 选区回退：${error.message}`);
        }
      }, [
        configureEditorCanvas,
        emitGraphSelection,
        report,
        restoreGraphSelection,
        saveSelection,
        scheduleSaveRequest,
      ]);

      const saveXml = React.useCallback((xml, targetBoard = undefined) => {
        if (typeof xml !== 'string' || xml === '' || xml === loadedXmlRef.current) return;
        pendingSaveXmlRef.current = xml;
        pendingSaveGenerationRef.current = dirtyGenerationRef.current;
        if (saveConflictRef.current || savingRef.current) return;
        const drain = async () => {
          savingRef.current = true;
          try {
            while (pendingSaveXmlRef.current !== undefined && !saveConflictRef.current) {
              const xmlSnapshot = pendingSaveXmlRef.current;
              const generation = pendingSaveGenerationRef.current;
              pendingSaveXmlRef.current = undefined;
              const board = { ...(targetBoard ?? boardRef.current) };
              const requiredRevision = targetBoard?.revision ?? revisionRef.current;
              const response = await fetch(apiUrl(board), {
              method: 'PUT',
              credentials: 'same-origin',
              headers: {
                'content-type': 'application/json',
                'x-capability-center': '1',
              },
              body: JSON.stringify({
                sessionId: board.sessionId,
                expectedRevision: requiredRevision,
                pageId: board.pageId,
                xml: xmlSnapshot,
              }),
            });
            const value = await readJsonResponse(response);
            if (!disposedRef.current
              && boardRef.current.boardId === board.boardId
              && boardStore.getForSession(board.sessionId)?.boardId === board.boardId) {
              loadedXmlRef.current = xmlSnapshot;
              loadedRevisionRef.current = value.board.revision;
              revisionRef.current = value.board.revision;
              boardRef.current = {
                ...boardRef.current,
                revision: value.board.revision,
                pageId: value.board.pageId,
                pageName: value.board.pageName,
              };
              if (dirtyGenerationRef.current === generation) dirtyRef.current = false;
              boardStore.activate(boardRef.current);
              selectionSyncedRef.current = false;
              saveSelection(selectionRef.current, { immediate: true });
              report(
                '正在同步选区',
                `已保存修订 ${value.board.revision}`,
              );
            }
            }
          } catch (error) {
            if (error.status === 409) {
              saveConflictRef.current = true;
              if (!disposedRef.current) {
                report('保存冲突', '较新的画板修订未被覆盖；本地编辑仍保留在 draw.io 中，请先导出或重新载入最新画板。');
              }
            } else if (!disposedRef.current) {
              report('保存失败', `本地编辑仍保留，尚未写入：${error.message}`);
            }
          } finally {
            savingRef.current = false;
            if (pendingSaveXmlRef.current !== undefined && !saveConflictRef.current) {
              queueMicrotask(() => {
                if (!savingRef.current && !disposedRef.current) void saveXmlRef.current?.(pendingSaveXmlRef.current);
              });
            }
          }
        };
        saveDrainRef.current = drain();
        saveDrainRef.current.catch(error => {
          if (!disposedRef.current) report('保存失败', `本地编辑仍保留，尚未写入：${error.message}`);
        });
      }, [report, saveSelection]);
      const saveXmlRef = React.useRef(saveXml);
      saveXmlRef.current = saveXml;

      const flushDirty = React.useCallback((targetBoard = undefined) => {
        if (selectionTimerRef.current !== undefined) clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = undefined;
        if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
        void flushSelection(targetBoard).catch(() => undefined);
        if (!dirtyRef.current || saveConflictRef.current) return saveDrainRef.current;
        try {
          const getFileData = editorUiRef.current?.getFileData;
          if (typeof getFileData === 'function') {
            const xml = getFileData.call(editorUiRef.current, true);
            if (typeof xml === 'string' && xml !== '') saveXml(xml, targetBoard);
          } else if (protocolReadyRef.current) {
            postToFrame(iframeRef.current?.contentWindow, { action: 'save', exit: false });
          }
        } catch {
          if (protocolReadyRef.current) {
            postToFrame(iframeRef.current?.contentWindow, { action: 'save', exit: false });
          }
        }
        return saveDrainRef.current;
      }, [flushSelection, saveXml]);
      flushDirtyRef.current = flushDirty;

      const loadSnapshot = React.useCallback((snapshot, { preserveSelection = true } = {}) => {
        const selected = preserveSelection
          ? (selectionRef.current.map(cell => cell.id).length > 0
            ? selectionRef.current.map(cell => cell.id)
            : pendingRestoreRef.current)
          : undefined;
        pendingRestoreRef.current = selected;
        saveConflictRef.current = false;
        pendingSaveXmlRef.current = undefined;
        loadedXmlRef.current = snapshot.xml;
        loadedRevisionRef.current = snapshot.revision;
        revisionRef.current = snapshot.revision;
        boardRef.current = {
          ...boardRef.current,
          boardId: snapshot.boardId,
          sessionId: snapshot.sessionId,
          pageId: snapshot.pageId,
          pageName: snapshot.pageName,
          title: snapshot.title,
          revision: snapshot.revision,
        };
        postToFrame(iframeRef.current?.contentWindow, {
          action: 'load',
          xml: snapshot.xml,
          title: snapshot.title,
          autosave: 1,
        });
      }, []);

      const refreshBoard = React.useCallback(({ preserveSelection = true } = {}) => {
        fetchQueueRef.current = fetchQueueRef.current.then(async () => {
          if (disposedRef.current) return;
          try {
            const snapshot = await fetchBoard(boardRef.current);
            if (disposedRef.current) return;
            loadSnapshot(snapshot, { preserveSelection });
            report('正在加载画布', `修订 ${snapshot.revision}`);
          } catch (error) {
            if (!disposedRef.current) report('读取失败', error.message);
          }
        }).catch(error => {
          if (!disposedRef.current) report('读取失败', error.message);
        });
      }, [loadSnapshot, report]);

      const exportDrawio = React.useCallback(() => {
        const getFileData = editorUiRef.current?.getFileData;
        if (typeof getFileData !== 'function') {
          throw new Error('编辑器尚未完成加载。');
        }
        const xml = getFileData.call(editorUiRef.current, true);
        if (typeof xml !== 'string' || xml.trim() === '') {
          throw new Error('编辑器没有返回可导出的 XML。');
        }
        const filename = `${String(boardRef.current.title || 'diagram')
          .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
          .trim()
          .slice(0, 100) || 'diagram'}.drawio`;
        const url = URL.createObjectURL(new Blob([xml], {
          type: 'application/vnd.jgraph.mxfile',
        }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.hidden = true;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }, []);

      React.useEffect(() => {
        controllerRef.current = {
          exportCurrent: exportDrawio,
          reloadLatest: () => refreshBoard({ preserveSelection: false }),
          clearSelection: () => {
            pendingRestoreRef.current = undefined;
            const graph = graphRef.current;
            if (graph !== undefined) graph.clearSelection();
            else postToFrame(iframeRef.current?.contentWindow, { action: 'resetEditor' });
            void requestSelectionSync().catch(() => undefined);
          },
        };
        return () => {
          controllerRef.current = undefined;
        };
      }, [controllerRef, exportDrawio, refreshBoard, requestSelectionSync]);

      React.useEffect(() => {
        const controller = {
          hasUnsyncedSelection() {
            return protocolReadyRef.current && (selectionRef.current.length > 0
              || selectionSyncDirtyRef.current
              || selectionSyncPromiseRef.current !== undefined
              || selectionTimerRef.current !== undefined);
          },
          ensureCurrentSelection() {
            return requestSelectionSync();
          },
        };
        registerSelectionSyncController(board.sessionId, board.boardId, controller);
        return () => unregisterSelectionSyncController(board.sessionId, controller);
      }, [board.boardId, board.sessionId, requestSelectionSync]);

      React.useEffect(() => {
        const mountedBoard = { ...board };
        disposedRef.current = false;
        configuringCanvasRef.current = false;
        loadedRevisionRef.current = 0;
        loadedXmlRef.current = '';
        selectionRef.current = [];
        refreshBoard({ preserveSelection: false });
        return () => {
          void flushDirtyRef.current(mountedBoard).catch(() => undefined);
          disposedRef.current = true;
          gestureCleanupRef.current?.();
          gestureCleanupRef.current = undefined;
          if (gestureTimerRef.current !== undefined) {
            clearTimeout(gestureTimerRef.current);
            gestureTimerRef.current = undefined;
          }
          for (const timer of canvasConfigurationTimersRef.current) clearTimeout(timer);
          canvasConfigurationTimersRef.current = [];
          configuringCanvasRef.current = false;
          if (exportWaiterRef.current !== undefined) {
            clearTimeout(exportWaiterRef.current.timer);
            exportWaiterRef.current.reject(new Error('画布已关闭。'));
            exportWaiterRef.current = undefined;
          }
          if (fallbackTimerRef.current !== undefined) clearInterval(fallbackTimerRef.current);
          const windowValue = graphWindowRef.current;
          for (const [source, listener] of graphListenersRef.current) {
            try { source?.removeListener?.(listener, windowValue?.mxEvent.CHANGE); } catch {}
          }
          graphListenersRef.current = [];
          graphRef.current = undefined;
          editorUiRef.current = undefined;
          graphWindowRef.current = undefined;
        };
      }, [board.boardId, refreshBoard]);

      React.useEffect(() => {
        if (!protocolReadyRef.current || board.revision <= loadedRevisionRef.current) return;
        if (dirtyRef.current) {
          report('保存冲突', '画板有来自模型或其他窗口的新修订；本地编辑仍保留，尚未覆盖。');
          return;
        }
        refreshBoard({ preserveSelection: true });
      }, [board.revision, refreshBoard, report]);

      React.useEffect(() => {
        const onMessage = event => {
          const frame = iframeRef.current?.contentWindow;
          if (disposedRef.current || event.origin !== window.location.origin
            || event.source !== frame) return;
          let message = event.data;
          if (typeof message === 'string') {
            try { message = JSON.parse(message); } catch { return; }
          }
          if (typeof message !== 'object' || message === null) return;
          if (message.event === 'init') {
            protocolReadyRef.current = true;
            report('正在加载画布');
            const snapshot = boardRef.current;
            if (loadedXmlRef.current !== '') {
              postToFrame(frame, {
                action: 'load',
                xml: loadedXmlRef.current,
                title: snapshot.title,
                autosave: 1,
              });
            } else {
              refreshBoard({ preserveSelection: false });
            }
            return;
          }
          if (message.event === 'load') {
            dirtyRef.current = false;
            dirtyGenerationRef.current = 0;
            selectionSyncedRef.current = false;
            editorReadyRef.current = graphRef.current !== undefined;
            bindGraph();
            configureEditorCanvas();
            if (graphRef.current !== undefined) {
              report('正在同步选区');
              window.setTimeout(restoreGraphSelection, 0);
            } else {
              report('画布已加载', '等待即时选区接口');
            }
            return;
          }
          if (message.event === 'autosave' || message.event === 'save') {
            if (configuringCanvasRef.current) return;
            if (typeof message.xml === 'string') saveXml(message.xml);
            return;
          }
          if (message.event === 'export' && message.format === 'json') {
            const waiter = exportWaiterRef.current;
            if (waiter !== undefined) {
              clearTimeout(waiter.timer);
              exportWaiterRef.current = undefined;
              waiter.resolve(message.data);
              return;
            }
            if (graphRef.current !== undefined) return;
            const cells = protocolSelectionCells(message.data, boardRef.current.pageId);
            void saveSelection(cells, { immediate: true }).catch(() => undefined);
          }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [
        bindGraph,
        configureEditorCanvas,
        refreshBoard,
        report,
        restoreGraphSelection,
        saveSelection,
        saveXml,
      ]);

      React.useEffect(() => {
        if (fallbackTimerRef.current !== undefined) clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = window.setInterval(() => {
          if (disposedRef.current || graphRef.current !== undefined) return;
          void requestSelectionSync().catch(() => undefined);
        }, FALLBACK_SELECTION_POLL_MS);
        return () => {
          if (fallbackTimerRef.current !== undefined) {
            clearInterval(fallbackTimerRef.current);
            fallbackTimerRef.current = undefined;
          }
        };
      }, [requestSelectionSync]);

      const frameUrl = `${PREFIX}/drawio/index.html?embed=1&proto=json&configure=0`
        + '&offline=1&stealth=1&ui=min&lang=zh&noSaveBtn=1&noExitBtn=1';
      return h('div', {
        ref: rootRef,
        className: 'cc-drawio-frame-wrap',
        'data-drawio-editor': '',
      }, h('iframe', {
        ref: iframeRef,
        className: 'cc-drawio-frame',
        src: frameUrl,
        title: 'draw.io 画布',
        referrerPolicy: 'no-referrer',
        onLoad: attachSelectionGestures,
      }));
    }

    function FixedChatConversationView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    function DrawioSelectionDock() {
      const context = React.useContext(CanvasSelection);
      if (!context?.cells.length) return null;
      const { cells, clear } = context;
      return h('div', { className: 'cc-drawio-selection-dock' },
        h('div', { className: 'cc-drawio-selection-chip' },
          h('span', { role: 'status' }, `画布选区 · ${cells.length} 个图元`),
          h('button', { type: 'button', onClick: clear, 'aria-label': '清除画布选区', title: '清除选区' },
            h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              h('path', { d: 'm4 4 8 8m0-8-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
            ),
          ),
        ),
      );
    }

    function sentSelectionCounts(snapshot) {
      const counts = new Map();
      for (const node of snapshot.nodes.values()) {
        const source = node.kind === 'context' ? node.data.source : undefined;
        const location = node.location;
        if (source?.kind !== PANEL_ID || location.kind !== 'step') continue;
        const count = source.selectedCellCount;
        if (!Number.isSafeInteger(count) || count < 1 || count > 512) continue;
        const keys = snapshot.locations.getStep(location.turn.turn, location.step.step);
        let prompt;
        for (const key of keys) {
          const candidate = snapshot.nodes.get(key);
          if ((candidate?.kind === 'user' || candidate?.kind === 'steering')
            && candidate.data.seq < node.data.seq
            && (prompt === undefined || candidate.data.seq > prompt.data.seq)) prompt = candidate;
        }
        if (prompt !== undefined) counts.set(prompt.key, count);
      }
      return counts;
    }

    function useSentSelectionBadges(useChat, rootRef) {
      const snapshot = useChat(value => value);
      React.useEffect(() => {
        const root = rootRef.current;
        if (root === null) return undefined;
        const counts = sentSelectionCounts(snapshot);
        const update = () => {
          for (const row of root.querySelectorAll('[data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]')) {
            const count = counts.get(row.getAttribute('data-chat-node-key'));
            const badge = row.querySelector(':scope > [data-drawio-sent-selection]');
            if (count === undefined) {
              badge?.remove();
              continue;
            }
            if (badge?.dataset.drawioSentSelection === String(count)) continue;
            const label = badge ?? document.createElement('span');
            label.className = 'cc-drawio-sent-selection';
            label.dataset.drawioSentSelection = String(count);
            label.textContent = `画布选区 · ${count} 个图元`;
            if (badge === null) row.append(label);
          }
        };
        update();
        const observer = new MutationObserver(update);
        observer.observe(root, { childList: true, subtree: true });
        return () => observer.disconnect();
      }, [snapshot, rootRef]);
    }

    function DrawioConversationSlotPanel(props) {
      useAutoCanvas(props, props.selectPanel, true);
      useLegacyCanvasLink(props, props.selectPanel);
      const session = props.useSession(value => value);
      const conversation = props.useConversation(value => value);
      const input = props.useInput(value => value);
      const [sendError, setSendError] = React.useState('');
      const chatRootRef = React.useRef(null);
      useSentSelectionBadges(props.useChat, chatRootRef);
      const submitBarrierRef = React.useRef(false);
      const currentDraft = input?.draft ?? '';
      const active = conversation.activeTargets.size > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running;
      const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank';
      const summaryBlank = props.useSessions(state => state.byId[props.sessionId]?.blank);
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
      const hero = shellPhase === 'blank'
        && (session.openState === 'open' || summaryBlank === true);
      const phase = settling ? 'settling' : hero ? 'hero' : 'active';
      React.useEffect(() => {
        if (props.inputActions === undefined) return undefined;
        const onSubmitGesture = event => {
          const target = event.target;
          if (!(target instanceof Element)
            || target.closest('[data-capability-center-drawio]') === null
            || !canGateCanvasSubmit(event, input, session, currentDraft)) return;
          if (event.type === 'keydown') {
            if (event.key !== 'Enter' || target.closest('[data-composer-input][contenteditable=true]') === null) {
              return;
            }
          } else {
            const card = target.closest('[data-composer-card]');
            const button = target.closest('button');
            if (card === null || button === null) return;
            const enabled = [...card.querySelectorAll('button:not(:disabled)')];
            if (enabled.at(-1) !== button) return;
          }
          const controller = currentSelectionSyncController(props.sessionId);
          if (controller?.hasUnsyncedSelection() !== true) return;
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          if (submitBarrierRef.current) return;
          submitBarrierRef.current = true;
          setSendError('');
          controller.ensureCurrentSelection()
            .then(() => props.inputActions.submit())
            .catch(error => {
              setSendError(`选区同步失败，消息未发送：${error.message}`);
            })
            .finally(() => {
              submitBarrierRef.current = false;
            });
        };
        window.addEventListener('keydown', onSubmitGesture, true);
        window.addEventListener('click', onSubmitGesture, true);
        return () => {
          window.removeEventListener('keydown', onSubmitGesture, true);
          window.removeEventListener('click', onSubmitGesture, true);
        };
      }, [currentDraft, input, props.inputActions, props.sessionId, session]);
      return h('div', { className: 'cc-drawio-chat-content', ref: chatRootRef },
        sendError === '' ? null : h('div', {
          role: 'status',
          'data-drawio-send-error': '',
          style: {
            padding: '5px 14px',
            color: '#b42318',
            fontSize: '12px',
            borderBottom: '1px solid var(--dsw-alias-border-secondary,#ddd)',
          },
        }, sendError),
        props.renderFactorySlot(
          'conversation.content',
          { variant: 'embedded', phase, hero },
          { slots: { views: FixedChatConversationView } },
        ),
      );
    }

    function DrawioCanvasPanel(props) {
      const sessionId = props.sessionId ?? pendingCreate?.sessionId ?? boardStore.getSnapshot()?.sessionId;
      const storedBoard = useBoard(sessionId);
      const creating = pendingCreate?.sessionId === sessionId && pendingCreate !== undefined;
      const board = creating ? undefined : storedBoard;
      const sessions = props.sessions ?? props;
      const layout = props.layout ?? props;
      const [reference, setReference] = React.useState(undefined);
      const [referenceError, setReferenceError] = React.useState('');
      const [status, setStatus] = React.useState({
        status: '正在加载画布',
        detail: '',
        selection: [],
      });
      const rootRef = React.useRef(null);
      const editorControllerRef = React.useRef(undefined);
      const collapsedSidebarRef = React.useRef(false);
      const [splitPercent, setSplitPercent] = React.useState(70);
      const dragRef = React.useRef(undefined);

      React.useEffect(() => {
        const appFrame = document.querySelector('[data-shell-bottom]')?.parentElement;
        if (appFrame !== undefined
          && appFrame.hasAttribute('data-sidebar-collapsed') === false
          && typeof layout?.toggleSidebar === 'function') {
          layout.toggleSidebar();
          collapsedSidebarRef.current = true;
        }
        return () => {
          if (!collapsedSidebarRef.current) return;
          const currentFrame = document.querySelector('[data-shell-bottom]')?.parentElement;
          if (currentFrame?.getAttribute('data-sidebar-collapsed') === 'true'
            && typeof layout?.toggleSidebar === 'function') {
            layout.toggleSidebar();
          }
          collapsedSidebarRef.current = false;
        };
      }, [layout]);

      React.useEffect(() => {
        if (sessionId === undefined) {
          setReference(undefined);
          setReferenceError('');
          return undefined;
        }
        const controller = new AbortController();
        let retained;
        setReference(undefined);
        setReferenceError('');
        try {
          retained = sessions.retain(sessionId, {
            source: 'drawioCanvas',
            signal: controller.signal,
          });
          setReference(retained);
        } catch (error) {
          setReferenceError(error.message);
          return () => controller.abort();
        }
        retained.ready.catch(error => {
          if (!controller.signal.aborted) setReferenceError(error.message);
        });
        return () => {
          controller.abort(new Error('画布已关闭。'));
          retained?.release();
        };
      }, [sessionId, sessions]);

      React.useEffect(() => {
        if (creating || board !== undefined || typeof props.sessionId !== 'string') return undefined;
        const controller = new AbortController();
        fetchActiveBoard(props.sessionId).then(value => {
          if (!controller.signal.aborted) boardStore.note(value);
        }).catch(() => undefined);
        return () => controller.abort();
      }, [creating, board?.boardId, props.sessionId]);

      React.useEffect(() => {
        if (board === undefined) return undefined;
        let cancelled = false;
        const poll = async () => {
          try {
            const value = await fetchBoard(board);
            if (!cancelled && (value.revision > board.revision
              || value.title !== board.title
              || value.pageId !== board.pageId)) {
              boardStore.note(value);
            }
          } catch {
            // The editor owns visible fetch failures; polling only refreshes revisions.
          }
        };
        const timer = window.setInterval(poll, 1500);
        const onFocus = () => { void poll(); };
        window.addEventListener('focus', onFocus);
        void poll();
        return () => {
          cancelled = true;
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, [board?.boardId, board?.revision, board?.sessionId]);

      React.useEffect(() => {
        const onMove = event => {
          if (dragRef.current === undefined) return;
          const rect = rootRef.current?.getBoundingClientRect();
          if (rect === undefined || rect.width <= 0) return;
          const percent = ((event.clientX - rect.left) / rect.width) * 100;
          setSplitPercent(Math.max(34, Math.min(82, percent)));
        };
        const onUp = () => { dragRef.current = undefined; };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
      }, []);

      const onStatus = React.useCallback(next => {
        setStatus(current => typeof next === 'function' ? next(current) : next);
      }, []);

      if (board === undefined && !creating) {
        return h('div', {
          className: 'cc-drawio-empty',
          'data-capability-center-drawio': '',
        },
        h('h2', { style: { margin: 0 } }, 'draw.io 画布'),
        h('p', { style: { margin: 0, color: '#666' } }, '请先在对话中创建或打开一个画布。'),
        h('button', {
          type: 'button',
          className: 'cc-drawio-action',
          onClick: () => layout.selectPanel(null),
        }, '返回聊天'));
      }

      const exportCurrent = () => {
        try {
          editorControllerRef.current?.exportCurrent();
          setStatus(current => ({ ...current, status: '编辑器已就绪', detail: '已导出 .drawio 文件' }));
        } catch (error) {
          setStatus(current => ({ ...current, status: '导出失败', detail: error.message }));
        }
      };
      const reloadLatest = () => {
        editorControllerRef.current?.reloadLatest();
      };

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', {
          ref: rootRef,
          className: 'cc-drawio-root',
          'data-capability-center-drawio': '',
          'data-drawio-board-id': board?.boardId,
          'data-drawio-revision': board === undefined ? undefined : String(board.revision),
          'data-drawio-selection-count': String(board === undefined ? 0 : status.selection.length),
        },
        h('section', {
          className: 'cc-drawio-left',
          style: { flexBasis: `${splitPercent}%` },
          'aria-label': 'draw.io 画布',
        },
        h('div', { className: 'cc-drawio-head' },
          h('span', { className: 'cc-drawio-title' }, board?.title ?? 'draw.io 画布'),
          h('span', { className: 'cc-drawio-meta' }, board === undefined ? '' : `修订 ${board.revision}`),
          board === undefined ? null : h('button', {
            type: 'button',
            className: 'cc-drawio-action',
            onClick: exportCurrent,
          }, '导出 .drawio'),
          h('button', {
            type: 'button',
            className: 'cc-drawio-action',
            onClick: () => layout.selectPanel(null),
          }, '返回聊天'),
        ),
        board === undefined ? null : h('div', { className: 'cc-drawio-status' },
          h('span', {
            className: 'cc-drawio-dot',
            'data-ready': status.status === '编辑器已就绪' ? 'true' : 'false',
          }),
          h('span', null, status.status),
          status.detail === '' ? null : h('span', {
            className: /失败|冲突|其他页面/.test(status.detail) ? 'cc-drawio-error' : '',
            title: status.detail,
          }, status.detail),
          /冲突/u.test(status.status) ? h('button', {
            type: 'button',
            className: 'cc-drawio-action',
            onClick: reloadLatest,
          }, '重新载入最新画板') : null,
        ),
        board === undefined
          ? h('div', { className: 'cc-drawio-empty', role: 'status' }, '正在创建画布…')
          : h(DrawioEditor, { key: board.boardId, board, onStatus, controllerRef: editorControllerRef }),
        ),
        h('div', {
          className: 'cc-drawio-split',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-valuenow': Math.round(splitPercent),
          onPointerDown: event => {
            event.preventDefault();
            dragRef.current = event.pointerId;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          },
        }),
        h('section', { className: 'cc-drawio-chat', 'aria-label': '原会话' },
          h('div', { className: 'cc-drawio-chat-bar' },
            h('strong', null, '画布对话'),
          ),
          h('div', { className: 'cc-drawio-chat-body' },
            referenceError !== '' ? h('div', { className: 'cc-drawio-empty' },
              h('span', { className: 'cc-drawio-error' }, `无法绑定原会话：${referenceError}`),
            ) : reference === undefined ? h('div', { className: 'cc-drawio-empty' },
              h('span', null, '正在绑定原会话…'),
            ) : h(CanvasSelection.Provider, {
              value: {
                cells: board === undefined ? [] : status.selection,
                clear: () => editorControllerRef.current?.clearSelection(),
              },
            }, h(props.SessionProvider, { session: reference },
              props.renderSlot(CHAT_SLOT, {}),
            ),
            ),
          ),
        ),
        ),
      );
    }

    function DrawioHeaderAction(props) {
      useAutoCanvas(props, props.selectPanel);
      useLegacyCanvasLink(props, props.selectPanel);
      const board = useBoard(props.sessionId);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        if (board !== undefined || typeof props.sessionId !== 'string') return undefined;
        const controller = new AbortController();
        fetchActiveBoard(props.sessionId).then(value => {
          if (!controller.signal.aborted) boardStore.note(value);
        }).catch(() => undefined);
        return () => controller.abort();
      }, [board?.boardId, props.sessionId]);
      if (board === undefined) return null;
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'cc-drawio-header-action',
          title: error === '' ? `打开《${board.title}》` : `无法打开：${error}`,
          'data-drawio-header-action': '',
          'data-drawio-board-id': board.boardId,
          disabled: busy,
          onClick: async () => {
            setError('');
            setBusy(true);
            try {
              await openCanvas(board, props.selectPanel);
            } catch (cause) {
              setError(cause.message);
            } finally {
              setBusy(false);
            }
          },
        }, busy ? '正在打开…' : 'draw.io 画布'));
    }

    function DrawioTurnCard(props) {
      const call = props.useChat(snapshot => findBoardCall(snapshot, props.turn.turn, RESULT_TOOLS));
      const board = boundedBoard(call?.meta);
      const [error, setError] = React.useState('');
      if (board === undefined || board.sessionId !== props.sessionId || props.turn.status !== 'closed') return null;
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'cc-tool-card', 'data-drawio-turn-card': board.boardId },
          h('div', { className: 'cc-tool-row' },
            h('div', { className: 'cc-drawio-result' },
              h('span', { className: 'cc-drawio-result-kind' },
                call.name === 'drawio_edit' ? '已更新画布' : 'draw.io 画布'),
              h('strong', { className: 'cc-tool-title' }, board.title),
            ),
            h('button', {
              type: 'button',
              className: 'cc-drawio-action',
              style: { marginLeft: 'auto' },
              onClick: () => {
                setError('');
                openCanvas(board, props.selectPanel).catch(cause => setError(cause.message));
              },
            }, '打开画布'),
          ),
          error === '' ? null : h('div', { role: 'status', className: 'cc-tool-copy' }, error),
        ),
      );
    }

    function DrawioToolCard(props) {
      const { toolName, phase, block, callId } = props;
      const meta = phase === 'result' ? boundedBoard(block?.meta) : undefined;
      const [activationError, setActivationError] = React.useState('');
      const [activating, setActivating] = React.useState(false);
      const titles = {
        drawio_create: '创建 draw.io 画布',
        drawio_get_selection: '读取画布选区',
        drawio_get_diagram: '读取画布原图',
        drawio_edit: '更新画布图元',
        drawio_open: '打开 draw.io 画布',
      };
      const running = phase !== 'result';
      const failed = phase === 'result' && block?.isError === true;
      const copy = activationError !== ''
        ? `无法激活画板：${activationError}`
        : failed
        ? '画布操作失败，未写入不完整或过期的修改。'
        : running
          ? '正在处理当前会话绑定的画板…'
          : meta === undefined
            ? '没有收到可用的画板绑定。'
            : `${meta.title} · 修订 ${meta.revision} · 工具过程折叠后可从会话头部“draw.io 画布”重新进入。`;
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', {
          className: 'cc-tool-card',
          'data-drawio-tool-card': toolName,
          'data-drawio-call-id': callId,
          'data-drawio-board-id': meta?.boardId,
          'data-drawio-revision': meta === undefined ? undefined : String(meta.revision),
        },
        h('div', { className: 'cc-tool-row' },
          h('span', { 'aria-hidden': true }, '◇'),
          h('span', { className: 'cc-tool-title' }, titles[toolName] ?? 'draw.io 画布'),
          meta === undefined ? null : h('button', {
            type: 'button',
            className: 'cc-drawio-action',
            style: { marginLeft: 'auto' },
            disabled: activating,
            onClick: async () => {
              if (activating) return;
              setActivationError('');
              setActivating(true);
              try {
                await openCanvas(meta, props.selectPanel);
              } catch (error) {
                setActivationError(error.message);
              } finally {
                setActivating(false);
              }
            },
          }, activating ? '正在打开…' : '进入画布'),
        ),
        h('div', { className: 'cc-tool-copy' }, copy),
      ),
      );
    }

    module.exports = {
      inject: ['slots', 'sessions', 'layout'],
      apply(ctx) {
        const sessions = ctx.get('sessions') ?? ctx.sessions;
        const layout = ctx.get('layout') ?? ctx.layout;
        const selectPanel = panelId => layout.selectPanel(panelId);

        ctx.slots.inject(CHAT_SLOT, () => ctx.slots.register({
          name: CHAT_SLOT,
        }, props => h(DrawioConversationSlotPanel, { ...props, selectPanel })));

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: PANEL_ID,
        }, props => h(DrawioTurnCard, { ...props, selectPanel })));

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: PANEL_ID,
        }, DrawioSelectionDock));

        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            children: {
              [CHAT_SLOT]: { kind: 'single', scope: 'session' },
            },
          }, props => h(DrawioCanvasPanel, {
            ...props,
            sessions,
            layout,
          }));
        });

        ctx.slots.inject('tool.call.toolview', function* () {
          for (const toolName of TOOL_NAMES) {
            yield ctx.slots.register({
              name: 'tool.call.toolview',
              key: toolName,
            }, props => h(DrawioToolCard, {
              ...props,
              selectPanel,
            }));
          }
        });

        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'capability-center-drawio',
          order: 20,
        }, props => h(DrawioHeaderAction, {
          ...props,
          selectPanel,
        })));

        ctx.effect(() => () => {
          boardStore.publish(boardStore.getSnapshot());
        }, 'capability-center-drawio: client store');

        if (sessions === undefined || typeof sessions.retain !== 'function') {
          throw new Error('capability-center-drawio: DSH sessions.retain 不可用。');
        }
      },
    };
    return module.exports;
  },
});
