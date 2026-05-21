// Content Script: 在 Runway 页面上运行的核心自动化逻辑

let isRunning = false;
let currentTask = null;
let checkInterval = null;
let queue = [];
let currentIndex = 0;
let settings = {
  checkInterval: 60000,      // 检查间隔 (ms)
  successDelay: 5000,        // 成功后延迟 (ms)
  randomDelay: 5000,         // 随机延迟范围 (ms)
  maxRetries: 3,             // 最大重试次数
  defaultDuration: '15s',   // 默认时长设置
};

// 直接从 storage 读取状态（不依赖 Service Worker）
async function loadStateFromStorage() {
  try {
    const data = await chrome.storage.local.get(['queue', 'settings', 'currentIndex', 'isRunning']);
    queue = data.queue || [];
    currentIndex = data.currentIndex || 0;
    isRunning = data.isRunning || false;
    if (data.settings) {
      settings = { ...settings, ...data.settings };
    }
    console.log('[Runway Queue] Loaded state: isRunning=', isRunning, 'queueLength=', queue.length, 'currentIndex=', currentIndex);
  } catch (e) {
    console.error('[Runway Queue] Error loading state:', e);
  }
}

// 保存状态到 storage
async function saveStateToStorage() {
  try {
    await chrome.storage.local.set({ queue, currentIndex, isRunning, settings });
  } catch (e) {
    console.error('[Runway Queue] Error saving state:', e);
  }
}

// 监听 storage 变化
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.queue) queue = changes.queue.newValue || [];
    if (changes.currentIndex) currentIndex = changes.currentIndex.newValue || 0;
    if (changes.isRunning) {
      isRunning = changes.isRunning.newValue;
      if (isRunning) {
        startPolling();
      } else {
        stopPolling();
      }
    }
    if (changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
    }
    console.log('[Runway Queue] State changed via storage listener');
  }
});

