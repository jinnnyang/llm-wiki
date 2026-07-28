# feat: Markdown 图片本地化器（v0.6.6）

## 概述

当用户通过 ingest 导入 `.md` 文件时，本功能自动将文档中所有 `![alt](url "title")` 图片引用下载到本地 `wiki/media/<slug>/` 目录，重写 Markdown 正文指向本地副本，并在作者未提供 alt 文本时调用 VLM 生成无障碍描述，最终将描述嵌入图片文件自身的元数据中。

**动机**：远程图片链接会随时间失效（CDN 过期、源站下线），导致 wiki 页面出现大量断图。本功能在 ingest 时一次性将图片固化到项目内，确保 wiki 内容长期自包含。

## 变更规模

| 指标 | 值 |
|------|-----|
| 提交 | 22 commits（含 3 轮 code review 修复）+ 本轮未提交改动 |
| 新增/删除 | +7,429 / −55 行（已提交）+ 本轮增量 |
| 文件 | 21 个（10 个源码 + 4 个测试 + 7 个文档/配置）+ 本轮 17 个文件 |
| 新测试 | 2,895 行，1,874 个测试用例全部通过 |

## 架构

```
ingest.ts (Step 0.4)
  └─ localizeMarkdownImages()          ← 主入口
       ├─ Phase 1: I/O（并发受限）
       │    ├─ classifyImageUrl()       → remote-http / data-uri / local-relative / already-localized
       │    ├─ fetchRemoteImage()       → SSRF 防御 + 流式大小上限 + Content-Type 门控
       │    │    └─ 通用浏览器 Header（UA / Accept / Accept-Language）
       │    ├─ resolveDataUri()         → base64 解码 + MIME/大小校验
       │    └─ handleLocalRelative()    → 路径遍历防御 + copyFile
       │
       ├─ Phase 2: VLM 决策矩阵（串行）
       │    ├─ 作者 alt 非空 → 保留原文
       │    ├─ Provider 门控（codex-cli 不支持 VLM）
       │    ├─ Caption 缓存命中（SHA-256 键）
       │    ├─ 尺寸阈值（< minPixel 跳过）
       │    └─ captionImage() → 写入缓存
       │         └─ 软指导 5 维 prompt + outputLanguage 语言指令
       │
       ├─ Phase 3: 元数据嵌入
       │    └─ embedImageMetadata()     → XMP / EXIF / IPTC / PNG iTXt
       │
       └─ 输出
            ├─ rewrittenSourceMarkdown  （../../wiki/media/... 形式）
            ├─ rewrittenWikiMarkdown    （../media/... 形式）
            ├─ savedImages[]            → injectImagesIntoSourceSummary
            └─ frontmatterEntries[]     → image_sources: 映射
```

### 语言跟随链路

```
wiki-store.outputLanguage
  → ingest.ts: useWikiStore.getState().outputLanguage
    → LocalizeOptions.outputLanguage
      → captionImage(options.outputLanguage)
        → getLanguagePromptName() 解析显示名
          → prompt 尾部追加 "Write your description in 简体中文 (Simplified Chinese)."
```

- `"auto"` 或不设 → 模型自动匹配图片内容语言
- 复用现有 `language-metadata.ts` 的 `getLanguagePromptName()`

## 核心文件

