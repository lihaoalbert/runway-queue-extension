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
  testMode: false,           // 测试模式：不点击Generate按钮
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
    return true;
  } catch (e) {
    if (e.message && e.message.includes('Extension context invalidated')) {
      console.warn('[Runway Queue] Extension context invalidated, stopping...');
      stopPolling();
      isRunning = false;
      return false;
    }
    console.error('[Runway Queue] Error loading state:', e);
    return false;
  }
}

// 保存状态到 storage
async function saveStateToStorage() {
  try {
    await chrome.storage.local.set({ queue, currentIndex, isRunning, settings });
    return true;
  } catch (e) {
    if (e.message && e.message.includes('Extension context invalidated')) {
      console.warn('[Runway Queue] Extension context invalidated, stopping...');
      stopPolling();
      isRunning = false;
      return false;
    }
    console.error('[Runway Queue] Error saving state:', e);
    return false;
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
  // 最优先：aria-label="Prompt" 的 contenteditable div
  const promptDiv = document.querySelector('[aria-label="Prompt"][contenteditable="true"]');
  if (promptDiv) {
    console.log('[Runway Queue] 找到输入框: aria-label="Prompt"');
    return promptDiv;
  }

  // Lexical 编辑器
  const lexical = document.querySelector('[data-lexical-editor="true"]');
  if (lexical) {
    console.log('[Runway Queue] 找到输入框: data-lexical-editor');
    return lexical;
  }

  // 通用 textbox
  const textbox = document.querySelector('div[class*="textbox"][contenteditable="true"]');
  if (textbox) {
    console.log('[Runway Queue] 找到输入框: class="textbox"');
    return textbox;
  }

  console.log('[Runway Queue] 未找到输入框');
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

// 强制将光标定位到 contenteditable 元素末尾
// 解决 Windows 上 Lexical 编辑器逐字输入时光标漂移的问题
function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false); // false = 折叠到末尾
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// 向文本框输入内容（使用已解析的文本段）
// shouldContinue: 可选回调，返回 false 时中断输入
async function inputPromptWithParts(parts, shouldContinue) {
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

  // 清空现有内容 - 多种方式确保清空
  console.log('[Runway Queue] 清空输入框，当前内容:', promptInput.textContent.substring(0, 50));

  // 方式1: Ctrl+A 全选，然后 Delete
  document.execCommand('selectAll', false, null);
  await randomDelay(100);
  document.execCommand('delete', false, null);
  await randomDelay(100);

  // 方式2: 直接清空 innerHTML
  promptInput.innerHTML = '';

  // 方式3: 清空 textContent
  promptInput.textContent = '';

  // 方式4: 模拟键盘 Delete
  const deleteEvent = new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true });
  promptInput.dispatchEvent(deleteEvent);

  // 触发 input 事件
  const inputEvent = new InputEvent('input', { bubbles: true, inputType: 'deleteContent' });
  promptInput.dispatchEvent(inputEvent);

  await randomDelay(500);

  console.log('[Runway Queue] 清空后内容:', JSON.stringify(promptInput.textContent || '(空)'));

  // 逐字输入每个部分 - 使用剪贴板粘贴
  console.log('[Runway Queue] 开始输入，共', parts.length, '个部分');

  // 构建完整文本（在 @参考图 后添加换行）
  let fullText = '';
  for (const part of parts) {
    if (part.type === 'text') {
      fullText += part.content;
    } else if (part.type === 'reference') {
      fullText += part.content + '\n';
    }
  }

  console.log('[Runway Queue] 完整文本长度:', fullText.length);
  console.log('[Runway Queue] 完整文本前100字:', JSON.stringify(fullText.substring(0, 100)));

  // 方法1: 尝试使用剪贴板粘贴（仅对无 @参考图 的纯文本提示有效）
  const hasReferences = parts.some(p => p.type === 'reference');
  let clipboardSuccess = false;

  if (!hasReferences) {
    try {
      // 使用 textarea + execCommand('copy') 方式，不依赖 navigator.clipboard
      promptInput.click();
      promptInput.focus();
      await randomDelay(200);

      promptInput.innerHTML = '';
      promptInput.textContent = '';
      promptInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await randomDelay(200);

      // 通过 textarea 写入剪贴板（不需要 document focus）
      const ta = document.createElement('textarea');
      ta.value = fullText;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      console.log('[Runway Queue] 已写入剪贴板 (execCommand)');

      // 粘贴
      promptInput.focus();
      await randomDelay(100);
      document.execCommand('paste');
      console.log('[Runway Queue] 已粘贴');

      await randomDelay(500);
      const pastedLength = promptInput.textContent ? promptInput.textContent.length : 0;
      console.log('[Runway Queue] 粘贴后内容长度:', pastedLength);
      clipboardSuccess = pastedLength > 0;
    } catch (e) {
      console.log('[Runway Queue] 剪贴板方法失败:', e.message);
    }
  } else {
    console.log('[Runway Queue] 有 @参考图，跳过剪贴板，直接逐字输入');
  }

  // 方法2: 逐字符输入（@参考图 必须用此方式才能正确绑定）
  if (!clipboardSuccess) {
    if (!hasReferences) {
      console.log('[Runway Queue] 剪贴板失败，回退到逐字符输入...');
    }
    promptInput.innerHTML = '';
    promptInput.textContent = '';
    promptInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await randomDelay(200);

    promptInput.focus();
    await randomDelay(100);

    for (const part of parts) {
      // 暂停检查
      if (shouldContinue && !shouldContinue()) {
        console.log('[Runway Queue] 输入被中断（已暂停）');
        return;
      }

      if (part.type === 'text') {
        // 普通文本：逐字符输入，正常速度
        for (let i = 0; i < part.content.length; i++) {
          // 每 5 个字符检查一次暂停状态
          if (shouldContinue && i % 5 === 0 && !shouldContinue()) {
            console.log('[Runway Queue] 输入被中断（已暂停）');
            return;
          }
          document.execCommand('insertText', false, part.content[i]);
          // 每次插入后强制光标到末尾，防止 Windows 上 Lexical 光标漂移
          placeCaretAtEnd(promptInput);
          await randomDelay(20 + Math.random() * 30);
        }
      } else if (part.type === 'reference') {
        // @参考图：逐字符输入参考图名称
        const refName = part.content;
        console.log('[Runway Queue] 输入参考图:', refName);
        for (let i = 0; i < refName.length; i++) {
          if (shouldContinue && i % 3 === 0 && !shouldContinue()) {
            console.log('[Runway Queue] 输入被中断（已暂停）');
            return;
          }
          document.execCommand('insertText', false, refName[i]);
          placeCaretAtEnd(promptInput);
          await randomDelay(20 + Math.random() * 30);
        }
        // 暂停检查（1秒等待前）
        if (shouldContinue && !shouldContinue()) {
          console.log('[Runway Queue] 输入被中断（已暂停）');
          return;
        }
        // 最后一个字符后等 1 秒再回车，确保 Runway 有时间识别参考图
        console.log('[Runway Queue] 等待 1 秒后回车绑定参考图...');
        await randomDelay(1000);
        // 暂停检查（回车前）
        if (shouldContinue && !shouldContinue()) {
          console.log('[Runway Queue] 输入被中断（已暂停）');
          return;
        }
        // 派发 Enter 按键事件来绑定参考图
        promptInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
        // 回车后强制光标到末尾
        placeCaretAtEnd(promptInput);
        await randomDelay(300);
        console.log('[Runway Queue] 参考图已回车绑定:', refName);
      }
    }

    await randomDelay(500);
    console.log('[Runway Queue] 逐字符输入完成，内容长度:', promptInput.textContent ? promptInput.textContent.length : 0);
  }

  // 检查结果
  const finalContent = promptInput.textContent;
  console.log('[Runway Queue] 最终内容长度:', finalContent ? finalContent.length : 0);
  if (finalContent && finalContent.length > 0) {
    console.log('[Runway Queue] 输入成功！');
  } else {
    console.log('[Runway Queue] 输入可能失败，请手动检查');
  }
}

