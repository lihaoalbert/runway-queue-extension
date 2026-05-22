// Popup 脚本：管理界面交互
// 直接与 chrome.storage.local 交互，不依赖 Service Worker

let currentStatus = {
  queue: [],
  currentIndex: 0,
  isRunning: false,
  settings: {}
};

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadStatus();
  bindEvents();
  updateUI();
});

// 直接从 storage 加载状态
async function loadStatus() {
  try {
    const data = await chrome.storage.local.get(['queue', 'settings', 'currentIndex', 'isRunning']);
    currentStatus = {
      queue: data.queue || [],
      settings: data.settings || {},
      currentIndex: data.currentIndex || 0,
      isRunning: data.isRunning || false
    };
    updateUI();
  } catch (error) {
    console.error('加载状态失败:', error);
  }
}

// 直接保存状态到 storage
async function saveStatus() {
  try {
    await chrome.storage.local.set({
      queue: currentStatus.queue,
      settings: currentStatus.settings,
      currentIndex: currentStatus.currentIndex,
      isRunning: currentStatus.isRunning
    });
  } catch (error) {
    console.error('保存状态失败:', error);
  }
}

// 绑定事件
function bindEvents() {
  // 切换运行状态
  document.getElementById('toggleBtn').addEventListener('click', toggleRunning);

  // 添加到队列
  document.getElementById('addBtn').addEventListener('click', addToQueue);

  // 清空队列
  document.getElementById('clearBtn').addEventListener('click', clearQueue);

  // 批量导入
  document.getElementById('batchBtn').addEventListener('click', showBatchModal);
  document.getElementById('modalClose').addEventListener('click', hideBatchModal);
  document.getElementById('modalCancel').addEventListener('click', hideBatchModal);
  document.getElementById('parseBtn').addEventListener('click', parseBatch);
  document.getElementById('batchInput').addEventListener('input', parseBatch);
  document.getElementById('delimiter').addEventListener('input', parseBatch);
  document.getElementById('modalConfirm').addEventListener('click', confirmBatch);

  // 设置变更
  ['checkInterval', 'successDelay', 'randomDelay'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateSettings);
  });
  document.getElementById('defaultDuration').addEventListener('change', updateSettings);
  document.getElementById('testMode').addEventListener('change', updateSettings);

  // 回车提交 (Ctrl/Cmd + Enter)
  document.getElementById('promptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      addToQueue();
    }
  });

  // 监听 storage 变化（content script 会更新 storage）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      loadStatus();
    }
  });
}

// 切换运行状态
async function toggleRunning() {
  currentStatus.isRunning = !currentStatus.isRunning;
  await saveStatus();
  updateUI();
}

// 添加到队列
async function addToQueue() {
  const input = document.getElementById('promptInput');
  const prompt = input.value.trim();

  if (!prompt) {
    alert('请输入提示词');
    return;
  }

  currentStatus.queue.push({
    id: Date.now(),
    prompt: prompt,
    status: 'pending',
    addedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  });

  await saveStatus();
  input.value = '';
  await loadStatus();
}

// 清空队列
async function clearQueue() {
  if (currentStatus.queue.length === 0) return;

  if (!confirm('确定要清空所有队列任务吗？')) return;

  currentStatus.queue = [];
  currentStatus.currentIndex = 0;
  currentStatus.isRunning = false;
  await saveStatus();
  await loadStatus();
}

// 删除单个任务
async function deleteTask(id) {
  currentStatus.queue = currentStatus.queue.filter(t => t.id !== id);
  if (currentStatus.currentIndex >= currentStatus.queue.length) {
    currentStatus.currentIndex = 0;
  }
  await saveStatus();
  await loadStatus();
}

// 批量导入
let parsedTasks = [];

function showBatchModal() {
  document.getElementById('batchModal').classList.add('show');
  document.getElementById('batchInput').value = '';
  document.getElementById('previewCount').textContent = '待解析';
  document.getElementById('previewList').innerHTML = '<div class="empty-state" style="padding:20px;">粘贴内容后自动解析</div>';
  document.getElementById('modalConfirm').disabled = true;
  document.getElementById('modalConfirm').textContent = '确认添加 (0)';
  parsedTasks = [];
}

function hideBatchModal() {
  document.getElementById('batchModal').classList.remove('show');
}