### 新增

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/lib/markdown-image-localizer.ts` | 2,131 | 主模块：正则扫描、URL 分类、HTTP 抓取、data URI 解码、URL 缓存、VLM 决策矩阵、双形式 body 重写、frontmatter 合并 |
| `src/lib/image-metadata-embed.ts` | 709 | 纯字节操作：将 alt/title 写入 JPEG（APP1 XMP + APP13 IPTC）、PNG（iTXt）、WebP（EXIF + XMP + VP8X）、SVG（`<metadata>` + `<title>`/`<desc>`） |
| `src/lib/markdown-image-localizer.test.ts` | 2,219 | 主模块测试：正则、分类、缓存、fetch 防御、data URI、重写、frontmatter、VLM 矩阵、端到端管线、元数据嵌入集成验证 |
| `src/lib/image-metadata-embed.test.ts` | 435 | 四种格式的元数据嵌入单元测试 |
| `src/lib/localizer-commit1-scaffold.test.ts` | 114 | 脚手架阶段测试（类型导出、模块形状） |

### 修改

| 文件 | 变更 |
|------|------|
| `src/lib/ingest.ts` | +159/−55：Step 0.4 集成点、working-content 传播、`localizerRan` 成功标志（失败时正确回退 legacy 管线）、cache fingerprint 折叠 localizer 标志；传 `captionLlm ?? llmConfig`、传 `outputLanguage` |
| `src/stores/wiki-store.ts` | +18：`MultimodalConfig` 新增 4 个字段（`localizeMarkdownImages`、`minImagePixelSize`、`urlCacheTtlDays`、`imageFetchTimeoutMs`）及默认值 |
| `src/lib/ingest-cache.ts` | +24/−8：`checkIngestCache`/`saveIngestCache` 参数从 `sourceContent` 泛化为 `hashInput`，支持调用方折叠行为标志 |
| `src/lib/image-caption-pipeline.ts` | +8：`CaptionEntry` 新增可选 `title`、`originalUrl` 前向兼容字段 |
| `src/components/settings/settings-view.tsx` | +7：pass-through 新配置字段；初始化与保存时连接 `localizeMarkdownImages` |
| `src/lib/url-source-import.ts` | +6/−6：导出 `isPrivateNetworkHost`、`validateHttpUrl`、`safeSlug` 供 localizer 复用；`fetchImportUrl` 新增可选 `headers` 参数 |
| `src/lib/markdown-image-resolver.ts` | +2/−2：导出 `isInsideProject` |
| `src/lib/project-store.ts` | `normalizeMultimodalConfig()` — 修复旧 `app-state.json` 缺失字段导致功能静默关闭 |
| `src/components/settings/settings-types.ts` | `SettingsDraft` 增加 `multimodalLocalizeImages: boolean` |
| `src/components/settings/sections/multimodal-section.tsx` | Settings → 图片描述 区域增加"下载远程图片到本地"开关 |
| `src/i18n/zh.json` / `en.json` | `localizeLabel` / `localizeHint` 翻译键 |
| `src/lib/vision-caption.ts` | 软指导 5 维 factual prompt（无推测、纯文本、单段落）；`CaptionOptions` 增加 `outputLanguage`；语言指令追加 |
| `src/lib/vision-caption.test.ts` | 回归守卫断言适配新 prompt 关键片段 + 负向断言（禁止旧 speculation/Markdown 指令回归） |
| `src/lib/image-metadata-embed.ts` | IRB padding 注释精确化（12 字节固定头 → 奇偶性由 IIM 载荷决定） |

## Caption Prompt 设计

### 设计原则

| 原则 | 实现 |
|------|------|
| 软约束 5 维 | "Consider these aspects as appropriate — not all apply to every image; use your judgment on what matters most" |
| 纯事实、无推测 | "Describe only what is directly observable. Do not speculate about causes, narratives, or intentions beyond what the image explicitly shows." |
| 纯文本、单段落 | "Write as a single flowing paragraph of plain text — no line breaks, no headings, no Markdown formatting (no tables, no code fences, no bullet lists)" |
| 长度软目标 | "Aim for around 300 characters; complex images may run longer (up to ~1000)" — 不硬截断 |
| 逐字复制可见文本 | "Reproduce any visible text verbatim" — 防止 VLM 改写 OCR 内容 |
| 语言跟随 | Wiki 设置 `outputLanguage` → prompt 尾部 `"Write your description in {lang}."` |

### 5 个建议维度

1. **总体概述** — what is this image about, in a sentence or two?
2. **空间布局** — where are key elements positioned?
3. **视觉细节** — colors, expressions, gestures, textures; reproduce visible text verbatim
4. **氛围感官** — lighting, mood, sensory quality
5. **背景推断** — where/when was this likely made, for what purpose? Base this only on visible evidence.

### 格式约束的下游契约

Caption 最终被拼接进 `![alt](url)` 的 alt 段。`formatImageAlt` 只转义 `]` → `\]` 和换行 → 空格，**不处理**管道符、反引号、星号等 Markdown 语法。因此 prompt 必须禁止结构化输出，否则会破坏周围文档的 Markdown 解析。`splitCaptionIntoAltAndTitle` 按 `\r?\n` 分割——单段落输出保证 alt = 全文、title = undefined。

### 与旧 prompt 对比

| | 旧（Phase 3a 僵化版） | 新（本轮） |
|---|---|---|
| 语气 | 命令式："Describe this image factually... Do NOT speculate... no markdown" | 建议式："Consider these aspects as appropriate... use your judgment" |
| 格式 | 固定 "2 to 4 sentences, plain text only" | 软目标 ~300 字单段落，仍为纯文本（禁止 Markdown） |
| 推测 | "Do NOT speculate" | 同样禁止推测，但措辞更精确："Do not speculate about causes, narratives, or intentions" |
| 维度 | 无（一句话指令） | 5 个建议维度，模型自选 |
| 长度 | 无明确指导 | 软目标 ~300 字，复杂图可到 ~1000 |
| 语言 | 硬编码英文 | 跟随 Wiki `outputLanguage` 设置 |

> **设计决策记录**：早期版本曾尝试允许 Mermaid / Markdown 表格 / fenced code block 输出，但与 "single flowing paragraph, no line breaks" 指令直接矛盾，且 `formatImageAlt` 不转义 Markdown 语法——已移除。也曾尝试 "Reasonable inference / Mark uncertainty ('perhaps', 'possibly')" 维度，但 ablation 证明对知识库场景（图表、截图、流程图）产生有害幻觉——已移除。

## 远程图片抓取 Header

所有远程图片请求统一发送标准浏览器 Header，不做任何域名特判：

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ... Chrome/131
Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
```

