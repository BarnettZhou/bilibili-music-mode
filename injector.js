/* Bilibili Music Mode - 页面主世界注入器（document_start）
 * 仅音频（省流）：剔除播放地址里的视频流，只保留音频流。
 * 开关经 localStorage('bmm:audioOnly') 传递，由 content.js 在打开/关闭遮罩时设置。
 * 补丁成功后在 <html data-bmm-patched="1"> 上做标记，供 content script 读取。
 */
(() => {
  if (window.top !== window) return;
  const LS_AUDIO = 'bmm:audioOnly';
  const enabled = () => {
    try {
      return localStorage.getItem(LS_AUDIO) === '1';
    } catch (e) {
      return false;
    }
  };

  const mark = () => {
    try {
      document.documentElement.dataset.bmmPatched = '1';
    } catch (e) {}
  };

  // 只匹配 playurl API 的路径（CDN 分片 URL 的 query 里也可能带 playurl 字样，不能误伤）
  const isPlayUrlApi = (rawUrl) => {
    try {
      return /\/x\/player\/(?:wbi\/)?playurl/.test(new URL(String(rawUrl), location.origin).pathname);
    } catch (e) {
      return false;
    }
  };

  // 剔除 dash 视频流；返回是否真的改了
  const patch = (json) => {
    if (!enabled()) return false;
    try {
      const dash = json?.data?.dash || json?.result?.dash;
      if (dash && Array.isArray(dash.video) && dash.video.length) {
        dash.video = []; // dolby/flac 是音频相关字段，保持原样
        mark();
        return true;
      }
    } catch (e) {}
    return false;
  };

  // 1) 首屏 SSR 内联的 window.__playinfo__（inline script 在本脚本之后执行，用属性陷阱拦截）
  let stored;
  Object.defineProperty(window, '__playinfo__', {
    configurable: true,
    set(v) {
      patch(v);
      stored = v;
    },
    get() {
      return stored;
    },
  });

  // 2) 后续通过 fetch 请求的 playurl（切清晰度 / 合集切集等）
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(args[0]?.url || args[0] || '');
    if (!isPlayUrlApi(url)) return origFetch.apply(this, args);
    return origFetch.apply(this, args).then((res) => {
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) return res; // 只碰 JSON，二进制分片原样放行
      return res
        .clone()
        .json()
        .then((json) => {
          patch(json);
          return new Response(JSON.stringify(json), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        })
        .catch(() => res);
    });
  };

  // 3) 后续通过 XHR 请求的 playurl
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bmmPatch = isPlayUrlApi(url);
    return origOpen.call(this, method, url, ...rest);
  };
  const wrapResponse = (val, xhr) => {
    if (!xhr.__bmmPatch || !enabled()) return val;
    try {
      if (xhr.responseType === 'json') {
        if (val && typeof val === 'object') patch(val); // 原地改，引用不变
        return val;
      }
      if (typeof val !== 'string') return val; // arraybuffer/blob 等二进制原样返回
      const json = JSON.parse(val);
      return patch(json) ? JSON.stringify(json) : val;
    } catch (e) {
      return val;
    }
  };
  for (const prop of ['response', 'responseText']) {
    const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, prop);
    if (!desc?.get) continue;
    Object.defineProperty(XMLHttpRequest.prototype, prop, {
      configurable: true,
      get() {
        return wrapResponse(desc.get.call(this), this);
      },
    });
  }
})();
