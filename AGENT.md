# Runway Queue Assistant - Agent Documentation

## Project Overview

A Chrome Extension that automates prompt queue submission to Runway ML's Unlimited mode. Designed for animation studios to batch-generate storyboard videos after work hours.

**Use Case**: Pre-workday: Write prompts with `@reference_images` → End of day: Start queue → Next morning: Videos are ready for editing.

**Repository**: https://github.com/lihaoalbert/runway-queue-extension

---

## Architecture

### Extension Components

| Component | File | Purpose |
|-----------|------|---------|
| **Manifest** | `manifest.json` | Extension configuration (Manifest V3) |
| **Popup UI** | `popup/popup.html`, `popup/popup.js` | User interface panel |
| **Content Script** | `content/content.js` | Runs on Runway page, handles automation |
| **Background Script** | `background/background.js` | Service Worker (state management) |
| **Icons** | `icons/icon*.png` | Extension icons (16/48/128px) |

### State Management

The extension uses `chrome.storage.local` for persistent state:

```javascript
{
  queue: [...],        // Array of tasks
  currentIndex: 0,      // Current task index
  isRunning: false,     // Queue active state
  settings: {...}       // User preferences
}
```

### How It Works

1. **Content Script** reads/writes directly to `chrome.storage.local`
2. **Popup** updates storage when user adds tasks or clicks start
3. **Content Script** polls storage every `checkInterval` ms
4. When `isRunning=true`, it processes the current task

---

## Key Features

### 1. Prompt Processing
- Detects `@reference_image` markers in prompts
- **Plain text prompts**: Uses clipboard paste (textarea + execCommand('copy')) for speed
- **Prompts with @references**: Always types character-by-character (20-50ms per char)
- **After each `@xxx`**: Waits 1 second after last char, then dispatches Enter key event to bind reference images
- **Fallback**: If clipboard fails, falls back to character-by-character typing

### 2. Duration Setting
- Automatically sets video duration before submission
- Supports: 5s, 10s, 15s, 20s

### 4. Task Lifecycle

```
pending → running → completed
           ↓
         (waiting)  → re-check next poll
```

- **pending**: Not yet submitted
- **running**: Submitted to Runway (`submittedAt` timestamp recorded), waiting for generation
- **completed**: Generation confirmed complete, advance to next
- **failed**: Error during processing, advance to next

### 5. Generation Completion Detection

`isTaskGenerationDone()` checks if a submitted task has finished:
- Minimum 30 second wait after submission (avoids false positives)
- Checks if Generate button is enabled again
- 10-minute timeout safety net (force advance)
- Relies on `task.submittedAt` timestamp set when clicking Generate

### 6. Pause/Stop Support

Pause checks interrupt processing at multiple points:
- Before `processTask` starts
- Every 3-5 characters during character-by-character typing
- Before and after the 1-second @reference wait
- After typing completes, before clicking Generate
- `inputPromptWithParts` accepts `shouldContinue` callback, returns early when paused

### 7. Configurable Delays
| Parameter | Default | Purpose |
|----------|---------|---------|
| `checkInterval` | 60s | Polling frequency |
| `successDelay` | 5s | Fixed delay after completion |
| `randomDelay` | 5s | Random additional delay |

---

## Runway Page Elements

The extension targets these Runway elements:

### Text Input
```css
[aria-label="Prompt"][contenteditable="true"]
[data-lexical-editor="true"]
```

### Generate Button
```css
button:has(svg.lucide-video)
button[class*="primaryButton"]
```

### Duration Selector
```css
button[aria-label="Duration"]
```

### Detection States
- **isGenerating**: Used before submitting a new task — checks if button is disabled while textbox has content (concurrent slots full)
- **isTaskGenerationDone**: Used after submitting — checks if generate button is re-enabled (30s min wait, 10min timeout)

---

## Configuration

### Manifest Permissions
```json
"host_permissions": [
  "https://app.runwayml.com/*",
  "https://*.runwayml.com/*"
]
```