// 向文本框输入内容（兼容旧调用）
async function inputPrompt(text) {
  const parts = findReferenceImages(text);
  await inputPromptWithParts(parts);
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
// 核心逻辑：
// 1. 如果文本框为空，Generate 按钮禁用是正常的，不等待
// 2. 如果文本框有内容但按钮禁用，说明并发已满，等待
function isGenerating() {
  // 检查文本框是否有内容
  const promptInput = findPromptInput();
  const hasContent = promptInput && promptInput.textContent && promptInput.textContent.trim().length > 0;
  console.log('[Runway Queue] 文本框内容长度:', hasContent ? promptInput.textContent.trim().length : 0);

  // 如果文本框为空，按钮禁用是正常的，不等待
  if (!hasContent) {
    console.log('[Runway Queue] 文本框为空，按钮禁用是正常的，不等待');
    return false;
  }

  // 文本框有内容，检查按钮是否可用
  const generateBtn = document.querySelector('button:has(svg.lucide-video)');
  if (generateBtn && isButtonEnabled(generateBtn)) {
    console.log('[Runway Queue] Generate 按钮可用，不等待');
    return false;
  }

  // 检查 primaryButton 是否可用
  const primaryBtns = document.querySelectorAll('button[class*="primaryButton"]');
  for (const btn of primaryBtns) {
    if (isButtonEnabled(btn)) {
      console.log('[Runway Queue] primaryButton 可用，不等待');
      return false;
    }
  }

  // 检查任何包含 Generate 文字的可用按钮
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const text = btn.textContent.toLowerCase();
    if (text.includes('generate') && isButtonEnabled(btn)) {
      console.log('[Runway Queue] 找到可用的 Generate 按钮，不等待');
      return false;
    }
  }

  // 文本框有内容，但按钮被禁用 → 并发槽位已满
  console.log('[Runway Queue] 文本框有内容但按钮禁用，槽位已满，等待...');
  return true;
}