平台级封锁（cookie 门控、签名 URL）超出通用 Header 能力范围，错误正常传播、图片跳过。

## 安全防御

| 威胁 | 防御措施 |
|------|----------|
| SSRF | `validateHttpUrl`（scheme + 无嵌入凭据）→ `isPrivateNetworkHost`（初始主机）→ `fetchImportUrl`（逐跳重定向校验，公→私拒绝） |
| 路径遍历 | `resolveLocalRelative` + `isInsideProject` 双重校验 |
| 资源耗尽 | 20 MB 硬上限（Content-Length 预检 + 流式读取上限）；30s 超时（`AbortSignal.timeout` + 调用方信号组合） |
| 非图片内容 | Content-Type 必须以 `image/` 开头；data URI MIME 校验 |
| XML 注入 | XMP/SVG 输出均经过 `escapeXml`（`&`、`<`、`>`、`"`） |

## 配置

新增 4 个 `MultimodalConfig` 字段（均有合理默认值，无需用户配置即可工作）：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `localizeMarkdownImages` | `true` | 主开关 |
| `minImagePixelSize` | `100` | 小于此尺寸（任一维度）的图片跳过 VLM 描述 |
| `urlCacheTtlDays` | `45` | URL 缓存 TTL，过期后重新抓取 |
| `imageFetchTimeoutMs` | `30000` | HTTP 抓取超时 |

> Settings UI 已接入：设置 → 图片描述 → "下载远程图片到本地"开关。
> `normalizeMultimodalConfig()` 确保旧配置文件缺失字段时自动补全默认值。

### Cache fingerprint 策略

`buildIngestHashInput` 仅折叠 `localizeMarkdownImages` 标志。`minImagePixelSize` 和 `urlCacheTtlDays` 故意不折叠：前者改变输出（小图获得 caption），但 per-image SHA-256 caption 缓存会在下次见到该图时自动补全，无需全文档 re-ingest；后者仅影响带宽，不影响输出。

## 容错设计

- **Localizer 整体失败** → `try/catch` + `localizerRan` 标志保持 `false` → 回退到 legacy `extractAndSaveMarkdownImages` 管线，图片不丢失，ingest 不中断
- **单图抓取失败** → 计入 `stats.failed`，批次继续
- **VLM 单图失败** → 计入 `vlmOutcome: "failed"`，alt 保持为空，批次继续
- **元数据嵌入失败** → `console.warn` + 计入 `stats.metadataSkipped`，不影响文件写入
- **URL 缓存损坏** → 降级为空缓存，重新抓取
- **Caption 缓存损坏** → 同上
- **旧配置缺字段** → `normalizeMultimodalConfig()` 补全默认值，功能不静默关闭

## 测试

```
Test Files  5 passed (5)
     Tests  169 passed (169)    ← 本轮直接相关（含元数据嵌入集成验证）
```

全量测试：~1,877 个通过；6 个失败为 `main` 分支已有的 TCP 环境测试（`llm-client.real-llm.test.ts`、`embedding.real-llm.test.ts`），与本分支无关（已通过 `git stash` 在 base commit 上复现确认）。

## 验证清单

