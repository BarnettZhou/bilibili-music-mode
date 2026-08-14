/* Bilibili Music Mode - content script（隔离世界）
 * 全屏遮罩音乐播放器：
 *  - 播放列表：有合集取 .video-pod，否则取 .next-play（并把当前视频置为第 1 首）
 *  - 控制页面 <video>：播放/暂停/上一首/下一首/进度/音量，播放完自动下一首
 *  - 打开遮罩时按需开启“仅音频”并重载一次；关闭遮罩时若打过补丁则重载恢复视频
 */
(() => {
  if (window.top !== window || window.__bmmLoaded) return;
  window.__bmmLoaded = true;

  const LS_AUDIO = 'bmm:audioOnly'; // injector.js 读取：'1' 打补丁 / '0' 不打
  const LS_PREF = 'bmm:prefAudioOnly'; // 用户偏好，默认开
  const SS_REOPEN = 'bmm:reopen'; // 跨导航保持音乐模式
  const SS_TRIED = 'bmm:reopen:tried'; // 防止为打补丁反复重载

  let overlay = null;
  let playlist = [];
  let recs = [];
  let mainListTitle = '';
  let boundVideo = null;
  let urlWatcher = null;
  let lastBvid = null;

  const $ = (s, r = document) => r.querySelector(s);
  const getVideo = () => document.querySelector('video');
  const currentBvid = () => (location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] || null;
  const isPatched = () => document.documentElement.dataset.bmmPatched === '1';
  const prefAudioOnly = () => localStorage.getItem(LS_PREF) !== '0';

  const fmt = (sec) => {
    if (!isFinite(sec)) return '--:--';
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
  };

  const absUrl = (href) => {
    try {
      const u = new URL(href, location.origin);
      return u.origin + u.pathname;
    } catch {
      return null;
    }
  };
  const fixProto = (src) => {
    if (!src || src.startsWith('data:')) return null;
    if (src.startsWith('//')) return 'https:' + src;
    return src.startsWith('http') ? src : null;
  };
  const bvidOf = (url) => (String(url).match(/BV[0-9A-Za-z]+/) || [''])[0];

  function currentVideoItem() {
    const title = (
      $('h1.video-title')?.getAttribute('title') ||
      $('h1.video-title')?.textContent ||
      document.title.replace(/_哔哩哔哩_bilibili\s*$/, '')
    ).trim();
    const up = ($('.up-name')?.textContent || '').trim();
    const cover = fixProto(document.querySelector('meta[property="og:image"]')?.content);
    return { title, up, cover, url: location.origin + location.pathname, bvid: currentBvid(), duration: '' };
  }

  // 解析 .video-page-card-small 卡片（接下来播放 / 推荐列表共用同一结构）
  function parseCard(card) {
    const a = card.querySelector('.info a[href*="/video/"]') || card.querySelector('a[href*="/video/"]');
    const url = a ? absUrl(a.getAttribute('href')) : null;
    if (!url) return null;
    return {
      url,
      bvid: bvidOf(url),
      title: (card.querySelector('.info .title')?.getAttribute('title') || card.querySelector('.info .title')?.textContent || '').trim(),
      up: (card.querySelector('.upname')?.textContent || '').trim(),
      cover: fixProto(card.querySelector('.pic img')?.src),
      duration: (card.querySelector('.duration')?.textContent || '').trim(),
    };
  }

  function extractCards(container, excludeUrls) {
    const seen = new Set(excludeUrls || []);
    return [...container.querySelectorAll('.video-page-card-small')]
      .map(parseCard)
      .filter((it) => it && it.title && !seen.has(it.url) && seen.add(it.url));
  }

  function extractPlaylist() {
    // 1) 合集 / 分 P 列表
    const pod = $('.video-pod');
    if (pod && pod.querySelector('.video-pod__item')) {
      const items = [...pod.querySelectorAll('.video-pod__item')]
        .map((el) => {
          const bvid = el.dataset.key || '';
          if (!bvid) return null;
          return {
            bvid,
            title: (el.querySelector('.title')?.getAttribute('title') || el.querySelector('.title-txt')?.textContent || bvid).trim(),
            duration: (el.querySelector('.duration')?.textContent || '').trim(),
            url: `${location.origin}/video/${bvid}/`,
            up: '',
            cover: null,
          };
        })
        .filter(Boolean);
      if (items.length) {
        const name = (pod.querySelector('.video-pod__header .title')?.textContent || '合集').trim();
        const amt = (pod.querySelector('.video-pod__header .amt')?.textContent || '').trim();
        return { title: `合集 · ${name}${amt}`, items };
      }
    }
    // 2) 接下来播放，当前视频作为第 1 首
    const np = $('.next-play');
    if (np) {
      return { title: '接下来播放', items: [currentVideoItem(), ...extractCards(np)] };
    }
    // 3) 兜底：只有当前视频
    return { title: '正在播放', items: [currentVideoItem()] };
  }

  // 右侧 .rec-list 相关推荐，单独作为一个列表，剔除与主播放列表重复的
  function extractRecs(mainItems) {
    const rec = $('.rec-list');
    if (!rec) return [];
    return extractCards(rec, mainItems.map((it) => it.url));
  }

  // ---------- UI ----------

  function buildOverlay() {
    const root = document.createElement('div');
    root.className = 'bmm-overlay';
    root.innerHTML = `
      <div class="bmm-header">
        <div class="bmm-brand">♪ 音乐模式 <span class="bmm-brand-sub">bilibili</span></div>
        <label class="bmm-ao" title="剔除视频流，只加载音频（切换会刷新页面）">
          <input type="checkbox" class="bmm-ao-box"> 仅音频 · 省流
        </label>
        <button class="bmm-close" title="关闭 (Esc)">✕</button>
      </div>
      <div class="bmm-main">
        <div class="bmm-now">
          <div class="bmm-cover">
            <img class="bmm-cover-img" alt="">
            <div class="bmm-cover-fallback">♪</div>
          </div>
          <div class="bmm-track-title"></div>
          <div class="bmm-track-up"></div>
          <div class="bmm-progress">
            <span class="bmm-time bmm-time-cur">0:00</span>
            <input type="range" class="bmm-seek" min="0" max="1000" value="0">
            <span class="bmm-time bmm-time-dur">0:00</span>
          </div>
          <div class="bmm-controls">
            <button class="bmm-btn bmm-prev" title="上一首">⏮</button>
            <button class="bmm-btn bmm-play" title="播放/暂停（空格）">▶</button>
            <button class="bmm-btn bmm-next" title="下一首">⏭</button>
          </div>
        </div>
        <div class="bmm-side"></div>
      </div>`;
    return root;
  }

  function currentIndex() {
    const b = currentBvid();
    const i = playlist.findIndex((it) => it.bvid && it.bvid === b);
    return i >= 0 ? i : 0;
  }

  function renderList() {
    const side = $('.bmm-side', overlay);
    side.innerHTML = '';
    const cur = currentBvid();

    const addSection = (title, items, isMain) => {
      const sec = document.createElement('div');
      sec.className = 'bmm-section';
      sec.dataset.kind = isMain ? 'main' : 'rec';
      const head = document.createElement('div');
      head.className = 'bmm-section-title';
      head.textContent = `${title}（${items.length} 首）`;
      const body = document.createElement('div');
      body.className = 'bmm-items';
      items.forEach((it, i) => {
        const isCur = isMain && it.bvid && it.bvid === cur;
        const row = document.createElement('div');
        row.className = 'bmm-item' + (isCur ? ' bmm-item-current' : '');
        const coverHtml = it.cover ? `<img class="bmm-item-cover" src="${it.cover}" alt="">` : '';
        row.innerHTML = `
          <span class="bmm-item-idx">${isCur ? '▶' : i + 1}</span>
          ${coverHtml}
          <div class="bmm-item-info">
            <div class="bmm-item-title"></div>
            <div class="bmm-item-up"></div>
          </div>
          <span class="bmm-item-dur"></span>`;
        row.querySelector('.bmm-item-title').textContent = it.title;
        row.querySelector('.bmm-item-up').textContent = it.up || '';
        row.querySelector('.bmm-item-dur').textContent = it.duration || '';
        row.addEventListener('click', () => navigateTo(it));
        body.appendChild(row);
      });
      sec.appendChild(head);
      sec.appendChild(body);
      side.appendChild(sec);
    };

    addSection(mainListTitle, playlist, true);
    if (recs.length) addSection('推荐列表', recs, false);
    const curEl = side.querySelector('.bmm-item-current');
    if (curEl) curEl.scrollIntoView({ block: 'center' });
  }

  function refresh() {
    if (!overlay) return;
    const data = extractPlaylist();
    playlist = data.items;
    mainListTitle = data.title;
    recs = extractRecs(playlist);
    const cur = currentVideoItem();
    const now = playlist[currentIndex()] || cur;
    $('.bmm-track-title', overlay).textContent = cur.title || now.title;
    $('.bmm-track-up', overlay).textContent = cur.up || now.up || '';
    const img = $('.bmm-cover-img', overlay);
    const fallback = $('.bmm-cover-fallback', overlay);
    const cover = cur.cover || now.cover;
    if (cover) {
      img.src = cover;
      img.style.display = '';
      fallback.style.display = 'none';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      fallback.style.display = '';
    }
    renderList();
    bindVideo();
  }

  // ---------- 播放控制 ----------

  const togglePlay = () => {
    const v = getVideo();
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const seekBy = (delta) => {
    const v = getVideo();
    if (v && isFinite(v.duration)) v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration);
  };
  const navigateTo = (it) => {
    if (!it?.url) return;
    if (it.bvid && it.bvid === currentBvid()) {
      const v = getVideo();
      if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
      return;
    }
    // 合集条目：B 站有 SPA 切集，点内层元素触发（监听挂在 .simple-base-item 上），不刷新页面
    if (it.bvid) {
      const podItem = document.querySelector(`.video-pod__item[data-key="${it.bvid}"]`);
      if (podItem) {
        const from = currentBvid();
        (podItem.querySelector('.simple-base-item') || podItem).click();
        // 点了但没切过去（例如页面结构变更）时，2.5s 后兜底整页跳转
        setTimeout(() => {
          if (overlay && currentBvid() === from) location.assign(it.url);
        }, 2500);
        return;
      }
    }
    // 推荐列表 / 接下来播放：B 站对这两类是整页跳转（点链接只会被路由改 URL、内容不切），
    // 直接 location.assign；pagehide 时会记下 reopen，新页面自动重开遮罩
    location.assign(it.url);
  };
  const playNext = () => {
    const next = playlist[currentIndex() + 1];
    if (next) navigateTo(next);
  };
  const playPrev = () => {
    const prev = playlist[currentIndex() - 1];
    if (prev) navigateTo(prev);
  };

  function updatePlayBtn() {
    if (!overlay) return;
    const v = getVideo();
    $('.bmm-play', overlay).textContent = v && !v.paused ? '⏸' : '▶';
  }
  function updateProgress() {
    if (!overlay) return;
    const v = getVideo();
    if (!v) return;
    $('.bmm-time-cur', overlay).textContent = fmt(v.currentTime);
    $('.bmm-time-dur', overlay).textContent = fmt(v.duration);
    const seek = $('.bmm-seek', overlay);
    if (isFinite(v.duration) && v.duration > 0 && document.activeElement !== seek) {
      seek.value = Math.round((v.currentTime / v.duration) * 1000);
    }
  }
  const onEnded = () => playNext();

  function bindVideo() {
    const v = getVideo();
    if (v === boundVideo) return;
    unbindVideo();
    boundVideo = v;
    if (!v) return;
    v.addEventListener('timeupdate', updateProgress);
    v.addEventListener('loadedmetadata', updateProgress);
    v.addEventListener('play', updatePlayBtn);
    v.addEventListener('pause', updatePlayBtn);
    v.addEventListener('ended', onEnded);
    updatePlayBtn();
    updateProgress();
  }
  function unbindVideo() {
    if (!boundVideo) return;
    boundVideo.removeEventListener('timeupdate', updateProgress);
    boundVideo.removeEventListener('loadedmetadata', updateProgress);
    boundVideo.removeEventListener('play', updatePlayBtn);
    boundVideo.removeEventListener('pause', updatePlayBtn);
    boundVideo.removeEventListener('ended', onEnded);
    boundVideo = null;
  }

  function wireControls() {
    $('.bmm-close', overlay).addEventListener('click', close);
    $('.bmm-play', overlay).addEventListener('click', togglePlay);
    $('.bmm-prev', overlay).addEventListener('click', playPrev);
    $('.bmm-next', overlay).addEventListener('click', playNext);
    $('.bmm-seek', overlay).addEventListener('input', (e) => {
      const v = getVideo();
      if (v && isFinite(v.duration) && v.duration > 0) {
        v.currentTime = (Number(e.target.value) / 1000) * v.duration;
        updateProgress();
      }
    });
    $('.bmm-ao-box', overlay).addEventListener('change', (e) => {
      const on = e.target.checked;
      localStorage.setItem(LS_PREF, on ? '1' : '0');
      localStorage.setItem(LS_AUDIO, on ? '1' : '0');
      if (on !== isPatched()) {
        sessionStorage.setItem(SS_REOPEN, '1');
        location.reload();
      }
    });
  }

  // SPA 内切换视频（无整页加载）时重建播放列表
  function startUrlWatcher() {
    lastBvid = currentBvid();
    let lastTrackTitle = '';
    urlWatcher = setInterval(() => {
      const b = currentBvid();
      if (b !== lastBvid) {
        lastBvid = b;
        refresh();
        const v = getVideo();
        if (v && v.paused) v.play().catch(() => {});
      } else {
        bindVideo(); // video 元素可能被替换
        // B 站路由先改 URL，h1/列表 DOM 可能延迟数百毫秒才更新
        const t = $('h1.video-title')?.getAttribute('title') || '';
        if (t && t !== lastTrackTitle) refresh();
      }
      lastTrackTitle = $('h1.video-title')?.getAttribute('title') || lastTrackTitle;
    }, 800);
  }
  function stopUrlWatcher() {
    if (urlWatcher) clearInterval(urlWatcher);
    urlWatcher = null;
  }

  // ---------- 开关 ----------

  function open() {
    if (overlay) return;
    if (prefAudioOnly()) {
      localStorage.setItem(LS_AUDIO, '1');
      if (!isPatched() && !sessionStorage.getItem(SS_TRIED)) {
        // 本页视频流还没被剔除，重载一次让 injector 在 document_start 打补丁
        sessionStorage.setItem(SS_REOPEN, '1');
        sessionStorage.setItem(SS_TRIED, '1');
        location.reload();
        return;
      }
    }
    overlay = buildOverlay();
    document.body.appendChild(overlay);
    document.documentElement.classList.add('bmm-open');
    wireControls();
    $('.bmm-ao-box', overlay).checked = prefAudioOnly();
    refresh();
    startUrlWatcher();
    const v = getVideo();
    if (v && v.paused) v.play().catch(() => {});
  }

  function close() {
    if (!overlay) return;
    stopUrlWatcher();
    unbindVideo();
    overlay.remove();
    overlay = null;
    document.documentElement.classList.remove('bmm-open');
    sessionStorage.removeItem(SS_REOPEN);
    sessionStorage.removeItem(SS_TRIED);
    localStorage.setItem(LS_AUDIO, '0');
    if (isPatched()) location.reload(); // 恢复视频流
  }

  const toggle = () => (overlay ? close() : open());

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'bmm:toggle') toggle();
    else if (msg?.type === 'bmm:query') sendResponse({ open: !!overlay });
    else if (msg?.type === 'bmm:set') (msg.open ? open() : close());
  });
  // 页面侧事件入口（便于自动化测试 / 其他脚本触发）
  window.addEventListener('bmm:toggle', toggle);

  // 遮罩打开状态下离开页面（点列表项、B 站自动连播等）-> 新页面自动重开
  window.addEventListener('pagehide', () => {
    if (overlay) sessionStorage.setItem(SS_REOPEN, '1');
  });

  document.addEventListener('keydown', (e) => {
    if (!overlay) return;
    if (e.key === 'Escape') close();
    else if (e.key === ' ' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight') seekBy(5);
    else if (e.key === 'ArrowLeft') seekBy(-5);
  });

  // 因 reopen 标记进入的新页面：等内容就绪后自动打开遮罩
  if (sessionStorage.getItem(SS_REOPEN) === '1') {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const ready = getVideo() && ($('.next-play') || $('.video-pod'));
      if (ready || tries > 20) {
        clearInterval(timer);
        open();
      }
    }, 500);
  }
})();
