(function () {
  const shared = globalThis.BiliKeywordBlockerShared;
  if (!shared) {
    return;
  }

  const {
    STORAGE_KEY,
    mergeState,
    findMatchedKeyword,
    extractMidFromElement,
    getNicknameFromElement
  } = shared;

  const BLOCK_REQUEST_EVENT = "bili-keyword-blocker:block";
  const BLOCK_RESULT_EVENT = "bili-keyword-blocker:block-result";
  const RELATION_REQUEST_EVENT = "bili-keyword-blocker:relation-query";
  const RELATION_RESULT_EVENT = "bili-keyword-blocker:relation-query-result";
  const PREFERRED_NAME_SELECTOR = [
    "#user-name",
    "#sub-user-name",
    ".user-name",
    ".sub-user-name"
  ].join(",");
  const USER_NODE_SELECTOR = [
    "#user-name",
    "#sub-user-name",
    ".user-name",
    ".sub-user-name"
  ].join(",");
  const COMMENT_CONTAINER_SELECTORS = [
    ".reply-item",
    ".sub-reply-item",
    ".comment-item",
    ".comment-list-item",
    ".reply-wrap",
    ".comment-list",
    ".comment-container",
    ".comment-module",
    ".comment-thread",
    ".root-reply-container",
    ".sub-reply-container",
    ".bili-comment",
    ".bili-comments",
    ".bili-comment-thread-renderer",
    ".bili-comment-reply-renderer",
    "#comment",
    "#commentapp"
  ];
  const GENERAL_HIDE_CONTAINER_SELECTORS = [
    ...COMMENT_CONTAINER_SELECTORS,
    ".feed-card",
    ".dynamic-item",
    ".video-card",
    ".bili-video-card",
    "article",
    "li"
  ];
  const COMMENT_CONTAINER_SELECTOR = COMMENT_CONTAINER_SELECTORS.join(",");
  const GENERAL_HIDE_CONTAINER_SELECTOR = GENERAL_HIDE_CONTAINER_SELECTORS.join(",");
  const COMMENT_HINTS = ["comment", "reply", "root-reply", "sub-reply"];
  const USER_CONTAINER_SELECTOR = [
    "#user-name",
    "#sub-user-name",
    ".user-name",
    ".sub-user-name"
  ].join(",");
  const OBSERVER_OPTIONS = {
    attributes: true,
    attributeFilter: ["href", "title", "aria-label", "class"],
    characterData: true,
    childList: true,
    subtree: true
  };
  const inspectedNodes = new WeakMap();
  const queuedUserIds = new Set();
  const blockedQueue = [];
  const pendingRequests = new Map();
  const pendingRelationRequests = new Map();
  const observedRoots = new WeakSet();
  const relationStateByMid = new Map();

  let state = mergeState();
  let observer = null;
  let queueBusy = false;
  let scanTimer = 0;
  let stateVersion = 0;
  let fullRefreshPending = false;

  init().catch((error) => {
    console.error("[BiliKeywordBlocker] init failed", error);
  });

  async function init() {
    injectBridge();
    ensureStylesForRoot(document);
    state = await loadState();
    stateVersion += 1;
    fullRefreshPending = true;
    registerStorageListener();
    registerBridgeListener();
    startObserver();
    scanPage(document.body, {
      fullRefresh: true
    });
  }

  function injectBridge() {
    if (document.documentElement.dataset.bkbBridgeInjected === "1") {
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.dataset.bkbBridge = "1";
    script.onload = function () {
      script.remove();
    };

    document.documentElement.dataset.bkbBridgeInjected = "1";
    (document.head || document.documentElement).appendChild(script);
  }

  function ensureStylesForRoot(rootNode) {
    if (rootNode instanceof Document && document.getElementById("bkb-style")) {
      return;
    }

    if (rootNode instanceof ShadowRoot && rootNode.querySelector('style[data-bkb-style="1"]')) {
      return;
    }

    const style = document.createElement("style");
    style.id = rootNode instanceof Document ? "bkb-style" : "";
    style.dataset.bkbStyle = "1";
    style.textContent = `
      .bkb-inline {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 6px;
        font-size: 12px;
        vertical-align: middle;
      }

      .bkb-tag {
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(255, 107, 129, 0.14);
        color: #d33a56;
        line-height: 18px;
      }

      .bkb-button {
        border: none;
        border-radius: 999px;
        padding: 2px 8px;
        background: #00aeec;
        color: #fff;
        cursor: pointer;
        line-height: 18px;
      }

      .bkb-button.is-blocked {
        background: #5e718d;
      }

      .bkb-button.is-failed {
        background: #f39c12;
      }

      .bkb-button.is-queued {
        background: #4f6ef7;
      }

      .bkb-hidden {
        opacity: 0.25 !important;
        transition: opacity 0.2s ease;
      }
    `;

    if (rootNode instanceof ShadowRoot) {
      rootNode.appendChild(style);
      return;
    }

    document.documentElement.appendChild(style);
  }

  async function loadState() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return mergeState(stored[STORAGE_KEY]);
  }

  function registerStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) {
        return;
      }

      state = mergeState(changes[STORAGE_KEY].newValue);
      stateVersion += 1;
      fullRefreshPending = true;
      scheduleRescan();
    });
  }

  function registerBridgeListener() {
    window.addEventListener(BLOCK_RESULT_EVENT, async (event) => {
      const detail = event && event.detail ? event.detail : {};
      const pending = pendingRequests.get(detail.requestId);

      if (!pending) {
        return;
      }

      pendingRequests.delete(detail.requestId);
      queuedUserIds.delete(String(pending.mid));

      await saveProcessedUser(pending, detail);
      relationStateByMid.set(String(pending.mid), {
        status: detail.ok ? "blocked" : "not_blocked",
        updatedAt: Date.now(),
        attribute: detail.ok ? 128 : 0
      });
      refreshButtons(String(pending.mid));

      window.setTimeout(() => {
        queueBusy = false;
        pumpQueue();
      }, 900);
    });

    window.addEventListener(RELATION_RESULT_EVENT, async (event) => {
      const detail = event && event.detail ? event.detail : {};
      const requestMid = pendingRelationRequests.get(detail.requestId);
      if (!requestMid) {
        return;
      }

      pendingRelationRequests.delete(detail.requestId);

      relationStateByMid.set(String(requestMid), {
        status: detail.ok ? (detail.isBlocked ? "blocked" : "not_blocked") : "error",
        updatedAt: Date.now(),
        attribute: Number(detail.attribute) || 0,
        message: detail.message || ""
      });

      if (detail.ok) {
        await syncRecentActionWithRelation(String(requestMid), Boolean(detail.isBlocked));
      }

      refreshButtons(String(requestMid));
    });
  }

  function startObserver() {
    if (!document.body) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (!state.enabled) {
        return;
      }

      const roots = [];
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) {
              roots.push(node);
              observeNestedShadowRoots(node);
            }
          }
        }

        if (mutation.type === "characterData") {
          const element = mutation.target && mutation.target.parentElement;
          if (element) {
            roots.push(element);
          }
        }

        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          roots.push(mutation.target);
        }
      }

      if (!roots.length) {
        return;
      }

      if (roots.length > 20) {
        scheduleRescan();
        return;
      }

      for (const root of roots) {
        scanPage(root);
      }
    });

    observeRoot(document.body);
    observeNestedShadowRoots(document.body);
  }

  function scheduleRescan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      const fullRefresh = fullRefreshPending;
      fullRefreshPending = false;
      scanPage(document.body, {
        fullRefresh
      });
    }, 120);
  }

  function scanPage(root, options) {
    const fullRefresh = Boolean(options && options.fullRefresh);

    if (fullRefresh) {
      resetDecorations();
    }

    cleanupMarkers();

    if (!state.enabled || !root || !(root instanceof Element || root instanceof Document || root instanceof DocumentFragment)) {
      return;
    }

    const anchors = [];
    for (const searchRoot of collectSearchRoots(root)) {
      if (searchRoot instanceof ShadowRoot) {
        ensureStylesForRoot(searchRoot);
      }

      if (searchRoot instanceof Element && searchRoot.matches(USER_NODE_SELECTOR)) {
        anchors.push(searchRoot);
      }

      if (searchRoot.querySelectorAll) {
        anchors.push(...searchRoot.querySelectorAll(USER_NODE_SELECTOR));
      }
    }

    if (root instanceof Element) {
      const nearestUserNode = root.closest(USER_NODE_SELECTOR);
      if (nearestUserNode) {
        anchors.push(nearestUserNode);
      }
    }

    const uniqueNodes = Array.from(
      new Set(
        anchors
          .map((node) => normalizeUserNode(node))
          .filter(Boolean)
      )
    );

    for (const anchor of uniqueNodes) {
      if (!shouldInspectAnchor(anchor)) {
        continue;
      }

      processAnchor(anchor);
    }
  }

  function shouldInspectAnchor(anchor) {
    if (!(anchor instanceof Element)) {
      return false;
    }

    if (!state.commentsOnly) {
      return true;
    }

    return Boolean(findContainerAcrossBoundaries(anchor, COMMENT_CONTAINER_SELECTOR) || hasCommentLikeAncestor(anchor));
  }

  function hasCommentLikeAncestor(element) {
    return Boolean(findCommentLikeAncestor(element));
  }

  function processAnchor(anchor) {
    if (!(anchor instanceof Element)) {
      return;
    }

    const mid = extractMidFromElement(anchor);
    const nickname = resolveNickname(anchor);

    if (!mid || !nickname) {
      return;
    }

    const signature = `${stateVersion}|${mid}|${nickname}`;
    const existingMarker = getMarker(anchor, String(mid));
    if (inspectedNodes.get(anchor) === signature && existingMarker) {
      updateExistingMarker(anchor, mid);
      return;
    }

    inspectedNodes.set(anchor, signature);

    const matchedKeyword = findMatchedKeyword(nickname, state.keywords, state.caseSensitive);
    if (!matchedKeyword) {
      removeMarker(anchor);
      return;
    }

    ensureRelationState(mid);

    renderMarker(anchor, {
      mid,
      nickname,
      matchedKeyword
    });

    if (state.hideMatched) {
      const target = findHideContainer(anchor);
      if (target) {
        target.classList.add("bkb-hidden");
        target.dataset.bkbHidden = "1";
      }
    }

    if (state.autoBlock) {
      enqueueBlock({
        mid,
        nickname,
        matchedKeyword,
        source: "auto"
      });
    }
  }

  function renderMarker(anchor, info) {
    const rootNode = anchor.getRootNode && anchor.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      ensureStylesForRoot(rootNode);
    }

    const scope = getMarkerScope(anchor);
    cleanupExistingMarkers(scope, String(info.mid));

    let marker = getMarker(anchor, String(info.mid));
    if (!marker) {
      marker = document.createElement("span");
      marker.className = "bkb-inline";
      marker.innerHTML = '<span class="bkb-tag"></span><button type="button" class="bkb-button"></button>';
      anchor.insertAdjacentElement("afterend", marker);
    }

    marker.dataset.mid = String(info.mid);
    marker.dataset.keyword = info.matchedKeyword;

    const tag = marker.querySelector(".bkb-tag");
    const button = marker.querySelector(".bkb-button");

    if (tag) {
      tag.textContent = `命中：${info.matchedKeyword}`;
    }

    if (button) {
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        enqueueBlock({
          mid: info.mid,
          nickname: info.nickname,
          matchedKeyword: info.matchedKeyword,
          source: "manual"
        });
      };
    }

    updateButtonState(button, String(info.mid));
  }

  function updateExistingMarker(anchor, mid) {
    const marker = getMarker(anchor, String(mid));
    if (!marker) {
      return;
    }

    const button = marker.querySelector(".bkb-button");
    updateButtonState(button, String(mid));
  }

  function updateButtonState(button, mid) {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const processed = state.processedUsers[String(mid)];
    const queued = queuedUserIds.has(String(mid));
    const relationState = relationStateByMid.get(String(mid));

    button.classList.remove("is-blocked", "is-failed", "is-queued");

    if (relationState && relationState.status === "blocked") {
      button.textContent = "已在黑名单";
      button.classList.add("is-blocked");
      button.disabled = true;
      return;
    }

    if (queued) {
      button.textContent = "处理中";
      button.classList.add("is-queued");
      button.disabled = true;
      return;
    }

    if (!relationState || relationState.status === "checking") {
      button.textContent = "校验中";
      button.classList.add("is-queued");
      button.disabled = true;
      return;
    }

    if (processed && processed.status === "failed") {
      button.textContent = "重试拉黑";
      button.classList.add("is-failed");
      button.disabled = false;
      return;
    }

    button.textContent = state.autoBlock ? "等待拉黑" : "拉黑";
    button.disabled = false;
  }

  function refreshButtons(mid) {
    queryAllAcrossRoots(`.bkb-inline[data-mid="${mid}"] .bkb-button`).forEach((button) => {
      updateButtonState(button, mid);
    });
  }

  function getMarker(anchor, mid) {
    const sibling = anchor.nextElementSibling;
    if (
      sibling &&
      sibling.classList.contains("bkb-inline") &&
      (!mid || sibling.dataset.mid === String(mid))
    ) {
      return sibling;
    }

    const scope = getMarkerScope(anchor);
    if (scope && scope.querySelectorAll && mid) {
      const existing = scope.querySelector(`.bkb-inline[data-mid="${mid}"]`);
      if (existing) {
        return existing;
      }
    }

    return null;
  }

  function removeMarker(anchor) {
    const marker = getMarker(anchor, String(extractMidFromElement(anchor) || ""));
    if (marker) {
      marker.remove();
    }
  }

  function resolveNickname(element) {
    if (element.querySelector) {
      const preferredLink = element.querySelector('a[href*="space.bilibili.com"], a[href*="/space/"]');
      if (preferredLink instanceof Element) {
        const fromLink = getNicknameFromElement(preferredLink);
        if (fromLink) {
          return fromLink;
        }
      }

      const nestedNameNode =
        element.querySelector("#user-name,#sub-user-name,.user-name,.sub-user-name,.user,[title],[aria-label]") ||
        element.querySelector("a,span");

      if (nestedNameNode instanceof Element) {
        const clone = nestedNameNode.cloneNode(true);
        if (clone instanceof Element && clone.querySelectorAll) {
          clone.querySelectorAll(".bkb-inline").forEach((node) => node.remove());
        }

        const fromNested = getNicknameFromElement(clone);
        if (fromNested) {
          return fromNested;
        }
      }
    }

    const clone = element.cloneNode(true);
    if (clone instanceof Element && clone.querySelectorAll) {
      clone.querySelectorAll(".bkb-inline").forEach((node) => node.remove());
    }

    return getNicknameFromElement(clone);
  }

  function cleanupMarkers() {
    if (state.enabled) {
      syncHiddenElements();
    } else {
      resetDecorations();
    }
  }

  function syncHiddenElements() {
    if (state.enabled && state.hideMatched) {
      return;
    }

    queryAllAcrossRoots(".bkb-hidden").forEach((element) => {
      element.classList.remove("bkb-hidden");
      delete element.dataset.bkbHidden;
    });
  }

  function resetDecorations() {
    queryAllAcrossRoots(".bkb-inline").forEach((marker) => marker.remove());
    queryAllAcrossRoots(".bkb-hidden").forEach((element) => {
      element.classList.remove("bkb-hidden");
      delete element.dataset.bkbHidden;
    });
  }

  function observeRoot(root) {
    if (!observer || !root || observedRoots.has(root)) {
      return;
    }

    observer.observe(root, OBSERVER_OPTIONS);
    observedRoots.add(root);
  }

  function observeNestedShadowRoots(root) {
    for (const searchRoot of collectSearchRoots(root)) {
      if (searchRoot instanceof ShadowRoot) {
        ensureStylesForRoot(searchRoot);
        observeRoot(searchRoot);
      }
    }
  }

  function collectSearchRoots(root) {
    const queue = [root];
    const seen = new Set();
    const roots = [];

    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) {
        continue;
      }

      seen.add(current);

      if (isQueryableRoot(current)) {
        roots.push(current);
      }

      const traversalRoot = current instanceof Document ? current.documentElement : current;
      if (!traversalRoot || !traversalRoot.querySelectorAll) {
        continue;
      }

      if (traversalRoot instanceof Element && traversalRoot.shadowRoot) {
        queue.push(traversalRoot.shadowRoot);
      }

      traversalRoot.querySelectorAll("*").forEach((element) => {
        if (element.shadowRoot) {
          queue.push(element.shadowRoot);
        }
      });
    }

    return roots;
  }

  function isQueryableRoot(root) {
    return Boolean(
      root &&
        (root instanceof Element ||
          root instanceof Document ||
          root instanceof DocumentFragment ||
          root instanceof ShadowRoot)
    );
  }

  function queryAllAcrossRoots(selector) {
    const results = [];

    for (const root of collectSearchRoots(document)) {
      if (root.querySelectorAll) {
        results.push(...root.querySelectorAll(selector));
      }
    }

    return results;
  }

  function findHideContainer(anchor) {
    const selector = state.commentsOnly ? COMMENT_CONTAINER_SELECTOR : GENERAL_HIDE_CONTAINER_SELECTOR;
    return findContainerAcrossBoundaries(anchor, selector) || findCommentLikeAncestor(anchor);
  }

  function findCommentLikeAncestor(element) {
    return findAncestorAcrossBoundaries(element, (current) => {
      const raw = getIdentityText(current);
      return COMMENT_HINTS.some((hint) => raw.includes(hint));
    });
  }

  function normalizeUserNode(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    if (node.matches(PREFERRED_NAME_SELECTOR)) {
      return node;
    }

    const namedAncestor = node.closest(PREFERRED_NAME_SELECTOR);
    if (namedAncestor) {
      return namedAncestor;
    }

    if (node.querySelector) {
      const namedDescendant = node.querySelector(PREFERRED_NAME_SELECTOR);
      if (namedDescendant instanceof Element) {
        return namedDescendant;
      }
    }

    const preferredInRoot = findPreferredNodeInSameRoot(node);
    if (preferredInRoot) {
      return preferredInRoot;
    }

    return node.closest(USER_CONTAINER_SELECTOR) || node;
  }

  function ensureRelationState(mid) {
    const key = String(mid);
    const existing = relationStateByMid.get(key);
    const isFresh = existing && Date.now() - existing.updatedAt < 60 * 1000;
    if (isFresh || isRelationRequestPending(key)) {
      return;
    }

    relationStateByMid.set(key, {
      status: "checking",
      updatedAt: Date.now(),
      attribute: 0
    });

    const requestId = `relation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pendingRelationRequests.set(requestId, key);

    window.dispatchEvent(
      new CustomEvent(RELATION_REQUEST_EVENT, {
        detail: {
          requestId,
          mid: key
        }
      })
    );
  }

  function isRelationRequestPending(mid) {
    for (const pendingMid of pendingRelationRequests.values()) {
      if (pendingMid === String(mid)) {
        return true;
      }
    }

    return false;
  }

  function findPreferredNodeInSameRoot(node) {
    const rootNode = node.getRootNode && node.getRootNode();
    if (!rootNode || !rootNode.querySelectorAll) {
      return null;
    }

    const nodeMid = extractMidFromElement(node);
    const candidates = Array.from(rootNode.querySelectorAll(PREFERRED_NAME_SELECTOR));

    if (!nodeMid) {
      return candidates[0] || null;
    }

    for (const candidate of candidates) {
      if (extractMidFromElement(candidate) === nodeMid) {
        return candidate;
      }
    }

    return null;
  }

  function cleanupExistingMarkers(scope, mid) {
    if (!scope || !scope.querySelectorAll || !mid) {
      return;
    }

    scope.querySelectorAll(`.bkb-inline[data-mid="${mid}"]`).forEach((marker) => marker.remove());
  }

  function getMarkerScope(anchor) {
    if (anchor.parentElement) {
      return anchor.parentElement;
    }

    const rootNode = anchor.getRootNode && anchor.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      return rootNode;
    }

    return findHideContainer(anchor) || document;
  }

  function findContainerAcrossBoundaries(element, selector) {
    return findAncestorAcrossBoundaries(element, (current) => current.matches && current.matches(selector));
  }

  function findAncestorAcrossBoundaries(element, predicate) {
    let current = element;

    while (current) {
      if (current instanceof Element && predicate(current)) {
        return current;
      }

      const parent = current.parentElement;
      if (parent) {
        current = parent;
        continue;
      }

      const rootNode = current.getRootNode && current.getRootNode();
      if (rootNode instanceof ShadowRoot) {
        current = rootNode.host;
        continue;
      }

      break;
    }

    return null;
  }

  function getIdentityText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    return [
      element.tagName,
      element.id,
      typeof element.className === "string" ? element.className : ""
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
  }

  function enqueueBlock(info) {
    const mid = String(info.mid);
    const relationState = relationStateByMid.get(mid);

    if (relationState && relationState.status === "blocked") {
      refreshButtons(mid);
      return;
    }

    if (queuedUserIds.has(mid)) {
      refreshButtons(mid);
      return;
    }

    queuedUserIds.add(mid);
    blockedQueue.push({
      ...info,
      mid
    });
    refreshButtons(mid);
    pumpQueue();
  }

  function pumpQueue() {
    if (queueBusy || !blockedQueue.length) {
      return;
    }

    const next = blockedQueue.shift();
    if (!next) {
      return;
    }

    queueBusy = true;

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pendingRequests.set(requestId, next);

    window.dispatchEvent(
      new CustomEvent(BLOCK_REQUEST_EVENT, {
        detail: {
          requestId,
          mid: next.mid,
          nickname: next.nickname
        }
      })
    );
  }

  async function saveProcessedUser(info, result) {
    const latest = await loadState();
    const status = result.code === 22003 ? "already_blocked" : result.ok ? "blocked" : "failed";
    const timestamp = new Date().toISOString();

    latest.processedUsers[String(info.mid)] = {
      nickname: info.nickname,
      keyword: info.matchedKeyword,
      status,
      code: result.code,
      message: result.message,
      source: info.source,
      updatedAt: timestamp
    };

    latest.recentActions.unshift({
      mid: String(info.mid),
      nickname: info.nickname,
      keyword: info.matchedKeyword,
      status,
      message: result.message,
      updatedAt: timestamp
    });

    state = mergeState(latest);
    await chrome.storage.local.set({
      [STORAGE_KEY]: state
    });
  }

  async function syncRecentActionWithRelation(mid, isBlocked) {
    const latest = await loadState();
    const current = latest.processedUsers[String(mid)];
    const timestamp = new Date().toISOString();

    if (!current) {
      return;
    }

    if (!isBlocked && (current.status === "blocked" || current.status === "already_blocked")) {
      latest.processedUsers[String(mid)] = {
        ...current,
        status: "unblocked",
        message: "已取消拉黑",
        updatedAt: timestamp
      };

      latest.recentActions.unshift({
        mid: String(mid),
        nickname: current.nickname || "未知用户",
        keyword: current.keyword || "",
        status: "unblocked",
        message: "已取消拉黑",
        updatedAt: timestamp
      });

      state = mergeState(latest);
      await chrome.storage.local.set({
        [STORAGE_KEY]: state
      });
      return;
    }

    if (isBlocked && current.status === "unblocked") {
      latest.processedUsers[String(mid)] = {
        ...current,
        status: "already_blocked",
        message: "当前在黑名单中",
        updatedAt: timestamp
      };

      latest.recentActions.unshift({
        mid: String(mid),
        nickname: current.nickname || "未知用户",
        keyword: current.keyword || "",
        status: "already_blocked",
        message: "当前在黑名单中",
        updatedAt: timestamp
      });

      state = mergeState(latest);
      await chrome.storage.local.set({
        [STORAGE_KEY]: state
      });
    }
  }
})();