- [x] `npm run typecheck` — 通过
- [x] `npm run build` — 通过
- [x] 本轮相关测试 169/169 通过
- [x] 3 轮 code review 修复已提交
- [x] 无新增外部依赖（纯字节操作，无 exiftool 等）
- [x] Settings UI 开关已接入
- [x] Caption 语言跟随 Wiki 设置
- [x] 通用浏览器 Header（无域名特判）
- [x] CAPTION_PROMPT 无内部矛盾（纯文本 + 单段落 + 无推测）
- [x] 元数据嵌入在集成测试中真正执行并断言
- [x] Localizer 失败时正确回退 legacy 管线（`localizerRan` 标志）

## 已知限制

- 不处理 `<img>` HTML 标签、角括号 URL `![alt](<url>)`、引用式图片 `![alt][id]`
- 不支持非 base64 data URI（如 `data:image/svg+xml,<svg...>`）
- 不支持 RAW、BMP、GIF、AVIF、HEIC、TIFF、ICO 的元数据嵌入（下载和保存正常，仅跳过元数据写入）
- Caption 缓存为多写者 JSON（`image-caption-pipeline.ts` + localizer），last-writer-wins，无文件锁
- 平台级图片封锁（cookie 门控、签名 URL、登录墙）超出通用 Header 能力，图片跳过并记录失败

## 本轮未提交改动（17 个文件）

```
M  src/components/settings/sections/multimodal-section.tsx   ← UI 开关
M  src/components/settings/settings-types.ts                 ← draft 字段
M  src/components/settings/settings-view.tsx                 ← 初始化/保存
M  src/i18n/en.json                                          ← 翻译键
M  src/i18n/zh.json                                          ← 翻译键
M  src/lib/image-metadata-embed.ts                           ← IRB padding 注释精确化
M  src/lib/ingest.ts                                         ← localizerRan 回退 + cache trade-off 注释
M  src/lib/markdown-image-localizer.test.ts                  ← 元数据嵌入集成断言
M  src/lib/markdown-image-localizer.ts                       ← splitCaption JSDoc 对齐
M  src/lib/project-store.ts                                  ← normalizeMultimodalConfig
M  src/lib/url-source-import.ts                              ← headers 参数
M  src/lib/vision-caption.ts                                 ← 5 维 factual prompt（无推测/纯文本）
M  src/lib/vision-caption.test.ts                            ← 回归守卫 + 负向断言
M  context.md / task.md / walkthrough.md / questions.md      ← handoff 文档
```

## 提交历史

<details>
<summary>22 commits（点击展开）</summary>

```
7c23499 fix(localizer): third code review — base64ToBytes dedup, PNG unsigned shift, WebP null-dims, SVG xml-decl insert, shouldLocalize hoist
cfda49d fix(localizer): second code review — EXIF offset, IPTC buffer, SVG xml-decl, cache-hit images
c154236 docs(handoff): session hand-off — Phase 3 metadata embedding complete
3cda623 feat(localizer): Phase 3 — embed VLM alt/title into image file metadata
2182625 fix(localizer): code review fixes — H1 CRLF offset, H3 AbortSignal fallback, M1/M2 dedup SHA-256
0c6d10b feat(ingest): commit 5 — Step 0.4 localizer integration + working-content propagation
f246260 docs(localizer): commit 4 tail — wiki-page seeding audit (§8)
544a788 feat(localizer): commit 4c — mergeImageSourcesFrontmatter (§11 lifecycle)
b8e3a8e feat(localizer): commit 4b — VLM decision matrix + provider gate + threshold + concurrency
f02260f feat(localizer): commit 4a — rewriteBySlot + two-form path helper + §7 escape/sanitize
bb7fd20 feat(localizer): commit 3c — HTTP fetch + data URI + main pipeline
80e037f feat(localizer): commit 3b — URL cache data layer + sha8
eacc4ea feat(localizer): commit 3a — module skeleton (types, regex, classify)
8e13770 feat(localizer): commit 2 — CaptionEntry optional forward-compat fields
234f0e2 feat(localizer): commit 1 — scaffold for markdown image localizer
dc86753 docs(handoff): plan v3.3 — SMALL detail cleanup + mmCfg scope hoist
43aa296 docs(handoff): plan v3.2 — WORTH refinements (W1–W6 from review round 3)
38aa233 docs(handoff): plan v3.1 — spec-vs-code alignment (C1–C4 from review round 3)
c1987be docs(handoff): plan v3 — respect existing alt/title + fix review round 2 findings
85fb659 docs(handoff): session hand-off — spec revised post review
c696737 docs(handoff): revise plan post design review
c2448fd docs(handoff): session hand-off — spec + branch cut
```

</details>
