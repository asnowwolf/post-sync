# Post Sync

**Post Sync** 是一个强大的命令行工具 (CLI)，旨在帮助内容创作者将本地的 Markdown 文件自动发布到微信公众号。它能够智能处理
Markdown 中的图片资源，自动生成封面，并支持增量更新，极大地简化了公众号文章的发布流程。

## ✨ 功能特性

- **Markdown 原生支持**: 解析 Markdown 内容并转换为微信公众号兼容的格式。
- **自动图片处理**:
    - 自动扫描 Markdown 中的图片链接（本地路径或网络 URL）。
    - 自动上传图片到微信公众号素材库。
    - 自动替换文章中的图片链接为微信永久链接。
- **智能封面管理**: 自动检测与 Markdown 文件同名的 `.png` 图片作为文章封面并上传。
- **增量发布**: 基于文件哈希 (Hash) 检测内容变化，仅处理有更新的文件，避免重复上传。
- **草稿箱管理**: `create` 命令将文章上传至公众号草稿箱。
- **一键发布**: `publish` 命令将已上传的草稿正式发布。
- **无需代理配置**: 内置反向代理配置，无需繁琐的网络设置即可调用微信 API。

## 🚀 快速开始

### 1. 环境要求

- Node.js >= 18.0.0
- npm 或 yarn

### 2. 安装

```bash
# 克隆仓库
git clone https://github.com/your-repo/post-sync.git
cd post-sync

# 安装依赖
npm install

# 编译项目
npm run build
```

### 3. 配置

在项目根目录下创建一个 `.env` 文件，并配置你的微信公众号凭证：

```env
WECHAT_APP_ID=your_app_id
WECHAT_APP_SECRET=your_app_secret
```

> **注意**: 请确保你的公众号是服务号或已认证的订阅号，并且拥有调用相关接口的权限。

## 📖 使用指南

工具主要包含两个核心命令：`create` 和 `publish`。

### 1. 创建草稿 (Create)

读取指定目录下的 Markdown 文件，处理图片素材，并将其作为草稿上传到微信公众号。

```bash
# 运行方式 1: 使用 npm script
npm start create ./contents/my-article.md

# 运行方式 2: 如果已全局安装或在 dist 目录下
node dist/index.js create ./contents/
```

**命令行为说明**:

- **扫描**: 递归扫描指定路径下的所有 `.md` 文件。
- **封面**: 自动查找与 `.md` 文件同名的 `.png` 文件（例如 `article.md` 对应 `article.png`
  ）作为封面。如果正文中引用了该封面图，工具会自动将其从正文中移除，避免重复显示。
- **标题**: 自动提取 Markdown 文件中的第一个一级标题 (`# 标题`) 作为公众号文章标题。
- **去重**: 首次运行会建立本地数据库记录。再次运行时，如果文件内容未发生变更（Hash 值一致），则会自动跳过。

### 2. 发布文章 (Publish)

将已经通过 `create` 命令上传到草稿箱的文章正式发布。

```bash
# 发布指定目录下的文章
npm start publish ./contents/my-article.md
```

**命令行为说明**:

- 工具会根据文件路径在本地数据库中查找对应的草稿记录。
- 只有成功执行过 `create` 且存在有效 `media_id` 的文章才能被发布。
- 发布成功后，会返回 `publish_id` 并在日志中确认。

## 📂 文件组织规范示例

建议按以下结构组织你的内容文件，以便工具能正确识别封面和内容：

```text
/contents
  ├── 001-hello-world.md       # 文章内容
  ├── 001-hello-world.png      # 对应的封面图 (必须同名且为 png)
  └── assets/
      ├── image1.jpg           # 文章内引用的其他图片
      └── image2.png
```

## 🛠️ 开发

```bash
# 运行测试
npm test

# 运行端到端测试 (E2E)
# 注意：E2E 测试会清空 .ps 目录下的数据库
npm run build && npx vitest run tests/e2e.test.ts
```

## 📄 License

MIT
