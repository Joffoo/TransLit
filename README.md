# TransLit 📖

[![Vite](https://img.shields.io/badge/Vite-6.x-646CFF.svg?style=flat-square&logo=vite)](https://vite.dev/)
[![React](https://img.shields.io/badge/React-19.x-61DAFB.svg?style=flat-square&logo=react)](https://react.dev/)
[![CSS](https://img.shields.io/badge/CSS-Vanilla-blue.svg?style=flat-square)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![License](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)

<div align="center">
<img src="docs/hero.webp" alt="TransLit — AI 驱动的文学翻译引擎" width="860">
</div>

* [中文版](#中文说明) | [English Version](#english-description)

---

# 中文说明

**TransLit** 是一款基于前端实现的 EPUB 电子书 AI 翻译与术语工具。它支持在浏览器中解析、翻译、校对和重新打包 EPUB 电子书，支持 BYOK (Bring Your Own Key) 直连模式，无需中转后端服务，保护书籍隐私。

应用界面采用 **Swiss Monochrome (黑白 e-ink)** 设计风格，旨在为文学翻译创作者提供专注的交互体验。

## ✍️ 博客与设计思想

关于 TransLit 的开发思考与 AI 翻译演进记录，欢迎阅读作者的相关博客：
- 📑 [TransLit：AI 翻译电子书之我见](https://joffoo.pages.dev/2026/05/02/translit-ai-translation-ebook/)
- 📑 [TransLit：AI 翻译，多人一步](https://joffoo.pages.dev/2026/05/10/translit-evolution-two-step/)

## ✨ 核心特性

- 🔌 **BYOK (Bring Your Own Key) 模式**
  - 无需搭建中转服务器，API 接口由浏览器直连调用。
  - 用户的 API Key、Base URL 等配置会缓存到浏览器的 `localStorage` 中。在点击 “Reset” 重置书籍和日志进度时，个人的 API 密钥等配置不会被清理。
- 📖 **EPUB 解析与重新打包**
  - 基于 `jszip` 库解压并解析 EPUB，提取 `content.opf` 以及 XHTML 章节内容。
  - 使用 `turndown` 库将 XHTML 转换为 Markdown 格式提供给大模型，保证格式、加粗、排版及注释等在翻译后得到保留。
- 💾 **持久化 (断点续传)**
  - 基于浏览器 `IndexedDB` 存储当前的会话状态、章节解析内容、图片资产、运行中的日志，以及生成的术语表。
  - 即使网络中断、电脑死机或页面刷新，也能断点恢复，继续之前的翻译进度。
- 🤖 **双 Pass 翻译与校对**
  - **分包处理**：自动按约 3000 字进行拆包。
  - **双 Pass 润色**：除单 Pass 翻译外，支持开启 “Proofreading (校对与润色)” 双阶段处理。结合输入的翻译上下文，产出中文译文。
- 🗂️ **术语库与一致性**
  - 抽取、记录章节中的生僻词与专有实体。
  - **一致性指令**：在系统提示词层面对齐翻译结果，减少大模型在长文翻译中的“人名/术语漂移”现象。
  - 结合后文语境清理、过滤只出现一次的术语，保证术语库的紧凑。

## 📖 电子书脚注预处理 (AI Agent 工作流)

如果您的 EPUB 书籍含有复杂的脚注（例如跨文件链接、非标准跳转或特殊排版），建议在翻译前使用配套的 AI Agent 技能进行预处理。
- **Agent 预处理技能仓库**：[translit-epub-prep](https://github.com/fengyukongzhou/translit-epub-prep)
- **洗排原理**：该技能指导 AI Agent 将跨文件的脚注抽取并挂载到对应正文段落下方，重构为标准的 EPUB3 同页脚注格式。TransLit 会将其转换为 Markdown 脚注进行翻译，翻译后保留双向跳转链接。

## 🎨 设计美学：Swiss Monochrome

项目界面参考了瑞士现代主义排版与 e-ink 电子墨水屏美学：
- **留白与黑白对比**：使用粗体无衬线等宽字体（Geist Mono）与网格线条。
- **黑白交互**：所有输入框、开关按钮、标签和控制台均由黑白两色构成。
- **Logo**：左上角使用从 `logo.png` 提取并裁剪的黑白软盘 SVG 矢量 Logo，与页面融合。

## 🛠️ 本地运行指南

### 前提条件
- 本地需要安装 [Node.js](https://nodejs.org/) (推荐 v18+)

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量 (可选)
您可以在项目根目录中复制或创建 `.env.local` 文件来预填默认 API Key：
```env
GEMINI_API_KEY=您的Gemini密钥
```
*注：在 UI 界面中输入的 Key 优先级最高，且会自动记录至 LocalStorage。*

### 3. 运行开发服务器
```bash
npm run dev
```
启动后在浏览器打开终端提示的地址（默认 `http://localhost:3000`）即可。

## 📦 项目架构简析

```
TransLit/
├── components/
│   ├── FileUpload.tsx      # 电子书拖拽上传组件
│   └── SettingsPanel.tsx   # API 与翻译策略配置面板
├── services/
│   ├── epubService.ts      # 负责 EPUB 解压、Markdown 转换与重新封包
│   ├── geminiService.ts    # API 调用，处理分包、翻译与校对流程
│   └── persistenceService.ts # IndexedDB 持久化读写服务
├── App.tsx                 # 主程序框架，控制核心状态流转与双面板布局
├── index.html              # HTML 骨架，配置全局 Geist Mono 字体与滚动条样式
├── logo.svg                # 软盘矢量 Logo
└── package.json            # 项目依赖声明
```

---

# English Description

**TransLit** is a client-side **EPUB AI translation and glossary tool for translating books into Chinese**. It supports parsing, translating, proofreading, and packaging EPUB e-books in the browser. By adopting the BYOK (Bring Your Own Key) model, it communicates with AI APIs without intermediate back-end servers, protecting privacy for your books.

The user interface implements a **Swiss Monochrome (e-ink style)** design language, providing a focused workspace.

## ✍️ Blogs & Design Philosophy

For the author's thoughts on TransLit's development and the evolution of AI translation, check out the following blog posts (in Chinese):
- 📑 [TransLit: My Take on AI Translation of E-books](https://joffoo.pages.dev/2026/05/02/translit-ai-translation-ebook/)
- 📑 [TransLit: AI Translation, One Step Ahead](https://joffoo.pages.dev/2026/05/10/translit-evolution-two-step/)

## ✨ Key Features

- 🔌 **BYOK (Bring Your Own Key) Mode**
  - No server-side setup required; API calls are sent from the browser.
  - User settings (API Key, Base URL, etc.) are cached in the browser's `localStorage`. Resetting the translation progress will not clear your API keys.
- 📖 **EPUB Parsing & Re-packaging**
  - Unzips and parses EPUB using the `jszip` library to extract XHTML chapters and metadata.
  - Converts XHTML to Markdown using `turndown` before sending it to LLMs, ensuring formatting (bold, links, lists, notes) is preserved in the translated output.
- 💾 **Persistence (Resumable Progress)**
  - Stores session states, chapter extractions, images, logs, and generated glossary terms in the browser's `IndexedDB`.
  - Resumes translation progress after network disconnections, browser crashes, or page reloads.
- 🤖 **Two-Pass Translation & Proofreading**
  - **Chunk Splitter**: Splits chapters into chunks of ~3000 words.
  - **Two-Pass Polish**: Supports an optional "Proofreading" stage following the initial translation pass to deliver Chinese translations.
- 🗂️ **Glossary & Consistency**
  - Extracts and logs rare words and proper nouns during translation.
  - **Consistency Rule**: Applies consistency rules at the system prompt level to reduce the "term drift" issue (e.g., inconsistent character names) in LLM long-context translation.
  - Evaluates terms against future text, filtering out redundant glossary records.

## 📖 EPUB Footnote Preprocessing (AI Agent Workflow)

If your EPUB book contains complex footnotes (e.g., cross-file links, non-standard redirects, or irregular typesetting), we recommend preprocessing it using our AI Agent Skill before translating.
- **Agent Preprocessing Repository**: [translit-epub-prep](https://github.com/fengyukongzhou/translit-epub-prep)
- **How it works**: The Skill instructs the AI Agent to extract cross-file footnotes and append them to the bottom of the referring chapters, restructuring them into standard EPUB3 same-page footnotes. TransLit then converts these into Markdown footnotes during translation, maintaining bidirectional jumps.

## 🎨 Design Philosophy: Swiss Monochrome

The interface references Swiss typography and e-ink aesthetics:
- **Contrast Grid Layout**: Uses bold monospace typography (Geist Mono) and border lines.
- **Binary Interaction**: All inputs, switches, badges, and consoles are rendered in black and white.
- **Logo**: Incorporates a vectorized floppy disk SVG logo, blending into the header.

## 🛠️ Local Setup Guide

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended) installed locally.

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Environment Variables (Optional)
You can create a `.env.local` file in the root directory to auto-fill your default API key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```
*Note: Keys entered in the Web UI have higher priority and are stored in LocalStorage.*

### 3. Run Development Server
```bash
npm run dev
```
Open the local URL (default: `http://localhost:3000`) shown in your terminal.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
