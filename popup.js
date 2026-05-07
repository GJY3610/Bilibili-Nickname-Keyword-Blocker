(function () {
  const shared = globalThis.BiliKeywordBlockerShared;
  if (!shared) {
    return;
  }

  const {
    STORAGE_KEY,
    mergeState,
    normalizeKeywords,
    formatTime
  } = shared;

  const elements = {
    enabled: document.getElementById("enabled"),
    commentsOnly: document.getElementById("commentsOnly"),
    autoBlock: document.getElementById("autoBlock"),
    debugEnabled: document.getElementById("debugEnabled"),
    hideMatched: document.getElementById("hideMatched"),
    caseSensitive: document.getElementById("caseSensitive"),
    keywords: document.getElementById("keywords"),
    keywordCount: document.getElementById("keywordCount"),
    recentList: document.getElementById("recentList"),
    saveButton: document.getElementById("saveButton"),
    clearHistory: document.getElementById("clearHistory"),
    statusText: document.getElementById("statusText")
  };

  let state = mergeState();

  init().catch((error) => {
    elements.statusText.textContent = error instanceof Error ? error.message : "载入失败";
  });

  async function init() {
    state = await loadState();
    render();
    bindEvents();
  }

  async function loadState() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return mergeState(stored[STORAGE_KEY]);
  }

  function bindEvents() {
    elements.saveButton.addEventListener("click", saveSettings);
    elements.clearHistory.addEventListener("click", clearHistory);
    elements.keywords.addEventListener("input", updateKeywordCount);
  }

  function render() {
    elements.enabled.checked = Boolean(state.enabled);
    elements.commentsOnly.checked = Boolean(state.commentsOnly);
    elements.autoBlock.checked = Boolean(state.autoBlock);
    elements.debugEnabled.checked = Boolean(state.debugEnabled);
    elements.hideMatched.checked = Boolean(state.hideMatched);
    elements.caseSensitive.checked = Boolean(state.caseSensitive);
    elements.keywords.value = state.keywords.join("\n");
    elements.statusText.textContent = "设置已载入";
    updateKeywordCount();
    renderRecentList();
  }

  function updateKeywordCount() {
    const count = normalizeKeywords(elements.keywords.value).length;
    elements.keywordCount.textContent = `${count} 个`;
  }

  function renderRecentList() {
    const recent = Array.isArray(state.recentActions) ? state.recentActions : [];
    elements.recentList.innerHTML = "";

    if (!recent.length) {
      const empty = document.createElement("li");
      empty.className = "recent-empty";
      empty.textContent = "还没有处理记录。";
      elements.recentList.appendChild(empty);
      return;
    }

    for (const item of recent) {
      const row = document.createElement("li");
      row.className = "recent-item";

      const title = document.createElement("strong");
      title.textContent = `${item.nickname || "未知用户"}`;

      const meta = document.createElement("div");
      meta.className = "recent-meta";
      meta.textContent = [
        item.mid ? `UID：${item.mid}` : "",
        `状态：${toStatusLabel(item.status)}`,
        item.keyword ? `关键词：${item.keyword}` : "",
        item.message ? `返回：${item.message}` : "",
        item.updatedAt ? formatTime(item.updatedAt) : ""
      ]
        .filter(Boolean)
        .join(" | ");

      row.appendChild(title);
      row.appendChild(meta);
      elements.recentList.appendChild(row);
    }
  }

  async function saveSettings() {
    state = mergeState({
      ...state,
      enabled: elements.enabled.checked,
      commentsOnly: elements.commentsOnly.checked,
      autoBlock: elements.autoBlock.checked,
      debugEnabled: elements.debugEnabled.checked,
      hideMatched: elements.hideMatched.checked,
      caseSensitive: elements.caseSensitive.checked,
      keywords: normalizeKeywords(elements.keywords.value)
    });

    await chrome.storage.local.set({
      [STORAGE_KEY]: state
    });

    elements.statusText.textContent = `已保存 ${state.keywords.length} 个关键词`;
    renderRecentList();
  }

  async function clearHistory() {
    state = mergeState({
      ...state,
      recentActions: [],
      processedUsers: {}
    });

    await chrome.storage.local.set({
      [STORAGE_KEY]: state
    });

    elements.statusText.textContent = "处理记录已清空";
    renderRecentList();
  }

  function toStatusLabel(status) {
    if (status === "blocked") {
      return "已拉黑";
    }

    if (status === "already_blocked") {
      return "原本已在黑名单";
    }

    if (status === "unblocked") {
      return "取消拉黑";
    }

    if (status === "failed") {
      return "拉黑失败";
    }

    return "未知";
  }
})();
