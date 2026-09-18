# Transora · 扩展工程

> 这一层是**代码**。设计口径在上层 `../docs/` 与 `../preview/index.html`，
> 任何冲突以 `../docs/00-确认方案.md` 为准。

**阶段 1（v0.1.0）** 交付：配置模型 → 划词翻译 → 全文块级双语对照 的最小闭环。
**阶段 2（v0.2.0）** 交付：多模型对比（侧边栏多列并排 + 单选应用该模型译文）、
翻译历史（IndexedDB · 搜索筛选 · 导出 JSON / Markdown）、侧边栏「划词记录」Tab。

---

## 快速开始

```bash
cd extension
npm install

npm run dev        # 开发模式（HMR，产物在 dist/ 并被 watch）
npm run build      # typecheck + 构建到 dist/
npm run test:e2e   # 真实 Chromium 加载 dist/ 跑一遍主链路（见下）
```

加载到浏览器：打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 **`extension/dist`**。

> 首次安装会自动打开一次「新标签页 · 模型配置」（X5），把接口地址、API Key、模型名填进去，
> 点「测试连接」确认可用，就可以回网页翻译了。Transora 不内置模型，请求直连你自己配置的服务。

---

## 目录结构

```
extension/
├── src/
│   ├── manifest.config.ts     # manifest 声明（口径 = docs/00 §F-3）
│   ├── background/            # Service Worker：网络出口 / 消息路由 / 右键菜单 / 安装落地
│   │   ├── index.ts
│   │   ├── translate-service.ts   # 单批翻译：缓存 + 重试 + 漏段补救
│   │   └── sessions.ts            # 取消会话
│   ├── content/               # 内容脚本：对照引擎 + 注入 UI
│   │   ├── index.ts           # 入口（幂等初始化）
│   │   ├── extractor.ts       # 块级元素提取与噪声过滤
│   │   ├── injector.ts        # 译文注入 / 恢复 / 三态
│   │   ├── translator.ts      # 批次切分与并发调度
│   │   ├── actions.ts         # 所有用户意图的唯一入口
│   │   ├── selection.ts       # 划词跟随图标与触发
│   │   ├── state.ts           # 本页状态 + 事件总线
│   │   ├── styles.css         # 注入样式（走 manifest CSS 通道）
│   │   └── ui/                # FAB / 侧边栏 / 划词内容块 / 引导卡 / Toast
│   ├── pages/                 # 新标签页 SPA（模型配置 / 通用设置 / 翻译历史 / 关于）
│   ├── popup/                 # 工具栏弹窗 400×600
│   └── shared/                # 类型 / 常量 / 语言表 / 错误分类 / 存储 / LLM 客户端 / prompt
├── public/icons/              # 图标（脚本生成的占位图）
└── test/e2e/                  # 端到端冒烟：fixture + mock 模型服务 + smoke 用例
```

---

## 三条不可违背的架构约束

来自 `docs/00` 第六章阶段 0 技术验证结论，改代码时不要绕过：

1. **网络出口唯一** — 内容脚本不直接发跨域请求（会被宿主页面 CORS 拦截），
   所有模型请求都经 `background/` 发起。
2. **不接受内容脚本传入的 URL** — 内容脚本只传 `modelId` + 待译文本，
   接口地址由 Background 自己从存储里查（防伪造消息借用扩展权限）。
3. **不依赖 `document_start` / `activeTab` / `scripting`** — 这三项在 360 上可能被熔断。
   注入走静态 `content_scripts` + `run_at: document_idle`，交互走常驻内容脚本 + 消息驱动。

---

## 与 `docs/` 的三处实现差异（已在代码注释中标注）

