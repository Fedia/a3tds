document.querySelector('#open').onclick = () => chrome.runtime.sendMessage({
  type: 'open-workspace'
});
async function render() {
  const {
    summary
  } = await chrome.storage.local.get('summary');
  document.querySelector('#status').textContent = summary?.status || 'Нет задачи';
  document.querySelector('#log').textContent = summary?.message || '';
}
render();
chrome.storage.onChanged.addListener(render);