### Content Script Matches
```json
"content_scripts": [{
  "matches": ["https://*.runwayml.com/*"],
  "js": ["content/content.js"],
  "run_at": "document_idle"
}]
```

---

## Debugging

### Enable Debug Logging
Content script logs are prefixed with `[Runway Queue]`. Check Console (F12) on the Runway page.

### Key Log Messages
```
[Runway Queue] 内容脚本已加载
[Runway Queue] 启动轮询，间隔: X ms
[Runway Queue] mainLoop, isRunning: true, status: pending/running
[Runway Queue] 有 @参考图，跳过剪贴板，直接逐字输入
[Runway Queue] 输入参考图: @xxx
[Runway Queue] 等待 1 秒后回车绑定参考图...
[Runway Queue] 已点击生成按钮
[Runway Queue] 任务已提交，检查生成是否完成...
[Runway Queue] 仍在生成中，等待...
[Runway Queue] 生成完成，推进到下一个任务
[Runway Queue] 输入被中断（已暂停）
```

### Test Commands
```javascript
// Check if content script loaded
window.__runwayQueueLoaded

// Find prompt input
document.querySelector('[aria-label="Prompt"]')

// Check storage
chrome.storage.local.get(['queue', 'isRunning', 'currentIndex'])
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Queue empty or done" immediately | Service Worker Inactive | Extension reads directly from storage now |
| Text not input | Selection/focus issue | Uses click() then focus() then execCommand |
| @ reference not binding | Typing too fast | 1s delay after @xxx, then Enter key event |
| Duplicate submissions | Empty textbox after submit | Task status 'running' check prevents re-processing |
| Clipboard write failed | Document not focused | Falls back to character-by-character typing |

---

## Development

### Install Extension
```bash
git clone https://github.com/lihaoalbert/runway-queue-extension.git
# Chrome: chrome://extensions/ → Developer mode → Load unpacked
```

### Update and Test
1. Edit source files
2. Commit: `git add -A && git commit -m "message" && git push`
3. Reload extension in Chrome

### Version
Update version in `manifest.json` (currently 1.0.0)

---

## Risk Considerations

- Runway's ToS may prohibit automation
- Excessive auto-submissions (especially overnight) may trigger anti-bot detection
- **Recommendations**:
  - Increase delays (90-120s interval, 10-15s random delay)
  - Monitor initially to detect rate limits
  - Avoid continuous overnight batching

---

## File Structure

```
runway-queue-extension/
├── manifest.json          # Extension manifest (V3)
├── AGENT.md              # This file
├── README.md             # User documentation
├── background/
│   └── background.js     # Service Worker (legacy, kept for reference)
├── content/
│   └── content.js       # Main automation logic
├── popup/
│   ├── popup.html       # UI layout
│   └── popup.js         # UI interactions
└── icons/
    ├── icon.svg         # Source icon
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Technical Notes

### Why Content Script Reads Storage Directly?
Chrome's Service Worker can go "Inactive" (sleep) when not actively messaging. Since MV3 requires Service Workers (not persistent background pages), the extension was refactored to have content script read/write `chrome.storage.local` directly, bypassing the Service Worker for state.

### @Reference Image Binding
Runway's editor uses a Lexical-based rich text editor. The key to binding reference images is:
1. Type the prompt character by character (clipboard paste doesn't trigger binding)
2. Prompts with @references skip clipboard and always use char-by-char typing
3. After typing the last char of each `@xxx` reference, wait 1 second
4. Then dispatch an Enter KeyboardEvent to confirm the reference binding
5. Normal text is typed at 20-50ms per char without delays

### Concurrent Slots
Unlimited mode typically has 2 concurrent generation slots. The `isGenerating()` function checks:
- Generate button disabled state
- `data-soft-disabled` attribute
- Loading/progress indicators
- Task card states (processing/queued)

---

## Contact

For issues or feature requests, open a GitHub issue at:
https://github.com/lihaoalbert/runway-queue-extension/issues
