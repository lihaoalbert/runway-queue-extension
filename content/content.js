// Content Script: 在 Runway 页面上运行的核心自动化逻辑

let isRunning = false;
let currentTask = null;
let checkInterval = null;
let settings = {
  checkInterval: 60000,      // 检查间隔 (ms)
  successDelay: 5000,        // 成功后延迟 (ms)
  randomDelay: 5000,         // 随机延迟范围 (ms)
  maxRetries: 3,             // 最大重试次数
  defaultDuration: '15s',   // 默认时长设置
};

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

// 处理提示词：在 @参考图片 后添加回车
function processPrompt(prompt) {
  // 匹配 @filename 的模式，后面可能是空格或其他字符
  return prompt.replace(/(@\S+)(\s*)/g, (match, ref, whitespace) => {
    return ref + whitespace + '\n';
  });
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

// 向文本框输入内容
async function inputPrompt(text) {
  const promptInput = findPromptInput();

  if (!promptInput) {
    throw new Error('未找到文本输入框');
  }

  console.log('[Runway Queue] 找到输入框，准备输入...');

  // 点击输入框聚焦
  promptInput.click();
  await randomDelay(300);

  // 聚焦并清空
  promptInput.focus();

  // 模拟 Ctrl+A 全选然后删除
  const selectAll = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true });
  document.dispatchEvent(selectAll);

  // 清除现有内容 - 三种方式都试一下
  promptInput.textContent = '';
  promptInput.innerHTML = '';

  // 触发各种事件确保清空
  promptInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  promptInput.dispatchEvent(new Event('change', { bubbles: true }));

  await randomDelay(500);

  // 使用三种方式之一输入文本
  // 方式1: 直接设置 textContent
  promptInput.textContent = text;

  // 方式2: 触发 input 事件
  promptInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));

  console.log('[Runway Queue] 已输入提示词:', text.substring(0, 30) + '...');
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

// 检查是否正在生成中
function isGenerating() {
  // 检查按钮是否显示 generating 状态
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

  // 检查 loading/spinner 状态
  const spinners = document.querySelectorAll('svg[class*="spinner"], svg[class*="loader"]');
  for (const spinner of spinners) {
    if (spinner.offsetParent !== null) {
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
  if (!isRunning) {
    console.log('[Runway Queue] 队列已暂停');
    return;
  }

  // 获取当前任务
  const response = await chrome.runtime.sendMessage({ type: 'getCurrentTask' });
  const { task, index } = response;

  if (!task) {
    console.log('[Runway Queue] 队列为空或已全部完成');
    isRunning = false;
    await chrome.runtime.sendMessage({ type: 'stopQueue' });
    return;
  }

  currentTask = task;

  // 检查是否正在生成
  if (isGenerating()) {
    console.log('[Runway Queue] 正在生成中，等待...');
    return;
  }

  // 检查是否已完成
  if (isGenerationComplete()) {
    console.log('[Runway Queue] 检测到生成完成！');
    await chrome.runtime.sendMessage({ type: 'taskCompleted' });

    // 随机延迟后再处理下一个
    await randomDelay(settings.successDelay + Math.random() * settings.randomDelay);
    return;
  }

  // 处理新任务
  const result = await processTask(task);

  if (result.success) {
    console.log('[Runway Queue] 任务已提交，等待生成...');
  } else {
    console.error('[Runway Queue] 任务提交失败:', result.error);
    await chrome.runtime.sendMessage({
      type: 'taskFailed',
      data: { error: result.error }
    });

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

// 从 background 获取初始状态
chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  if (response && response.isRunning) {
    isRunning = true;
    startPolling();
  }
  if (response && response.settings) {
    settings = { ...settings, ...response.settings };
  }
});