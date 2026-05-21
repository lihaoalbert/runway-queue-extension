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

// 检查已提交任务的生成是否完成
function isTaskGenerationDone() {
  const task = queue[currentIndex];
  if (!task || !task.submittedAt) {
    return false;
  }

  // 最小等待时间：至少等 30 秒再判断（避免刚提交就误判完成）
  const minWait = 30000;
  const elapsed = Date.now() - task.submittedAt;
  if (elapsed < minWait) {
    console.log('[Runway Queue] 提交后才过了', Math.round(elapsed / 1000), '秒，至少等 30 秒');
    return false;
  }

  // 1. 检查是否有正在生成中的指示器
  const generatingSelectors = [
    '[class*="generating"]',
    '[class*="Generating"]',
    '[class*="processing"]',
    '[class*="Processing"]',
    '[class*="progress"]',
    '[class*="Progress"]',
    '[class*="loading"]',
    '[class*="Loading"]',
    '[aria-label*="generating"]',
    '[aria-label*="Generating"]',
    '[role="progressbar"]',
    'svg[class*="animate-spin"]',
    'svg[class*="spinner"]',
  ];

  let generatingCount = 0;
  for (const sel of generatingSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // 只计算可见元素
        if (el.offsetParent !== null || el.getClientRects().length > 0) {
          generatingCount++;
        }
      }
    } catch (e) { /* selector might be invalid */ }
  }
  console.log('[Runway Queue] 页面可见生成中指示器:', generatingCount, '个');

  if (generatingCount > 0) {
    console.log('[Runway Queue] 仍有生成中指示器，继续等待...');
    return false;
  }

  // 2. 检查是否有完成的视频（video 标签或下载按钮）
  const completedSelectors = [
    'video',
    'video[src]',
    '[class*="VideoPlayer"]',
    '[class*="videoPlayer"]',
    'button[aria-label*="download" i]',
    'a[download]',
    '[class*="DownloadButton"]',
    '[class*="downloadButton"]',
  ];

  let completedCount = 0;
  for (const sel of completedSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      completedCount += els.length;
    } catch (e) { /* selector might be invalid */ }
  }
  console.log('[Runway Queue] 页面完成指示器:', completedCount, '个');

  if (completedCount > 0) {
    console.log('[Runway Queue] 检测到完成的视频，生成已完成');
    return true;
  }

  // 3. 检查生成按钮是否恢复可用（辅助判断）
  const generateBtn = document.querySelector('button:has(svg.lucide-video)');
  if (generateBtn && isButtonEnabled(generateBtn)) {
    console.log('[Runway Queue] Generate 按钮已恢复，生成已完成');
    return true;
  }

  const primaryBtns = document.querySelectorAll('button[class*="primaryButton"]');
  for (const btn of primaryBtns) {
    if (isButtonEnabled(btn)) {
      console.log('[Runway Queue] primaryButton 已恢复，生成已完成');
      return true;
    }
  }

  // 4. 兜底判断：超过 2 分钟且没有生成指示器，认为完成
  const softTimeout = 120000;
  if (elapsed > softTimeout && generatingCount === 0) {
    console.log('[Runway Queue] 超过 2 分钟且无生成指示器，认为完成');
    return true;
  }

  // 5. 超时保护：超过 10 分钟强制推进
  const maxTimeout = 600000;
  if (elapsed > maxTimeout) {
    console.log('[Runway Queue] 超过 10 分钟，强制推进');
    return true;
  }

  console.log('[Runway Queue] 生成尚未完成，已等待', Math.round(elapsed / 1000), '秒');
  return false;
}

// 处理单个任务
async function processTask(task) {
  console.log('[Runway Queue] 处理任务:', task.prompt.substring(0, 50) + '...');
  console.log('[Runway Queue] 测试模式:', settings.testMode ? '开启' : '关闭');

  // 开始前检查是否已被暂停
  if (!isRunning) {
    console.log('[Runway Queue] 已被暂停，取消处理');
    return { success: false, error: 'paused' };
  }

  try {
    // 1. 解析提示词，获取文本段（用于逐字输入）
    const parts = findReferenceImages(task.prompt);
    console.log('[Runway Queue] 解析到', parts.length, '个文本段');

    // 2. 等待页面加载
    await waitForElement('body', 5000);

    // 3. 逐字输入提示词（带 @参考图 回车）
    await inputPromptWithParts(parts, () => isRunning);
    await randomDelay(settings.successDelay);

    // 再次检查是否被暂停
    if (!isRunning) {
      console.log('[Runway Queue] 输入完成但已被暂停，取消提交');
      return { success: false, error: 'paused' };
    }

    // 5. 测试模式下不点击生成按钮
    if (settings.testMode) {
      console.log('[Runway Queue] 测试模式：跳过点击生成按钮');
      console.log('[Runway Queue] 请手动检查 @参考图 是否正确绑定');
      return { success: true, testMode: true };
    }

    // 6. 点击生成按钮
    await clickGenerateButton();
    console.log('[Runway Queue] 已点击生成按钮');

    // 记录提交时间，用于后续判断生成是否完成
    task.submittedAt = Date.now();

    return { success: true };
  } catch (error) {
    console.error('[Runway Queue] 任务处理失败:', error.message);
    return { success: false, error: error.message };
  }
}

// 主循环
async function mainLoop() {
  // 每次轮询都重新读取 storage 状态
  const loaded = await loadStateFromStorage();
  if (!loaded) return; // 上下文失效，停止执行

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
  console.log('[Runway Queue] mainLoop: got task:', task.prompt.substring(0, 30) + '...', 'status:', task.status);

  // 如果任务已提交（status=running），检查生成是否完成，不要重复提交
  if (task.status === 'running') {
    console.log('[Runway Queue] 任务已提交，检查生成是否完成...');
    const done = isTaskGenerationDone();
    if (done) {
      console.log('[Runway Queue] 生成完成，推进到下一个任务');
      queue[currentIndex].status = 'completed';
      queue[currentIndex].completedAt = new Date().toISOString();
      currentIndex++;
      await saveStateToStorage();
      await randomDelay(settings.successDelay + Math.random() * settings.randomDelay);
    } else {
      console.log('[Runway Queue] 仍在生成中，等待...');
    }
    return;
  }

  // 检查是否正在生成（并发槽位检查）
  if (isGenerating()) {
    console.log('[Runway Queue] 正在生成中，等待...');
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
    // 检查是否是"并发已满"错误（按钮被禁用）
    const isConcurrentFull = result.error && (
      result.error.includes('未找到可点击的生成按钮') ||
      result.error.includes('Generate button') ||
      result.error.includes('disabled')
    );

    if (isConcurrentFull) {
      // 并发已满，正常情况，等待即可
      console.log('[Runway Queue] 并发额度已满，等待中...');
      queue[currentIndex].status = 'waiting';
      await saveStateToStorage();
      // 不增加索引，不标记失败，等待下一轮检查
    } else {
      // 其他错误，标记为失败
      console.error('[Runway Queue] 任务提交失败:', result.error);
      queue[currentIndex].status = 'failed';
      queue[currentIndex].error = result.error;
      currentIndex++;
      await saveStateToStorage();
      // 失败后延迟重试
      await randomDelay(settings.successDelay);
    }
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