// 处理单个任务：输入提示词 + 点击生成
async function processTask(task) {
  console.log('[Runway Queue] 处理任务:', task.prompt.substring(0, 50) + '...');
  console.log('[Runway Queue] 测试模式:', settings.testMode ? '开启' : '关闭');

  try {
    const parts = findReferenceImages(task.prompt);
    console.log('[Runway Queue] 解析到', parts.length, '个文本段');

    await waitForElement('body', 5000);

    await inputPromptWithParts(parts, () => isRunning);
    await randomDelay(settings.successDelay);

    if (!isRunning) {
      console.log('[Runway Queue] 输入完成但已被暂停，取消提交');
      return { success: false, error: 'paused' };
    }

    if (settings.testMode) {
      console.log('[Runway Queue] 测试模式：跳过点击生成按钮');
      return { success: true, testMode: true };
    }

    await clickGenerateButton();
    console.log('[Runway Queue] 已点击生成按钮');

    return { success: true };
  } catch (error) {
    console.error('[Runway Queue] 任务处理失败:', error.message);
    return { success: false, error: error.message };
  }
}

// 主循环
async function mainLoop() {
  const loaded = await loadStateFromStorage();
  if (!loaded || !isRunning) return;

  console.log('[Runway Queue] mainLoop, queue:', queue.length,
    'pending:', queue.filter(t => t.status === 'pending').length,
    'running:', queue.filter(t => t.status === 'running').length,
    'completed:', queue.filter(t => t.status === 'completed').length);

  // Step 1: 检查是否有任务正在处理中（打字 + 点击期间）
  const runningTask = queue.find(t => t.status === 'running');
  if (runningTask) {
    console.log('[Runway Queue] 有任务正在处理中，跳过本轮');
    return;
  }

  // Step 2: 检查是否有可用槽位（Generate 按钮可用 + 文本框有内容 → 槽位已满）
  if (isGenerating()) {
    console.log('[Runway Queue] 槽位已满，等待...');
    return;
  }

  // Step 3: 找下一个待提交任务
  const nextIndex = queue.findIndex(t => t.status === 'pending');
  if (nextIndex === -1) {
    const allDone = queue.every(t => t.status === 'completed' || t.status === 'failed');
    if (allDone) {
      console.log('[Runway Queue] 所有任务已完成，停止队列');
      isRunning = false;
      await saveStateToStorage();
    } else {
      console.log('[Runway Queue] 无待提交任务，等待 running 任务完成...');
    }
    return;
  }

  // Step 4: 标记为 running 并处理（防止并发重复处理同一任务）
  const task = queue[nextIndex];
  task.status = 'running';
  currentIndex = nextIndex;
  currentTask = task;
  await saveStateToStorage();
  console.log('[Runway Queue] 开始处理任务[', currentIndex, ']:', task.prompt.substring(0, 30) + '...');

  const result = await processTask(task);

  if (result.success) {
    // 点击了 Generate 按钮 → 任务完成
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    console.log('[Runway Queue] 任务[', currentIndex, ']已完成');
  } else if (result.error === 'paused') {
    // 被暂停 → 恢复为 pending
    task.status = 'pending';
    console.log('[Runway Queue] 任务[', currentIndex, ']被暂停，恢复为 pending');
  } else {
    // 其他错误 → 标记失败
    task.status = 'failed';
    task.error = result.error;
    console.log('[Runway Queue] 任务[', currentIndex, ']失败:', result.error);
  }
  await saveStateToStorage();
}

// 启动轮询：立刻执行一次，然后定时执行
function startPolling() {
  if (checkInterval) {
    clearInterval(checkInterval);
  }
  console.log('[Runway Queue] 启动轮询，间隔:', settings.checkInterval, 'ms');
  mainLoop(); // 立即执行第一次
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