// 等待元素出现的辅助函数
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }

    const observer = new MutationObserver((mutations, obs) => {
      const el = document.querySelector(selector);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element ${selector} not found within ${timeout}ms`));
    }, timeout);
  });
}

// 随机延迟
function randomDelay(max) {
  const delay = Math.random() * max;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// 处理提示词：标记 @参考图片 的位置（用于逐字输入时检测）
function findReferenceImages(prompt) {
  const parts = [];
  let lastEnd = 0;
  const regex = /(@\S+)/g;
  let match;

  while ((match = regex.exec(prompt)) !== null) {
    // 添加匹配前的文本
    if (match.index > lastEnd) {
      parts.push({
        type: 'text',
        content: prompt.slice(lastEnd, match.index)
      });
    }
    // 添加 @参考图片 标记
    parts.push({
      type: 'reference',
      content: match[1]
    });
    lastEnd = match.index + match[0].length;
  }

  // 添加剩余文本
  if (lastEnd < prompt.length) {
    parts.push({
      type: 'text',
      content: prompt.slice(lastEnd)
    });
  }

  return parts;
}

// 检查按钮是否可用（考虑 data-soft-disabled）
function isButtonEnabled(btn) {
  if (btn.disabled) return false;
  const softDisabled = btn.getAttribute('data-soft-disabled');
  if (softDisabled === 'true') return false;
  return btn.offsetParent !== null;
}

// 查找 Prompt 输入框
function findPromptInput() {
  const promptDiv = document.querySelector('[aria-label="Prompt"][contenteditable="true"]');
  if (promptDiv) return promptDiv;

  const lexical = document.querySelector('[data-lexical-editor="true"]');
  if (lexical) return lexical;

  const textbox = document.querySelector('div[class*="textbox"][contenteditable="true"]');
  if (textbox) return textbox;

  return null;
}

// 设置时长
async function setDuration(targetDuration) {
  const durationBtn = document.querySelector('button[aria-label="Duration"]');
  if (!durationBtn) {
    console.log('[Runway Queue] 未找到时长选择器');
    return false;
  }

  // 检查当前时长
  const currentText = durationBtn.querySelector('span');
  const currentDuration = currentText ? currentText.textContent.trim() : '';
  console.log('[Runway Queue] 当前时长:', currentDuration);

  if (currentDuration === targetDuration) {
    console.log('[Runway Queue] 时长已是', targetDuration);
    return true;
  }

  // 点击打开下拉菜单
  durationBtn.click();
  await randomDelay(500);

  // 查找下拉选项
  let options = [];
  const optionSelectors = [
    '[role="option"]',
    '[role="listbox"] [role="option"]',
    'ul[role="listbox"] li',
    'div[role="listbox"] > *',
  ];

  for (const sel of optionSelectors) {
    const found = document.querySelectorAll(sel);
    if (found.length > 0) {
      options = Array.from(found);
      break;
    }
  }

  console.log('[Runway Queue] 找到', options.length, '个时长选项');

  // 查找目标时长的选项
  const targetOption = options.find(opt => {
    const text = opt.textContent;
    return text.includes(targetDuration) || text === targetDuration;
  });

  if (targetOption) {
    targetOption.click();
    console.log('[Runway Queue] 已选择时长:', targetDuration);
    await randomDelay(300);
    return true;
  } else {
    console.log('[Runway Queue] 可用选项:', options.map(o => o.textContent.trim()));
    document.body.click();
    return false;
  }
}

// 向文本框输入内容（逐字输入，支持 @参考图 后回车）
async function inputPrompt(text) {
  const promptInput = findPromptInput();

  if (!promptInput) {
    throw new Error('未找到文本输入框');
  }

  console.log('[Runway Queue] 找到输入框，准备逐字输入...');

  // 点击输入框聚焦
  promptInput.click();
  await randomDelay(300);

  // 聚焦
  promptInput.focus();
  await randomDelay(100);

  // 清空现有内容
  promptInput.textContent = '';
  promptInput.innerHTML = '';
  promptInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  await randomDelay(300);

  // 解析文本，找出 @参考图 的位置
  const parts = findReferenceImages(text);

  console.log('[Runway Queue] 解析到', parts.length, '个文本段');

  // 逐字输入每个部分
  for (const part of parts) {
    if (part.type === 'text') {
      // 普通文本，逐字输入
      for (const char of part.content) {
        document.execCommand('insertText', false, char);
        await randomDelay(20 + Math.random() * 30); // 20-50ms 每字
      }
    } else if (part.type === 'reference') {
      // @参考图，只输入 @xxx 不输入空格
      for (const char of part.content) {
        document.execCommand('insertText', false, char);
        await randomDelay(20 + Math.random() * 30);
      }
      // @参考图 结束后按回车
      console.log('[Runway Queue] 检测到参考图，输入回车');
      document.execCommand('insertText', false, '\n');
      await randomDelay(200); // 等待回车生效
    }
  }

  // 触发完成事件
  promptInput.dispatchEvent(new InputEvent('input', { bubbles: true }));

  console.log('[Runway Queue] 逐字输入完成');
  await randomDelay(500);
}

// 点击生成按钮
async function clickGenerateButton() {
  const videoIconBtn = document.querySelector('button:has(svg.lucide-video)');
  if (videoIconBtn && isButtonEnabled(videoIconBtn)) {
    videoIconBtn.click();
    return;
  }

  const primaryBtn = Array.from(document.querySelectorAll('button[class*="primaryButton"]'))
    .find(btn => isButtonEnabled(btn));
  if (primaryBtn) {
    primaryBtn.click();
    return;
  }

  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const text = btn.textContent.toLowerCase();
    if (text.includes('generate') && isButtonEnabled(btn)) {
      btn.click();
      return;
    }
  }

  throw new Error('未找到可点击的生成按钮');
}

// 检查是否正在生成中（支持 2 个并发额度）
function isGenerating() {
  // 检查 Generate 按钮是否被禁用
  const generateBtn = document.querySelector('button:has(svg.lucide-video)');
  if (generateBtn) {
    if (generateBtn.disabled) return true;
    const softDisabled = generateBtn.getAttribute('data-soft-disabled');
    if (softDisabled === 'true') return true;
  }

  // 检查 primaryButton 是否被禁用
  const primaryBtns = document.querySelectorAll('button[class*="primaryButton"]');
  for (const btn of primaryBtns) {
    if (btn.disabled) return true;
    const softDisabled = btn.getAttribute('data-soft-disabled');
    if (softDisabled === 'true') return true;
  }

  // 检查按钮文字是否包含 generating
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const text = btn.textContent.toLowerCase();
    if (text.includes('generating') || text.includes('生成中')) {
      return true;
    }
  }

  // 检查 video 是否在加载
  const videoElements = document.querySelectorAll('video');
  for (const video of videoElements) {
    if (video.readyState < 3) {
      return true;
    }
  }

  // 检查 loading/progress 相关元素（重点检测 Runway 的进度指示器）
  const loadingElements = document.querySelectorAll(
    '[class*="progress"]',
    '[class*="loading"]',
    '[class*="spinner"]',
    '[class*="queue"]',
    '[class*="pending"]'
  );
  for (const el of loadingElements) {
    if (el.offsetParent !== null && getComputedStyle(el).display !== 'none') {
      // 排除一些误报
      const className = el.className.toLowerCase();
      if (!className.includes('sidebar') && !className.includes('navigation')) {
        return true;
      }
    }
  }

  // 检查是否有任务卡片显示处理中
  const taskCards = document.querySelectorAll('[class*="task"], [class*="job"], [class*="jobCard"]');
  for (const card of taskCards) {
    const text = card.textContent.toLowerCase();
    if (text.includes('processing') || text.includes('running') || text.includes('queued')) {
      return true;
    }
  }

  return false;
}

// 记录上一次检测到的状态，避免重复判断
let lastGenerationCheckTime = 0;
let wasGeneratingBefore = false;

// 检查生成是否成功完成（改进版）
function isGenerationComplete() {
  // 如果之前不在生成状态，现在也不算完成
  if (!wasGeneratingBefore && !isGenerating()) {
    return false;
  }

  // 如果之前在生成，现在不在了，才算可能完成
  if (wasGeneratingBefore && !isGenerating()) {
    console.log('[Runway Queue] 生成似乎已完成');
    wasGeneratingBefore = false;
    return true;
  }

  // 之前在生成，现在还在生成
  if (isGenerating()) {
    wasGeneratingBefore = true;
    return false;
  }

  return false;
}

// 处理单个任务
async function processTask(task) {
  console.log('[Runway Queue] 处理任务:', task.prompt.substring(0, 50) + '...');

  try {
    // 1. 处理提示词（添加回车）
    const processedPrompt = processPrompt(task.prompt);
    console.log('[Runway Queue] 处理后提示词:', processedPrompt);

    // 2. 等待页面加载
    await waitForElement('body', 5000);

    // 3. 设置时长（如果配置了）
    if (settings.defaultDuration) {
      await setDuration(settings.defaultDuration);
    }

    // 4. 输入提示词
    await inputPrompt(processedPrompt);
    await randomDelay(settings.successDelay);

    // 5. 点击生成按钮
    await clickGenerateButton();
    console.log('[Runway Queue] 已点击生成按钮');

    return { success: true };
  } catch (error) {
    console.error('[Runway Queue] 任务处理失败:', error);
    return { success: false, error: error.message };
  }
}

// 主循环
async function mainLoop() {
  // 每次轮询都重新读取 storage 状态
  await loadStateFromStorage();

  console.log('[Runway Queue] mainLoop, isRunning:', isRunning, 'queueLength:', queue.length, 'currentIndex:', currentIndex);

  if (!isRunning) {
    console.log('[Runway Queue] mainLoop: isRunning is false, returning');
    return;
  }

  if (queue.length === 0 || currentIndex >= queue.length) {
    console.log('[Runway Queue] mainLoop: queue empty or done, stopping');
    isRunning = false;
    await saveStateToStorage();
    return;
  }

  // 获取当前任务（从本地状态）
  const task = queue[currentIndex];
  if (!task) {
    console.log('[Runway Queue] mainLoop: no task at currentIndex');
    isRunning = false;
    await saveStateToStorage();
    return;
  }

  currentTask = task;
  console.log('[Runway Queue] mainLoop: got task:', task.prompt.substring(0, 30) + '...');

  // 检查是否正在生成
  if (isGenerating()) {
    console.log('[Runway Queue] 正在生成中，等待...');
    return;
  }

  // 检查是否已完成
  if (isGenerationComplete()) {
    console.log('[Runway Queue] 检测到生成完成！');
    // 更新状态
    queue[currentIndex].status = 'completed';
    currentIndex++;
    await saveStateToStorage();
    // 随机延迟后再处理下一个
    await randomDelay(settings.successDelay + Math.random() * settings.randomDelay);
    return;
  }

  // 处理新任务
  const result = await processTask(task);

  if (result.success) {
    console.log('[Runway Queue] 任务已提交，等待生成...');
    // 标记为运行中
    queue[currentIndex].status = 'running';
    await saveStateToStorage();
  } else {
    console.error('[Runway Queue] 任务提交失败:', result.error);
    queue[currentIndex].status = 'failed';
    queue[currentIndex].error = result.error;
    currentIndex++;
    await saveStateToStorage();
    // 失败后延迟重试
    await randomDelay(settings.successDelay);
  }
}

// 启动轮询
function startPolling() {
  if (checkInterval) {
    clearInterval(checkInterval);
  }

  console.log('[Runway Queue] 启动轮询，间隔:', settings.checkInterval, 'ms');
  checkInterval = setInterval(mainLoop, settings.checkInterval);
}

// 停止轮询
function stopPolling() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  console.log('[Runway Queue] 已停止轮询');
}

// 监听来自 background script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(message, sendResponse) {
  switch (message.type) {
    case 'queueUpdated':
    case 'settingsUpdated':
      // 更新本地状态
      if (message.data.settings) {
        settings = { ...settings, ...message.data.settings };
      }
      if (message.data.isRunning !== undefined) {
        isRunning = message.data.isRunning;
        if (isRunning) {
          startPolling();
        } else {
          stopPolling();
        }
      }
      sendResponse({ success: true });
      break;

    case 'getStatus':
      sendResponse({
        isRunning,
        currentTask,
        settings
      });
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
}

// 初始化
console.log('[Runway Queue] 内容脚本已加载');

// 直接从 storage 加载状态，不依赖 background
loadStateFromStorage().then(() => {
  if (isRunning && queue.length > 0 && currentIndex < queue.length) {
    console.log('[Runway Queue] Initializing: will start polling');
    startPolling();
  } else {
    console.log('[Runway Queue] Initializing: isRunning=', isRunning, 'queueLength=', queue.length);
  }
});