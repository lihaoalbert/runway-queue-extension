// 后台脚本：管理队列状态和存储
let queue = [];
let isRunning = false;
let currentIndex = 0;
let settings = {
  checkInterval: 150000,     // 检查间隔 (ms)
  successDelay: 5000,        // 成功后延迟 (ms)
  randomDelay: 5000,         // 随机延迟范围 (ms)
  maxRetries: 3,             // 最大重试次数
  defaultDuration: '15s',   // 默认时长设置
};

// 从 storage 加载数据
async function loadData() {
  const data = await chrome.storage.local.get(['queue', 'settings', 'currentIndex', 'isRunning']);
  queue = data.queue || [];
  settings = { ...settings, ...data.settings };
  currentIndex = data.currentIndex || 0;
  // 使用 undefined 检查而不是 || false，避免重置状态
  if (data.isRunning !== undefined) {
    isRunning = data.isRunning;
  }
}

// 保存数据到 storage
async function saveData() {
  await chrome.storage.local.set({ queue, settings, currentIndex, isRunning });
}

// 向队列添加任务
async function addTask(task) {
  queue.push({
    id: Date.now(),
    prompt: task.prompt,
    status: 'pending', // pending, running, completed, failed
    addedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  });
  await saveData();
  notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
}

// 移除任务
async function removeTask(id) {
  queue = queue.filter(t => t.id !== id);
  if (currentIndex >= queue.length) currentIndex = 0;
  await saveData();
  notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
}

// 清空队列
async function clearQueue() {
  queue = [];
  currentIndex = 0;
  isRunning = false;
  await saveData();
  notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
}

// 更新设置
async function updateSettings(newSettings) {
  settings = { ...settings, ...newSettings };
  await saveData();
  notifyContentScript('settingsUpdated', settings);
}

// 获取状态
function getStatus() {
  return { queue, currentIndex, isRunning, settings };
}

// 通知 content script
async function notifyContentScript(type, data) {
  const tabs = await chrome.tabs.query({ url: ['https://app.runwayml.com/*', 'https://*.runwayml.com/*', 'https://*.runwayai.com/*'] });
  tabs.forEach(tab => {
    chrome.tabs.sendMessage(tab.id, { type, data }).catch(() => {});
  });
}

// 监听来自 popup 和 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'getStatus':
      return getStatus();

    case 'addTask':
      await addTask(message.data);
      return { success: true };

    case 'removeTask':
      await removeTask(message.data.id);
      return { success: true };

    case 'clearQueue':
      await clearQueue();
      return { success: true };

    case 'startQueue':
      console.log('[Runway Queue BG] startQueue called, current queue:', queue.length, 'tasks');
      isRunning = true;
      await saveData();
      notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
      console.log('[Runway Queue BG] startQueue done, isRunning:', isRunning);
      return { success: true };

    case 'stopQueue':
      isRunning = false;
      await saveData();
      notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
      return { success: true };

    case 'skipCurrent':
      if (currentIndex < queue.length) {
        queue[currentIndex].status = 'skipped';
        currentIndex++;
        await saveData();
        notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
      }
      return { success: true };

    case 'updateSettings':
      await updateSettings(message.data);
      return { success: true, settings };

    case 'taskCompleted':
      if (currentIndex < queue.length) {
        queue[currentIndex].status = 'completed';
        queue[currentIndex].completedAt = new Date().toISOString();
        currentIndex++;
        await saveData();
        notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
      }
      return { success: true };

    case 'taskFailed':
      if (currentIndex < queue.length) {
        queue[currentIndex].status = 'failed';
        queue[currentIndex].error = message.data.error;
        currentIndex++;
        await saveData();
        notifyContentScript('queueUpdated', { queue, currentIndex, isRunning });
      }
      return { success: true };

    case 'getCurrentTask':
      console.log('[Runway Queue BG] getCurrentTask called, isRunning:', isRunning, 'currentIndex:', currentIndex, 'queueLength:', queue.length);
      if (isRunning && queue.length > 0 && currentIndex < queue.length) {
        console.log('[Runway Queue BG] Returning task:', queue[currentIndex]);
        return { task: queue[currentIndex], index: currentIndex };
      }
      console.log('[Runway Queue BG] No task to return');
      return { task: null };

    default:
      return { error: 'Unknown message type' };
  }
}

// 初始化
loadData();