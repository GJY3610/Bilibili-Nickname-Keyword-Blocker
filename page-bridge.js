(function () {
  if (window.__BILI_KEYWORD_BLOCKER_PAGE_BRIDGE__) {
    return;
  }

  window.__BILI_KEYWORD_BLOCKER_PAGE_BRIDGE__ = true;

  const REQUEST_EVENT = "bili-keyword-blocker:block";
  const RESULT_EVENT = "bili-keyword-blocker:block-result";
  const RELATION_REQUEST_EVENT = "bili-keyword-blocker:relation-query";
  const RELATION_RESULT_EVENT = "bili-keyword-blocker:relation-query-result";
  const BLOCK_ENDPOINT = "https://api.bilibili.com/x/relation/modify";
  const RELATION_ENDPOINT = "https://api.bilibili.com/x/relation";

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function getRelationSource() {
    const host = location.hostname;
    const path = location.pathname || "";

    if (host === "space.bilibili.com") {
      return "11";
    }

    if (host === "www.bilibili.com" && path.startsWith("/video/")) {
      return "14";
    }

    if (host === "www.bilibili.com" && path.startsWith("/read/")) {
      return "115";
    }

    return "11";
  }

  async function blockUser(mid) {
    const csrf = getCsrfToken();
    if (!csrf) {
      throw new Error("未检测到 bili_jct，请先登录哔哩哔哩账号。");
    }

    const body = new URLSearchParams({
      fid: String(mid),
      act: "5",
      re_src: getRelationSource(),
      csrf
    });

    const response = await fetch(BLOCK_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*"
      },
      body: body.toString()
    });

    return response.json();
  }

  async function queryRelation(mid) {
    const url = new URL(RELATION_ENDPOINT);
    url.searchParams.set("fid", String(mid));

    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*"
      }
    });

    return response.json();
  }

  window.addEventListener(REQUEST_EVENT, async (event) => {
    const detail = event && event.detail ? event.detail : {};
    const requestId = detail.requestId || "";
    const mid = detail.mid || "";
    const nickname = detail.nickname || "";

    const result = {
      requestId,
      mid,
      nickname,
      ok: false,
      code: -1,
      message: "请求未执行"
    };

    try {
      const data = await blockUser(mid);
      result.code = Number(data && data.code);
      result.message = String((data && data.message) || "");
      result.ok = result.code === 0 || result.code === 22003;
    } catch (error) {
      result.message = error instanceof Error ? error.message : "拉黑请求失败";
    }

    window.dispatchEvent(
      new CustomEvent(RESULT_EVENT, {
        detail: result
      })
    );
  });

  window.addEventListener(RELATION_REQUEST_EVENT, async (event) => {
    const detail = event && event.detail ? event.detail : {};
    const requestId = detail.requestId || "";
    const mid = detail.mid || "";

    const result = {
      requestId,
      mid,
      ok: false,
      code: -1,
      message: "请求未执行",
      attribute: 0,
      isBlocked: false
    };

    try {
      const data = await queryRelation(mid);
      const attribute = Number(data && data.data && data.data.attribute);
      result.code = Number(data && data.code);
      result.message = String((data && data.message) || "");
      result.attribute = Number.isFinite(attribute) ? attribute : 0;
      result.isBlocked = (result.attribute & 128) === 128;
      result.ok = result.code === 0;
    } catch (error) {
      result.message = error instanceof Error ? error.message : "关系状态查询失败";
    }

    window.dispatchEvent(
      new CustomEvent(RELATION_RESULT_EVENT, {
        detail: result
      })
    );
  });
})();
