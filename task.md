---
kind: task
last_updated: '2026-07-28T01:34:41+00:00'
last_verified: '2026-07-28T01:34:41+00:00'
last_writer: hand-off
last_agent: hermes
session_id: hermes-default
---

# Task

## 已完成

- [x] Settings UI 开关：设置 → 图片描述 → "下载远程图片到本地"
- [x] normalizeMultimodalConfig()：旧配置缺字段时补全默认值
- [x] ingest.ts 传 captionLlm（修复 VLM 配置被主 LLM 覆盖）
- [x] 通用浏览器 Header（替换微信特判）
- [x] Caption prompt 重构：软指导 5 维 + 纯文本单段落 + 无推测 + 长度软目标
- [x] outputLanguage 语言跟随链路：wiki-store → ingest → localizer → captionImage
- [x] vision-caption.test.ts 回归守卫更新 + 负向断言
- [x] Code review 第 4 轮：CAPTION_PROMPT 矛盾修复（格式/推测/旧 JSDoc）
- [x] Code review 第 4 轮：localizerRan 标志修复 cache-hit 图片丢失
- [x] Code review 第 4 轮：元数据嵌入集成测试（readFileAsBase64 默认 mock + 正向断言）
- [x] Code review 第 4 轮：splitCaptionIntoAltAndTitle JSDoc 对齐
- [x] Code review 第 4 轮：IRB padding 注释精确化
- [x] Code review 第 4 轮：buildIngestHashInput trade-off 注释
- [x] PR.md 更新为真实现状
- [x] 169/169 相关测试通过
- [x] npm run typecheck 通过
- [x] npm run build 通过

## 待做（下一轮）

- [ ] 提交本轮 17 个文件的改动（建议拆 2-3 个 commit）
- [ ] npm run tauri build 重新编译二进制
- [ ] 删除 test-wiki ingest 缓存，重新 ingest 两个中文 md 文件验证
- [ ] 验证 caption 输出语言是否跟随 Wiki 设置
- [ ] 验证微信图片在通用 Header 下的下载结果
- [ ] 产品决策：localizeMarkdownImages 默认值 true vs false（H2，见 questions.md）