| # | 文档口径 | 实现 | 原因 |
|---|---|---|---|
| 1 | 翻译队列整体在 Background | 批次切分与并发（3）在 Content，Background 只做**单批**调用 | MV3 Service Worker 会休眠，跨批的长会话状态放在 SW 里一旦休眠就丢，内容脚本会永久等待 |
| 2 | 队列并发上限 5（`docs/04 §4.2`） | **3**（`docs/00 §D-2` 为准） | 两处文档本来冲突，已按冻结总纲取 3 |
| 3 | 译文块插在原文块之后 | flex / grid 父级下改为**内嵌**到原文块末尾 | 否则会多出一个 flex item，把原文挤走（`docs/00 §G-3` 风险 1）。代价是「仅译文」模式只能用 `font-size: 0` 隐藏原文文字 |

---

## 端到端冒烟测试

`npm run test:e2e` 会用真实 Chromium 加载 `dist/`，并起一个本地 mock 模型服务（`test/e2e/mock-server.mjs`，
一个 OpenAI 兼容的假接口），把主链路（阶段 1 + 阶段 2）跑一遍：注入 → 未配置引导 → 配置模型 →
全文对照（含 flex 容器场景）→ 三态切换 → 侧边栏 → 划词 → 多模型对比 → 恢复原文 → Popup →
模型配置 / 通用设置 / 翻译历史（F1–F5）/ 关于。

产物：`.verify/`（截图 + `report.json`）。

需要本机有 Playwright 下过的 Chromium；也可以用 `TRANSORA_CHROME=/path/to/chrome` 指定。

单独调页面时可以直接跑 mock 服务：`npm run test:mock`，然后访问 `http://127.0.0.1:8787`，
接口地址填 `http://127.0.0.1:8787/v1`。

---

## 三端兼容性验证（`docs/00` §6.1 六条判据）

```bash
npm run test:compat                             # 用真实浏览器侧载 dist/ 跑六条判据
TRANSORA_COMPAT_ONLY=360 npm run test:compat    # 只跑某一端
```

与 `npm run test:e2e` 的分工：e2e 回答「**功能**对不对」（跑在 Playwright 自带的 Chromium 上）；
本脚本回答「**换一个浏览器还能不能跑**」——自动去 `/Applications` 找 360 / QQ，
逐个侧载 `dist/` 并断言：内核版本 ≥ Chromium 111、SW 注册、权限是否被熔断、静态注入、
Background 跨域 fetch、`onInstalled` 落地页。结果写入 `.verify/compat-report.json`，
结论表见 [`../docs/09-三端兼容性对照表.md`](../docs/09-三端兼容性对照表.md)。

> ⚠️ 默认**有头**启动（会弹窗口），且国产浏览器首次冷启动较慢（脚本已内置重试）。
> 脚本内置两条启动通道（Playwright 标准通道 → 自开远程调试端口 + CDP），后者用于应对裁掉 pipe 通道的发行版。

---

## 实施进度（按 `docs/00` 第九章取用规则）

| 阶段 | 版本 | 状态 | 内容 |
|---|---|---|---|
| 1 | v0.1.0 | ✅ 已交付 | 整页双语对照 / 恢复原文 / 划词翻译 / 对照三态 / 模型配置 / Popup / 新标签页 |
| 2 | v0.2.0 | ✅ 已交付 | 多模型对比（G6）、翻译历史 F1–F5、划词记录 Tab、连接测试、用量成本提示 |
| 3 | v1.0 候选 | ⬜ 未开工 | 见下 |

**阶段 3 未做**：
- 动态内容 / SPA 自动补翻（FR-11）
- 混合式对比（点段展开多栏）、虚拟滚动
- 快捷键自定义 UI（内置 4 组键位已可用，改键走浏览器扩展快捷键页）

**明确排除**（`docs/00` 第九章）：图片 OCR / 语音朗读 / 生词本 / 账号体系 / 云端同步 / 流式输出 / 非 OpenAI 原生格式。

## 已知限制

关闭的 Shadow DOM、跨域 iframe、canvas 与图片内文字无法翻译；
需要 Chromium 111 及以上内核（旧内核不支持 MV3）。
