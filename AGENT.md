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
- Types character-by-character (20-50ms per char)
- **Presses Enter after each `@xxx`** to bind reference images

### 2. Duration Setting
- Automatically sets video duration before submission
- Supports: 5s, 10s, 15s, 20s

### 3. Configurable Delays
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
- **isGenerating**: Button disabled, spinner visible, video loading, task cards showing "processing"
- **isGenerationComplete**: Transition from generating to idle

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
[Runway Queue] mainLoop, isRunning: true
[Runway Queue] 检测到参考图，输入回车
[Runway Queue] 已点击生成按钮
[Runway Queue] 正在生成中，等待...
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
| @ reference not binding | Timing issue | Types char-by-char with Enter after @xxx |
| Duplicate submissions | isGenerating() not detecting | Enhanced detection checks button disabled state |

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
1. Type the prompt character by character
2. After each `@xxx` reference, press Enter
3. The editor interprets Enter as "confirm reference and move to next"

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
