# Runway 队列助手

一个 Chrome 扩展插件，用于自动将提示词队列提交到 Runway 生成。

## 功能特性

- 🎯 **队列管理**：批量添加提示词任务
- ⏰ **定时轮询**：每分钟自动检查并提交下一个任务
- 🖼️ **智能处理**：自动在 `@参考图片` 后添加回车
- ⏳ **可调延迟**：可配置检查间隔和随机延迟，降低被检测风险
- 📊 **状态显示**：实时显示队列进度和任务状态

## 安装步骤

### 1. 生成图标（可选）

插件需要一个 `icons/icon128.png` 文件。你可以使用以下任一方式：

**方式 A：在线转换**
1. 打开 https://cloudconvert.com/svg-to-png
2. 上传 `icons/icon.svg`
3. 输出 128x128 PNG
4. 保存为 `icons/icon128.png`

**方式 B：使用预览应用**
1. macOS: 用 Preview 打开 `icons/icon.svg`，导出为 PNG
2. Windows: 用 Edge 打开 `icons/icon.svg`，右键另存为 PNG

**方式 C：使用在线工具**
1. 访问 https://www.iloveimg.com/resize-image/resize-svg
2. 上传 SVG 并调整尺寸为 128x128
3. 下载 PNG 并命名为 `icon128.png`

### 2. 加载插件到 Chrome

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `runway-queue-extension` 文件夹

### 3. 开始使用

1. 打开 Runway 网站并登录
2. 点击 Chrome 工具栏的插件图标
3. 在弹出的面板中添加提示词
4. 点击「开始」按钮

## 使用说明

### 添加提示词

在文本框中输入提示词，支持 `@文件名` 语法引用图片。

示例输入：
```
A cute cartoon crayfish, @body.png @face.png @accessories.png in a magical forest
```

处理后会自动转换为：
```
A cute cartoon crayfish,

@body.png

@face.png

@accessories.png

 in a magical forest
```

### 参数设置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 检查间隔 | 60 秒 | 轮询检查生成状态的间隔 |
| 成功后延迟 | 5 秒 | 每次任务完成后的固定延迟 |
| 随机延迟 | 5 秒 | 额外的随机延迟范围 |

### 降低风险建议

1. **增加延迟**：将检查间隔设为 90-120 秒，随机延迟设为 10-15 秒
2. **避开深夜**：如果担心凌晨大量请求，可以设置定时任务在工作日白天运行
3. **观察日志**：打开 Chrome 开发者工具 (F12) → Console 查看运行日志

## 文件结构

```
runway-queue-extension/
├── manifest.json      # 插件配置
├── background/
│   └── background.js   # 后台脚本：管理队列状态
├── content/
│   └── content.js      # 内容脚本：在 Runway 页面执行自动化
├── popup/
│   ├── popup.html      # 插件面板界面
│   └── popup.js        # 面板交互逻辑
└── icons/
    ├── icon.svg       # 矢量图标
    ├── icon16.png     # 16x16 图标
    ├── icon48.png     # 48x48 图标
    └── icon128.png    # 128x128 图标
```

## 工作原理

1. **后台脚本 (background.js)**：存储队列数据，响应 UI 操作
2. **内容脚本 (content.js)**：注入到 Runway 页面，检测输入框和按钮，执行自动化操作
3. **弹出面板 (popup)**：用户界面，管理队列和设置

## 注意事项

⚠️ 本插件仅供学习和研究使用

- Runway 的服务条款可能禁止自动化操作
- 频繁的自动化请求可能被检测或限制
- 请合理使用，遵守平台规则
- 建议先测试 1-2 条任务，观察是否有异常