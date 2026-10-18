/* global Fmp4Mux */
/**
 * B站视频下载器 — 播放器内嵌下载面板
 *
 * 取流思路：
 *   DASH 接口拿到音视频分离的 fMP4，两者在 CDN 上都有正确的 CORS 头，
 *   且页面上下文里的 fetch 会自动携带 B 站 Referer（CDN 校验的就是它），
 *   因此无需任何后台脚本即可直接流式抓取，再用 fmp4-mux 合并成单文件。
 *
 * 落盘策略：
 *   优先 File System Access API（边下边写，内存占用恒定）；
 *   不支持或无用户手势时退回 Blob + 浏览器下载。
 */
(function () {
  'use strict';

  if (window.__bdDownloaderLoaded) return;
  window.__bdDownloaderLoaded = true;

  var API = 'https://api.bilibili.com';

  var QN_NAME = {
    127: '8K 超高清', 126: '杜比视界', 125: 'HDR 真彩', 120: '4K 超清',
    116: '1080P60', 112: '1080P+', 80: '1080P', 74: '720P60',
    64: '720P', 32: '480P', 16: '360P', 6: '240P', 5: '144P',
  };

  var CODEC_NAME = { 7: 'AVC', 12: 'HEVC', 13: 'AV1' };
  var CODEC_ORDER = [7, 13, 12]; // 可播放性优先：AVC > AV1 > HEVC

  var state = {
    ctx: null,
    dash: null,
    durl: null,
    quality: null,
    codec: null,
    mode: 'merge', // merge | single | audio
    parts: new Set(),
    busy: false,
    ctrl: null,
    written: 0,
    total: 0,
    startedAt: 0,
    lastAt: 0,
    lastBytes: 0,
    speed: 0,
    stage: '',
    preferCodec: 'auto',
    loadToken: 0,
  };

  /* ------------------------------------------------------------- DOM 工具 */

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M12 3.6v10.2m0 0 3.7-3.7M12 13.8 8.3 10.1M4.9 15.4v3.2c0 .9.7 1.5 1.5 1.5h11.2c.8 0 1.5-.6 1.5-1.5v-3.2');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.7');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  var root = h('div', 'bd-root');
  var tab = h('button', 'bd-tab');
  tab.type = 'button';
  tab.title = '下载此视频';
  tab.appendChild(icon());
  var tabPct = h('span', 'bd-tab-pct', '');
  tab.appendChild(tabPct);

  var panel = h('div', 'bd-panel');
  var headTitle = h('div', 'bd-title', '正在读取视频信息…');
  var head = h('div', 'bd-head');
  var closeBtn = h('button', 'bd-x', '×');
  closeBtn.type = 'button';
  closeBtn.title = '收起';
  head.appendChild(headTitle);
  head.appendChild(closeBtn);

  var body = h('div', 'bd-body');
  var foot = h('div', 'bd-foot');
  var progressWrap = h('div', 'bd-progress');
  var bar = h('div', 'bd-bar');
  progressWrap.appendChild(bar);
  var stats = h('div', 'bd-stats');
  var msgEl = h('div', 'bd-msg', '');
  stats.appendChild(msgEl);
  var goBtn = h('button', 'bd-go', '开始下载');
  goBtn.type = 'button';
  foot.appendChild(progressWrap);
  foot.appendChild(stats);
  foot.appendChild(goBtn);

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(foot);
  root.appendChild(tab);
  root.appendChild(panel);

  /* --------------------------------------------------------------- 基础工具 */

  function api(path, params) {
    var url = new URL(API + path);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== '') url.searchParams.set(k, params[k]);
    });
    return fetchTimeout(url.toString(), { credentials: 'include' }, 12000).then(function (r) {
      if (!r.ok) throw new Error('接口返回 HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.code !== 0) throw new Error(j.message || ('接口错误 ' + j.code));
      return j.data || j.result || {};
    });
  }

  /**
   * 带超时的 fetch（超时只作用于等待响应头阶段，响应体由 watchdogStream 托管）
   * 外部的取消信号会一并传导下去。
   */
  function fetchTimeout(url, opts, ms) {
    var ctrl = new AbortController();
    var outer = opts && opts.signal;
    function onAbort() { ctrl.abort(); }
    if (outer) {
      if (outer.aborted) ctrl.abort();
      else outer.addEventListener('abort', onAbort, { once: true });
    }
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    function cleanup() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
    var o = Object.assign({}, opts, { signal: ctrl.signal });
    return fetch(url, o).then(function (r) {
      cleanup();
      return r;
    }, function (e) {
      cleanup();
      if (outer && outer.aborted) throw new DOMException('已取消', 'AbortError');
      if (e && e.name === 'AbortError') throw new Error('连接超时');
      throw e;
    });
  }

  function safeName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90) || 'video';
  }

  function fmtSize(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m >= 60) return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function trace() {
    try {
      var s = Array.prototype.slice.call(arguments).join(' ');
      window.__bdTrace = window.__bdTrace || [];
      window.__bdTrace.push(s);
      if (window.__bdTrace.length > 300) window.__bdTrace.shift();
    } catch (e) {}
  }

  function setMsg(text, kind) {
    msgEl.textContent = text || '';
    stats.classList.toggle('is-err', kind === 'err');
    stats.classList.toggle('is-ok', kind === 'ok');
  }

  /* ------------------------------------------------------------ 解析页面上下文 */

  function parseLocation() {
    var u = new URL(location.href);
    var m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (m) {
      var id = m[1];
      return {
        kind: 'video',
        bvid: /^av/i.test(id) ? null : id,
        aid: /^av/i.test(id) ? id.slice(2) : null,
        page: parseInt(u.searchParams.get('p') || '1', 10) || 1,
      };
    }
    var b = u.pathname.match(/\/bangumi\/play\/(ep|ss)(\d+)/i);
    if (b) return { kind: 'bangumi', type: b[1], id: b[2], page: 1 };
    return null;
  }

  async function loadContext() {
    var loc = parseLocation();
    if (!loc) throw new Error('当前页面不是视频页');

    if (loc.kind === 'video') {
      var view = await api('/x/web-interface/view', loc.bvid ? { bvid: loc.bvid } : { aid: loc.aid });
      var pages = (view.pages && view.pages.length ? view.pages : [{ cid: view.cid, page: 1, part: view.title, duration: view.duration }]);
      var parts = pages.map(function (p, i) {
        return {
          index: i + 1,
          label: pages.length > 1 ? 'P' + p.page + ' ' + (p.part || '') : (p.part || view.title),
          cid: p.cid,
          bvid: view.bvid,
          duration: p.duration || 0,
        };
      });
      return {
        kind: 'video',
        title: view.title,
        bvid: view.bvid,
        parts: parts,
        current: Math.min(Math.max(loc.page, 1), parts.length),
      };
    }

    // 番剧 / 影视
    var season = await api('/pgc/view/web/season', loc.type === 'ep' ? { ep_id: loc.id } : { season_id: loc.id });
    var eps = season.episodes || [];
    if (!eps.length) throw new Error('未获取到剧集列表');
    var parts2 = eps.map(function (e, i) {
      return {
        index: i + 1,
        label: (e.title || '第' + (i + 1) + '话') + (e.long_title ? ' ' + e.long_title : ''),
        cid: e.cid,
        bvid: e.bvid,
        epId: e.id,
        duration: e.duration ? Math.round(e.duration / 1000) : 0,
      };
    });
    var cur = loc.type === 'ep' ? Math.max(1, parts2.findIndex(function (p) { return String(p.epId) === String(loc.id); }) + 1) : 1;
    return {
      kind: 'bangumi',
      title: (season.season_title || '') + ' ' + (parts2[cur - 1] || {}).label,
      parts: parts2,
      current: cur,
    };
  }

  async function loadStreams() {
    var part = state.ctx.parts[state.ctx.current - 1];
    var base = { cid: part.cid, fourk: 1, qn: 127, platform: 'pc' };
    if (part.bvid) base.bvid = part.bvid;
    if (part.epId) base.ep_id = part.epId;

    var dashP = api('/x/player/playurl', Object.assign({ fnval: 4048 }, base)).catch(function (e) {
      if (state.ctx.kind !== 'bangumi') throw e;
      return api('/pgc/player/web/playurl', Object.assign({ fnval: 4048 }, base));
    });

    var durlP = api('/x/player/playurl', Object.assign({ fnval: 1 }, base)).catch(function () { return null; });

    var res = await Promise.all([dashP, durlP]);
    state.dash = res[0] || null;
    state.durl = res[1] || null;
    pickDefaults();
  }

  function dashGroups() {
    var dash = state.dash && state.dash.dash;
    if (!dash || !dash.video) return [];
    var map = new Map();
    dash.video.forEach(function (v) {
      if (!map.has(v.id)) map.set(v.id, []);
      map.get(v.id).push(v);
    });
    return Array.from(map.entries())
      .sort(function (a, b) { return b[0] - a[0]; })
      .map(function (e) {
        return {
          qn: e[0],
          streams: e[1].slice().sort(function (x, y) { return y.bandwidth - x.bandwidth; }),
        };
      });
  }

  function codecsAt(qn) {
    var g = dashGroups().find(function (x) { return x.qn === qn; });
    if (!g) return [];
    var set = [];
    g.streams.forEach(function (s) {
      if (set.indexOf(s.codecid) < 0) set.push(s.codecid);
    });
    return set.sort(function (a, b) {
      return CODEC_ORDER.indexOf(a) - CODEC_ORDER.indexOf(b);
    });
  }

  function pickDefaults() {
    var groups = dashGroups();
    if (groups.length) {
      if (!groups.some(function (g) { return g.qn === state.quality; })) state.quality = groups[0].qn;

      // 尊重设置里的编码偏好，否则挑可播放性最好的
      var pref = state.preferCodec;
      var avail = codecsAt(state.quality);
      var want = pref !== 'auto' ? parseInt(pref, 10) : -1;
      if (want > 0 && avail.indexOf(want) >= 0) state.codec = want;
      else if (avail.indexOf(state.codec) < 0) state.codec = avail[0];
    }
  }

  function pickAudio(dash) {
    var list = (dash.audio || []).slice().sort(function (a, b) { return b.bandwidth - a.bandwidth; });
    return list[0] || null;
  }

  function pickVideo(qn, codecid) {
    var g = dashGroups().find(function (x) { return x.qn === qn; });
    if (!g) return null;
    var hit = g.streams.find(function (s) { return s.codecid === codecid; });
    return hit || g.streams[0];
  }

  /* ------------------------------------------------------------------ 渲染 */

  function renderParts() {
    var ctx = state.ctx;
    if (!ctx || ctx.parts.length <= 1) return null;

    var wrap = h('div');
    var bar2 = h('div', 'bd-partbar');
    var count = h('span', null, '已选 ' + state.parts.size + ' / ' + ctx.parts.length);
    var all = h('button', null, '全选');
    var none = h('button', null, '清空');
    bar2.appendChild(count);
    bar2.appendChild(all);
    bar2.appendChild(none);
    wrap.appendChild(bar2);

    var list = h('div', 'bd-parts');
    ctx.parts.forEach(function (p, i) {
      var row = h('label', 'bd-part');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.parts.has(i);
      cb.onchange = function () {
        if (cb.checked) state.parts.add(i);
        else state.parts.delete(i);
        count.textContent = '已选 ' + state.parts.size + ' / ' + ctx.parts.length;
        renderFoot();
      };
      var span = h('span', null, p.label || ('第 ' + (i + 1) + ' 集'));
      var em = h('em', null, fmtDur(p.duration));
      row.appendChild(cb);
      row.appendChild(span);
      row.appendChild(em);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    all.onclick = function () {
      ctx.parts.forEach(function (_, i) { state.parts.add(i); });
      renderBody();
    };
    none.onclick = function () {
      state.parts.clear();
      renderBody();
    };
    return wrap;
  }

  function seg(options, current, onPick) {
    var box = h('div', 'bd-seg');
    options.forEach(function (o) {
      var b = h('button', null, o.label);
      b.type = 'button';
      b.disabled = !!o.disabled;
      b.setAttribute('aria-pressed', String(o.value === current));
      if (o.title) b.title = o.title;
      b.onclick = function () { onPick(o.value); };
      box.appendChild(b);
    });
    return box;
  }

  function renderQuality() {
    var row = h('div', 'bd-row');
    row.appendChild(h('div', 'bd-label', '画质'));
    var sel = document.createElement('select');
    sel.className = 'bd-select';

    if (state.mode === 'single') {
      var q = state.durl && state.durl.quality;
      var o = document.createElement('option');
      o.textContent = (QN_NAME[q] || (q ? q + 'P' : '单文件')) + '（单文件，画质受接口限制）';
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      var groups = dashGroups();
      if (!groups.length) {
        var e = document.createElement('option');
        e.textContent = '没有可用的视频流';
        sel.appendChild(e);
        sel.disabled = true;
      }
      groups.forEach(function (g) {
        var st = g.streams[0];
        var opt = document.createElement('option');
        opt.value = String(g.qn);
        opt.textContent = (QN_NAME[g.qn] || g.qn + 'P') + '  ' + st.width + '×' + st.height;
        if (g.qn === state.quality) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = function () {
        state.quality = parseInt(sel.value, 10);
        state.codec = codecsAt(state.quality)[0];
        renderBody();
      };
    }
    row.appendChild(sel);
    return row;
  }

  function renderCodec() {
    var avail = codecsAt(state.quality);
    if (!avail.length) return null;
    var row = h('div', 'bd-row');
    row.appendChild(h('div', 'bd-label', '编码'));
    var options = avail.map(function (c) {
      return {
        value: c,
        label: CODEC_NAME[c] || String(c),
        title: c === 7 ? 'H.264，兼容性最好' : c === 12 ? 'H.265，体积小，Win 需装 HEVC 扩展' : 'AV1，体积最小',
      };
    });
    row.appendChild(seg(options, state.codec, function (v) {
      state.codec = v;
      renderBody();
    }));
    return row;
  }

  function renderMode() {
    var row = h('div', 'bd-row');
    row.appendChild(h('div', 'bd-label', '内容'));
    var options = [
      { value: 'merge', label: '音视频合并' },
      { value: 'single', label: '单文件' },
      { value: 'audio', label: '仅音频' },
    ];
    row.appendChild(seg(options, state.mode, function (v) {
      if (v === state.mode) return;
      state.mode = v;
      renderBody();
    }));
    return row;
  }

  function renderBody() {
    body.textContent = '';
    if (!state.ctx) {
      body.appendChild(h('div', 'bd-hint', '未识别到视频，请打开一个视频播放页。'));
      renderFoot();
      return;
    }

    var partsEl = renderParts();
    if (partsEl) body.appendChild(partsEl);

    body.appendChild(renderQuality());
    if (state.mode === 'merge') {
      var c = renderCodec();
      if (c) body.appendChild(c);
    }
    body.appendChild(renderMode());

    if (state.mode === 'merge' && state.codec === 12) {
      body.appendChild(h('div', 'bd-hint', '提示：HEVC 在 Windows 上需安装「HEVC 视频扩展」才能播放，不确定就选 AVC。'));
    }
    if (state.mode === 'single') {
      body.appendChild(h('div', 'bd-hint', '单文件为 B 站直出的 MP4，无需合并，可直接播放；画质上限通常为 720P。'));
    }

    renderFoot();
  }

  function renderFoot() {
    if (state.busy) return;
    var n = state.parts.size || 1;
    goBtn.disabled = !state.ctx;
    goBtn.textContent = n > 1 ? '下载 ' + n + ' 个' : '开始下载';
    goBtn.classList.remove('is-cancel');
    headTitle.textContent = state.ctx ? state.ctx.title : '正在读取视频信息…';
  }

  function setBusy(on) {
    state.busy = on;
    root.classList.toggle('is-busy', on);
    if (on) {
      goBtn.textContent = '取消';
      goBtn.classList.add('is-cancel');
      goBtn.disabled = false;
      bar.classList.remove('bd-indet');
    } else {
      goBtn.classList.remove('is-cancel');
      bar.classList.remove('bd-indet');
      bar.style.width = '0%';
      tabPct.textContent = '';
      renderFoot();
    }
  }

  /* ------------------------------------------------------------- 进度显示 */

  var lastPaint = 0;

  function paintProgress(force) {
    var now = performance.now();
    if (!force && now - lastPaint < 110) return;
    lastPaint = now;

    var pct = state.total ? Math.min(1, state.written / state.total) : 0;
    if (state.total) bar.style.width = (pct * 100).toFixed(1) + '%';
    tabPct.textContent = state.total ? Math.round(pct * 100) + '%' : '';

    var elapsed = (now - state.startedAt) / 1000;
    var inst = elapsed > 0.4 ? state.written / elapsed : 0;
    state.speed = state.speed ? state.speed * 0.75 + inst * 0.25 : inst;

    var pieces = [];
    if (state.stage) pieces.push(state.stage);
    if (state.total) {
      pieces.push(Math.round(pct * 100) + '%');
      pieces.push(fmtSize(state.written) + ' / ' + fmtSize(state.total));
    } else {
      pieces.push(fmtSize(state.written));
    }
    if (state.speed > 0) pieces.push(fmtSize(state.speed) + '/s');
    if (state.total && state.speed > 0 && state.written < state.total) {
      var left = (state.total - state.written) / state.speed;
      pieces.push(left > 1 ? '剩 ' + fmtDur(left) : '即将完成');
    }
    setMsg(pieces.join('  ·  '));
  }

  function resetProgress() {
    state.written = 0;
    state.total = 0;
    state.startedAt = performance.now();
    state.speed = 0;
    bar.style.width = '0%';
    bar.classList.add('bd-indet');
  }

  /* --------------------------------------------------------------- 下载核心 */

  /**
   * 带备用源的取流。
   * B 站 CDN 会轮换到 mcdn 系列镜像，偶发直接拒绝或长时间不给数据，
   * 所以主地址失败时依次尝试 backupUrl 里的备选节点。
   * 注意：CDN 只校验 Referer（浏览器自动带上），响应头是 ACAO:*，
   * 因此必须 omit 凭证，否则带凭证的跨域请求不接受通配符源。
   */
  async function fetchWithFallback(urls, signal) {
    var lastErr = null;
    for (var i = 0; i < urls.length; i++) {
      if (!urls[i]) continue;
      try {
        var res = await fetchTimeout(urls[i], { credentials: 'omit', signal: signal }, 15000);
        if (!res.ok) {
          lastErr = new Error('HTTP ' + res.status);
          continue;
        }
        trace('fetch ok', i, urls[i].split('/')[2]);
        return res;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = e;
        trace('fetch fail', i, urls[i].split('/')[2], e && e.message);
      }
    }
    throw lastErr || new Error('视频流请求失败');
  }

  /** 给响应体加看门狗：长时间收不到数据就报错，避免进度条永远停在 0% */
  function watchdogStream(stream, ms) {
    if (!stream) return stream;
    var reader = stream.getReader();
    return new ReadableStream({
      async pull(controller) {
        var timer;
        var stall = new Promise(function (_, reject) {
          timer = setTimeout(function () { reject(new Error('数据流超时')); }, ms);
        });
        try {
          var r = await Promise.race([reader.read(), stall]);
          clearTimeout(timer);
          if (r.done) controller.close();
          else controller.enqueue(r.value);
        } catch (e) {
          clearTimeout(timer);
          try { reader.cancel(); } catch (x) {}
          controller.error(e);
        }
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch (e) {}
      },
    });
  }

  /** 依次读取多段 durl，每段都支持备用源 */
  function multiSource(groups, signal) {
    var gi = 0;
    var reader = null;
    return new Fmp4Mux.ByteSource(async function () {
      for (;;) {
        if (!reader) {
          if (gi >= groups.length) return null;
          var res = await fetchWithFallback(groups[gi++], signal);
          reader = watchdogStream(res.body, 25000).getReader();
        }
        var step = await reader.read();
        if (step.done) {
          reader = null;
          continue;
        }
        return step.value;
      }
    });
  }

  function makeWriter(target, fileName, mime) {
    if (target && target.dirHandle) {
      return target.dirHandle.getFileHandle(fileName, { create: true }).then(function (fh) {
        return fh.createWritable().then(function (w) { return wrapWritable(w); });
      });
    }
    if (target && target.fileHandle) {
      return target.fileHandle.createWritable().then(function (w) { return wrapWritable(w); });
    }
    var chunks = [];
    return Promise.resolve({
      write: function (u8) { chunks.push(u8.slice()); },
      close: function () {
        var blob = new Blob(chunks, { type: mime || 'video/mp4' });
        chunks.length = 0;
        triggerDownload(blob, fileName);
      },
      reset: function () { chunks.length = 0; },
      abort: function () { chunks.length = 0; },
    });
  }

  function wrapWritable(w) {
    return {
      write: function (u8) { return w.write(u8); },
      close: function () { return w.close(); },
      reset: async function () {
        try { await w.truncate(0); await w.seek(0); } catch (e) {}
      },
      abort: function () { try { return w.abort(); } catch (e) {} },
    };
  }

  function triggerDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 60000);
  }

  function guardedSink(writer) {
    return {
      write: async function (u8) {
        if (state.ctrl.signal.aborted) throw new DOMException('已取消', 'AbortError');
        await writer.write(u8);
        state.written += u8.length;
        paintProgress();
      },
    };
  }

  function pickUrl(list, i) {
    if (!list || !list.length) return null;
    return list[Math.min(i, list.length - 1)];
  }

  /** 单次尝试：按第 attempt 个候选源取流 */
  async function runAttempt(info, writer, attempt) {
    if (info.kind === 'merge') {
      state.stage = '读取流';
      var vUrl = pickUrl(info.videoUrls, attempt);
      var aUrl = pickUrl(info.audioUrls, attempt);
      var vres = await fetchWithFallback([vUrl], state.ctrl.signal);
      var ares = await fetchWithFallback([aUrl], state.ctrl.signal);

      state.total = (parseInt(vres.headers.get('content-length'), 10) || 0) + (parseInt(ares.headers.get('content-length'), 10) || 0);
      state.stage = '下载并合并';
      paintProgress(true);

      await Fmp4Mux.mux({
        video: Fmp4Mux.sourceFromStream(watchdogStream(vres.body, 20000)),
        audio: Fmp4Mux.sourceFromStream(watchdogStream(ares.body, 20000)),
        sink: guardedSink(writer),
      });
      return;
    }

    if (info.remux) {
      state.stage = '下载';
      state.total = info.size || 0;
      paintProgress(true);
      var groups = info.urls.map(function (g) { return [pickUrl(g, attempt)]; });
      await Fmp4Mux.remuxSingle({
        source: multiSource(groups, state.ctrl.signal),
        sink: guardedSink(writer),
      });
      return;
    }

    state.stage = '下载';
    var res = await fetchWithFallback([pickUrl(info.urls[0], attempt)], state.ctrl.signal);
    state.total = parseInt(res.headers.get('content-length'), 10) || info.size || 0;
    paintProgress(true);
    var reader = watchdogStream(res.body, 20000).getReader();
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      if (state.ctrl.signal.aborted) throw new DOMException('已取消', 'AbortError');
      await writer.write(step.value);
      state.written += step.value.length;
      paintProgress();
    }
  }

  async function runJob(info, target, fileName) {
    var writer = await makeWriter(target, fileName, info.mime);
    trace('runJob', info.kind, info.remux, fileName);

    var max = 1;
    if (info.kind === 'merge') max = Math.max(info.videoUrls.length, info.audioUrls.length);
    else if (!info.remux) max = info.urls[0].length;
    max = Math.min(Math.max(max, 1), 3);

    var lastErr = null;
    for (var attempt = 0; attempt < max; attempt++) {
      try {
        if (attempt > 0) {
          await writer.reset();
          resetProgress();
          trace('retry', attempt);
        }
        state.written = 0;
        await runAttempt(info, writer, attempt);
        await writer.close();
        paintProgress(true);
        return;
      } catch (e) {
        lastErr = e;
        if (e && e.name === 'AbortError') break;
        if (attempt === max - 1) break;
        setMsg('节点不稳定，正在换源重试…');
      }
    }
    await writer.abort();
    throw lastErr || new Error('下载失败');
  }

  /* --------------------------------------------------------------- 任务编排 */

  function buildFileName(part, info) {
    var base = safeName(state.ctx.title);
    var pTail = state.ctx.parts.length > 1 ? '_P' + part.index : '';
    var qTail = info.label ? '_' + safeName(info.label) : '';
    return base + pTail + qTail + '.' + info.ext;
  }

  async function resolveJob(part) {
    var base = { cid: part.cid, fourk: 1, qn: 127, platform: 'pc' };
    if (part.bvid) base.bvid = part.bvid;
    if (part.epId) base.ep_id = part.epId;

    if (state.mode === 'single') {
      var d = await api('/x/player/playurl', Object.assign({ fnval: 1 }, base)).catch(function (e) {
        if (state.ctx.kind !== 'bangumi') throw e;
        return api('/pgc/player/web/playurl', Object.assign({ fnval: 1 }, base));
      });
      var segs = d.durl || [];
      if (!segs.length) throw new Error('该视频没有单文件格式，请改用「音视频合并」');
      var size = segs.reduce(function (a, s) { return a + (s.size || 0); }, 0);
      return {
        kind: 'raw',
        urls: segs.map(function (s) { return [s.url].concat(s.backup_url || []); }),
        remux: segs.length > 1,
        label: QN_NAME[d.quality] || (d.quality + 'P'),
        ext: 'mp4',
        mime: 'video/mp4',
        size: size,
      };
    }

    var data = await api('/x/player/playurl', Object.assign({ fnval: 4048 }, base)).catch(function (e) {
      if (state.ctx.kind !== 'bangumi') throw e;
      return api('/pgc/player/web/playurl', Object.assign({ fnval: 4048 }, base));
    });
    var dash = data.dash;
    if (!dash) throw new Error('该视频不支持 DASH 音视频流');

    if (state.mode === 'audio') {
      var a = pickAudio(dash);
      if (!a) throw new Error('没有可用的音频流');
      return {
        kind: 'raw',
        urls: [[a.baseUrl].concat(a.backupUrl || [])],
        remux: false,
        label: '',
        ext: 'm4a',
        mime: 'audio/mp4',
        size: 0,
      };
    }

    var v = pickVideo(state.quality, state.codec);
    var au = pickAudio(dash);
    if (!v) throw new Error('没有可用的视频流');
    if (!au) throw new Error('没有可用的音频流');

    return {
      kind: 'merge',
      videoUrls: [v.baseUrl].concat(v.backupUrl || []),
      audioUrls: [au.baseUrl].concat(au.backupUrl || []),
      label: (QN_NAME[state.quality] || state.quality + 'P') + '_' + (CODEC_NAME[state.codec] || ''),
      ext: 'mp4',
      mime: 'video/mp4',
    };
  }

  function selectedParts() {
    var idx = Array.from(state.parts).sort(function (a, b) { return a - b; });
    if (!idx.length) idx = [state.ctx.current - 1];
    return idx.map(function (i) { return state.ctx.parts[i]; }).filter(Boolean);
  }

  async function pickTarget(parts) {
    if (!window.showSaveFilePicker) return null;
    try {
      if (parts.length > 1 && window.showDirectoryPicker) {
        return { dirHandle: await window.showDirectoryPicker({ id: 'bd-out', mode: 'readwrite', startIn: 'videos' }) };
      }
      var isAudio = state.mode === 'audio';
      var suggestion = safeName(state.ctx.title) + (isAudio ? '.m4a' : '.mp4');
      var fh = await window.showSaveFilePicker({
        id: 'bd-out-file',
        suggestedName: suggestion,
        types: [isAudio
          ? { description: '音频', accept: { 'audio/mp4': ['.m4a'] } }
          : { description: '视频', accept: { 'video/mp4': ['.mp4'] } }],
      });
      return { fileHandle: fh };
    } catch (e) {
      if (e && e.name === 'AbortError') return 'abort';
      return null; // 不支持或无手势 → 退回浏览器下载
    }
  }

  async function startDownload() {
    if (state.busy || !state.ctx) return;

    var parts = selectedParts();
    var target = await pickTarget(parts);
    if (target === 'abort') return;

    state.ctrl = new AbortController();
    setBusy(true);

    var saved = 0;
    try {
      for (var i = 0; i < parts.length; i++) {
        if (state.ctrl.signal.aborted) break;
        var part = parts[i];
        setMsg(parts.length > 1 ? '(' + (i + 1) + '/' + parts.length + ') 解析流地址…' : '解析流地址…');
        resetProgress();

        var info = await resolveJob(part);
        trace('resolved', JSON.stringify({ kind: info.kind, remux: info.remux, n: info.urls && info.urls.length, size: info.size, label: info.label }));
        var name = buildFileName(part, info);
        await runJob(info, target, name);
        saved++;
      }
      if (state.ctrl.signal.aborted) {
        setMsg('已取消' + (saved ? '，已保存 ' + saved + ' 个文件' : ''));
      } else {
        setMsg(saved > 1 ? '完成，已保存 ' + saved + ' 个文件' : '下载完成', 'ok');
        bar.style.width = '100%';
        tabPct.textContent = '';
      }
    } catch (e) {
      if (e && (e.name === 'AbortError' || /已取消/.test(e.message || ''))) {
        setMsg('已取消');
      } else {
        trace('error', (e && (e.name + ': ' + e.message)) || String(e));
        setMsg(e && e.message ? e.message : String(e), 'err');
      }
    } finally {
      state.ctrl = null;
      setBusy(false);
    }
  }

  function cancel() {
    if (state.ctrl) state.ctrl.abort();
  }

  /* ------------------------------------------------------------------- 挂载 */

  function hostElement() {
    return document.querySelector('#bilibili-player') || document.querySelector('.bpx-player-container');
  }

  function ensureMounted() {
    var host = hostElement();
    var parent = host || document.body;
    if (root.parentNode !== parent) {
      if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
      parent.appendChild(root);
    }
    root.classList.toggle('bd-fixed', !host);
  }

  tab.onclick = function () {
    var open = root.classList.toggle('is-open');
    if (open && !state.ctx) refresh();
  };
  closeBtn.onclick = function () {
    root.classList.remove('is-open');
  };
  goBtn.onclick = function () {
    if (state.busy) cancel();
    else startDownload();
  };

  /* ---------------------------------------------------------------- 生命周期 */

  async function refresh() {
    var token = ++state.loadToken;
    headTitle.textContent = '正在读取视频信息…';
    try {
      var ctx = await loadContext();
      if (token !== state.loadToken) return;
      var same = state.ctx && state.ctx.title === ctx.title && state.ctx.parts.length === ctx.parts.length;
      state.ctx = ctx;
      if (!same) {
        state.parts = new Set([ctx.current - 1]);
        state.quality = null;
        state.codec = null;
      } else if (!state.parts.size) {
        state.parts = new Set([ctx.current - 1]);
      }
      await loadStreams();
      if (token !== state.loadToken) return;
      renderBody();
    } catch (e) {
      if (token !== state.loadToken) return;
      headTitle.textContent = '未识别到视频';
      body.textContent = '';
      body.appendChild(h('div', 'bd-hint', (e && e.message) || '读取失败'));
      goBtn.disabled = true;
    }
  }

  var lastUrl = location.href;

  function tick() {
    ensureMounted();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (state.busy) return; // 下载中不打断
      state.ctx = null;
      root.classList.remove('is-open');
      headTitle.textContent = '正在读取视频信息…';
      refresh();
    }
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'bd-open-panel') {
      root.classList.add('is-open');
      if (!state.ctx) refresh();
    }
  });

  chrome.storage.sync.get({ preferCodec: 'auto' }, function (v) {
    state.preferCodec = v.preferCodec || 'auto';
    if (state.ctx) {
      pickDefaults();
      renderBody();
    }
  });

  ensureMounted();
  setInterval(tick, 700);

  // 播放器可能晚于脚本渲染，前几秒加密集重试
  var tries = 0;
  var boot = setInterval(function () {
    ensureMounted();
    if (hostElement() || ++tries > 20) {
      clearInterval(boot);
      refresh();
    }
  }, 300);
})();
