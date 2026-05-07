(function () {
  const STORAGE_KEY = "biliKeywordBlockerState";
  const MAX_RECENT_ACTIONS = 30;
  const MAX_PROCESSED_USERS = 500;

  const DEFAULT_STATE = {
    enabled: true,
    commentsOnly: true,
    autoBlock: false,
    debugEnabled: false,
    hideMatched: false,
    caseSensitive: false,
    keywords: [],
    recentActions: [],
    processedUsers: {}
  };

  function normalizeKeywords(input) {
    const list = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
    return Array.from(
      new Set(
        list
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )
    );
  }

  function pruneRecentActions(actions) {
    if (!Array.isArray(actions)) {
      return [];
    }

    return actions
      .filter((item) => item && typeof item === "object")
      .slice(0, MAX_RECENT_ACTIONS);
  }

  function pruneProcessedUsers(users) {
    if (!users || typeof users !== "object") {
      return {};
    }

    const entries = Object.entries(users)
      .filter(([mid, info]) => /^\d+$/.test(String(mid)) && info && typeof info === "object")
      .sort((a, b) => {
        const left = Date.parse(a[1].updatedAt || 0) || 0;
        const right = Date.parse(b[1].updatedAt || 0) || 0;
        return right - left;
      })
      .slice(0, MAX_PROCESSED_USERS);

    return Object.fromEntries(entries);
  }

  function mergeState(rawState) {
    const merged = {
      ...DEFAULT_STATE,
      ...(rawState || {})
    };

    merged.keywords = normalizeKeywords(merged.keywords);
    merged.recentActions = pruneRecentActions(merged.recentActions);
    merged.processedUsers = pruneProcessedUsers(merged.processedUsers);

    return merged;
  }

  function findMatchedKeyword(nickname, keywords, caseSensitive) {
    const candidate = String(nickname || "").trim();
    if (!candidate) {
      return null;
    }

    const source = caseSensitive ? candidate : candidate.toLocaleLowerCase();

    for (const keyword of normalizeKeywords(keywords)) {
      const normalized = caseSensitive ? keyword : keyword.toLocaleLowerCase();
      if (normalized && source.includes(normalized)) {
        return keyword;
      }
    }

    return null;
  }

  function extractMidFromUrl(input) {
    const raw = String(input || "");
    if (!raw) {
      return null;
    }

    try {
      const url = new URL(raw, location.origin);
      if (url.hostname === "space.bilibili.com") {
        const match = url.pathname.match(/^\/(\d+)(?:\/|$)/);
        return match ? match[1] : null;
      }

      if (url.hostname.endsWith(".bilibili.com")) {
        const mobileMatch = url.pathname.match(/^\/space\/(\d+)(?:\/|$)/);
        return mobileMatch ? mobileMatch[1] : null;
      }
    } catch (error) {
      const fallback = raw.match(/space\.bilibili\.com\/(\d+)/);
      if (fallback) {
        return fallback[1];
      }
    }

    return null;
  }

  function extractMidFromDataset(element) {
    if (!element || !(element instanceof Element) || !element.dataset) {
      return null;
    }

    const candidates = [
      element.dataset.userId,
      element.dataset.userProfileId,
      element.dataset.usercardMid,
      element.dataset.uid,
      element.dataset.mid
    ];

    for (const candidate of candidates) {
      const normalized = String(candidate || "").trim();
      if (/^\d+$/.test(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  function extractMidFromElement(element) {
    if (!element || !(element instanceof Element)) {
      return null;
    }

    const fromSelfDataset = extractMidFromDataset(element);
    if (fromSelfDataset) {
      return fromSelfDataset;
    }

    if (element instanceof HTMLAnchorElement) {
      const fromHref = extractMidFromUrl(element.href);
      if (fromHref) {
        return fromHref;
      }
    }

    const nestedAnchor = element.querySelector && element.querySelector('a[href*="space.bilibili.com"], a[href*="/space/"]');
    if (nestedAnchor instanceof HTMLAnchorElement) {
      const fromNestedAnchorDataset = extractMidFromDataset(nestedAnchor);
      if (fromNestedAnchorDataset) {
        return fromNestedAnchorDataset;
      }

      const fromNestedHref = extractMidFromUrl(nestedAnchor.href);
      if (fromNestedHref) {
        return fromNestedHref;
      }
    }

    const nestedDatasetNode =
      element.querySelector &&
      element.querySelector("[data-user-profile-id],[data-user-id],[data-usercard-mid],[data-uid],[data-mid]");

    if (nestedDatasetNode instanceof Element) {
      return extractMidFromDataset(nestedDatasetNode);
    }

    return null;
  }

  function getNicknameFromElement(element) {
    if (!element) {
      return "";
    }

    const pieces = [
      element.textContent,
      element.getAttribute && element.getAttribute("title"),
      element.getAttribute && element.getAttribute("aria-label")
    ];

    for (const piece of pieces) {
      const normalized = String(piece || "").replace(/\s+/g, " ").trim();
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  function formatTime(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleString("zh-CN", {
      hour12: false
    });
  }

  globalThis.BiliKeywordBlockerShared = {
    DEFAULT_STATE,
    STORAGE_KEY,
    mergeState,
    normalizeKeywords,
    findMatchedKeyword,
    extractMidFromUrl,
    extractMidFromElement,
    getNicknameFromElement,
    formatTime
  };
})();
