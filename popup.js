// popup：查询 / 切换当前标签页的音乐模式
const sw = document.getElementById('sw');
const hint = document.getElementById('hint');

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const notVideoPage = () => {
  sw.disabled = true;
  sw.checked = false;
  hint.textContent = '请在 B 站视频页使用';
  hint.classList.add('error');
};

(async () => {
  const tab = await activeTab();
  if (!tab?.id) return notVideoPage();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'bmm:query' });
    sw.checked = !!res?.open;
  } catch (e) {
    notVideoPage();
  }
})();

sw.addEventListener('change', async () => {
  const tab = await activeTab();
  if (!tab?.id) return notVideoPage();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'bmm:set', open: sw.checked });
    hint.classList.remove('error');
    hint.textContent = sw.checked ? '已开启（首次开启会刷新一次页面）' : '已关闭';
  } catch (e) {
    notVideoPage();
  }
});
