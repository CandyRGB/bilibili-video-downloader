/* B站视频下载器 — 弹出面板 */

const $ = (s) => document.querySelector(s);

const VIDEO_RE = /^https:\/\/www\.bilibili\.com\/(video|bangumi\/play|list)\//;

async function init() {
  $('#ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const { preferCodec = 'auto' } = await chrome.storage.sync.get({ preferCodec: 'auto' });
  $('#codec').value = String(preferCodec);

  $('#codec').addEventListener('change', (e) => {
    chrome.storage.sync.set({ preferCodec: e.target.value });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';

  if (VIDEO_RE.test(url)) {
    let label = '视频播放页';
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
      if (m) {
        label = m[1] + (u.searchParams.get('p') ? '  P' + u.searchParams.get('p') : '');
      } else if (u.pathname.includes('/bangumi/play/')) {
        label = '番剧 ' + u.pathname.split('/').pop();
      }
    } catch (e) {}
    $('#page').textContent = label;
    $('#open').disabled = false;
    $('#open').addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'bd-open-panel' });
        window.close();
      } catch (e) {
        $('#open').textContent = '请刷新页面后重试';
      }
    });
  } else {
    $('#page').textContent = '不是 B 站视频页';
    $('#page').classList.add('muted');
  }
}

init();