function parseBatch() {
  const input = document.getElementById('batchInput').value;
  const delimiter = document.getElementById('delimiter').value || '---';

  if (!input.trim()) {
    document.getElementById('previewCount').textContent = '待解析';
    document.getElementById('previewList').innerHTML = '<div class="empty-state" style="padding:20px;">粘贴内容后自动解析</div>';
    document.getElementById('modalConfirm').disabled = true;
    document.getElementById('modalConfirm').textContent = '确认添加 (0)';
    parsedTasks = [];
    return;
  }

  // 按分隔符拆分，转义特殊正则字符
  const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = input.split(new RegExp(escaped)).map(s => s.trim()).filter(s => s.length > 0);
  parsedTasks = parts;

  document.getElementById('previewCount').textContent = `解析结果：${parts.length} 个任务`;
  document.getElementById('modalConfirm').disabled = parts.length === 0;
  document.getElementById('modalConfirm').textContent = `确认添加 (${parts.length})`;

  if (parts.length === 0) {
    document.getElementById('previewList').innerHTML = '<div class="empty-state" style="padding:20px;">未检测到任务，请检查分隔符</div>';
    return;
  }

  document.getElementById('previewList').innerHTML = parts.map((text, i) => {
    const preview = text.length > 80 ? text.substring(0, 80).replace(/\n/g, ' ') + '...' : text.replace(/\n/g, ' ');
    return `
      <div class="preview-item">
        <span class="preview-index">${i + 1}</span>
        <span class="preview-text" title="${escapeHtml(text).substring(0, 200)}">${escapeHtml(preview)}</span>
      </div>
    `;
  }).join('');
}

async function confirmBatch() {
  if (parsedTasks.length === 0) return;

  let added = 0;
  for (const prompt of parsedTasks) {
    currentStatus.queue.push({
      id: Date.now() + added,
      prompt: prompt,
      status: 'pending',
      addedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    });
    added++;
  }

  await saveStatus();
  hideBatchModal();
  await loadStatus();
}

// 更新设置
async function updateSettings() {
  currentStatus.settings = {
    checkInterval: parseInt(document.getElementById('checkInterval').value) * 1000,
    successDelay: parseInt(document.getElementById('successDelay').value) * 1000,
    randomDelay: parseInt(document.getElementById('randomDelay').value) * 1000,
    defaultDuration: document.getElementById('defaultDuration').value,
    testMode: document.getElementById('testMode').checked,
  };
  await saveStatus();
}

// 更新界面
function updateUI() {
  // 更新状态指示
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const toggleBtn = document.getElementById('toggleBtn');

  if (currentStatus.isRunning) {
    statusDot.classList.add('running');
    const pendingCount = currentStatus.queue.filter(t => t.status !== 'completed' && t.status !== 'failed').length;
    statusText.textContent = `运行中 (${pendingCount} 个待处理)`;
    toggleBtn.textContent = '停止';
    toggleBtn.classList.add('stop');
  } else {
    statusDot.classList.remove('running');
    const pendingCount = currentStatus.queue.filter(t => t.status !== 'completed' && t.status !== 'failed').length;
    statusText.textContent = currentStatus.queue.length > 0 ? `已暂停 (${pendingCount} 个待处理)` : '已停止';
    toggleBtn.textContent = '开始';
    toggleBtn.classList.remove('stop');
  }

  // 更新队列数量
  document.getElementById('queueCount').textContent = currentStatus.queue.length;

  // 更新队列列表
  renderQueue();

  // 更新设置输入
  if (currentStatus.settings) {
    document.getElementById('checkInterval').value = (currentStatus.settings.checkInterval || 60000) / 1000;
    document.getElementById('successDelay').value = (currentStatus.settings.successDelay || 5000) / 1000;
    document.getElementById('randomDelay').value = (currentStatus.settings.randomDelay || 5000) / 1000;
    document.getElementById('defaultDuration').value = currentStatus.settings.defaultDuration || '';
    document.getElementById('testMode').checked = currentStatus.settings.testMode || false;
  }
}

// 渲染队列
function renderQueue() {
  const list = document.getElementById('queueList');

  if (currentStatus.queue.length === 0) {
    list.innerHTML = '<div class="empty-state">队列为空，点击上方添加提示词</div>';
    return;
  }

  list.innerHTML = currentStatus.queue.map((task, index) => {
    const statusClass = task.status === 'completed' ? 'completed' :
                        task.status === 'failed' ? 'failed' :
                        task.status === 'running' ? 'running' : '';

    const itemClass = index === currentStatus.currentIndex ? 'current' : statusClass;
    const statusText = task.status === 'completed' ? '✓ 已完成' :
                       task.status === 'failed' ? `✗ 失败` :
                       task.status === 'running' ? '⟳ 处理中' : '○ 等待中';

    // 截断长提示词
    const shortPrompt = task.prompt.length > 60 ?
      task.prompt.substring(0, 60) + '...' : task.prompt;

    return `
      <div class="queue-item ${itemClass}" data-id="${task.id}">
        <span class="queue-item-index">${index + 1}</span>
        <div class="queue-item-content">
          <div class="queue-item-prompt">${escapeHtml(shortPrompt)}</div>
          <div class="queue-item-status ${statusClass}">${statusText}</div>
        </div>
        <button class="delete-btn" data-delete-id="${task.id}" title="删除">×</button>
      </div>
    `;
  }).join('');
}

// 事件委托：删除按钮
document.addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('[data-delete-id]');
  if (deleteBtn) {
    const id = parseInt(deleteBtn.dataset.deleteId, 10);
    deleteTask(id);
  }
});

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
