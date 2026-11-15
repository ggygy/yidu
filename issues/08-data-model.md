# 08: SQLite 数据模型定案

Type: grilling
Status: resolved
Blocked by: 02, 06

## Question

与用户 grilling + domain-modeling 定案本地 SQLite 数据模型:文章(粘贴段/文件两类)、块与译文存储(存对齐结果还是原文+译文双列)、生词本(含例句与来源文章关联)、术语库、复习状态(P1 预留表)、provider 配置(注意 key 是否入库——倾向 keychain)。同步更新 CONTEXT.md。

## Answer

经一轮 grilling(基于表结构草案)用户全部采纳(2026-11-12):

**行为决策(产品可见)**:
1. 文章库 P0 **扁平 + 搜索 + 手动置顶**;文件夹/标签不做(留 `pinned` 字段,不建标签字段)。
2. **快捷窗翻译自动保存**入文章库(paste 类型,默认开、设置可关,可搜可删);快捷窗按钮语义改为"在主窗口打开"。
3. 生词按**词元去重**,再遇到 → 遇到次数 +1、更新最近遇到;**例句累积上限 5 条**(最新在前,带来源文章/块可跳转);释义首次生成、可手改。
4. **不留译文历史版本**:每块只存最新译文("改译文存翻译记忆"本就是 P2,届时再建历史表;hash 再对齐保证未变块不重译)。
5. 术语库 P0 **全局一张表**(启用开关、命中次数;分组放 P1)。
6. 技术打包:`trans_status` 含 `streaming`(部分译文落库支撑断点续译);`usage_log` 每请求一行(供成本展示);`review_state` P0 建表不接 UI;`app_state` 存快捷窗位置/尺寸/上次方向;schema 带版本号做迁移。

**定稿表结构**:
```
articles(id, kind file|paste, title, source_path?, origin_lang, target_lang,
         block_count, done_count, pinned, created_at, updated_at, translated_at?)
blocks(id, article_id, idx, kind, src, src_hash 规范化哈希, trans,
       trans_status pending|streaming|done|error, term_applied json, updated_at)
vocab_entries(id, word, lemma, phonetic, definition, status new|learning|known,
              hit_count, last_seen_at, created_at)
vocab_examples(id, entry_id, article_id, block_id, sentence, created_at)   -- 每词条 ≤5
glossary(id, source_term, target_term, note?, enabled, hit_count, created_at, updated_at)
review_state(entry_id PK, ease, interval_days, due_at, reps, lapses, last_reviewed_at)  -- P1 预留
providers(id, kind openai|ollama, name, base_url|host, model, extra_headers json,
          tuning json, api_key_set bool, unit_price?, created_at)   -- key 只在 Keychain
usage_log(id, provider_id, model, article_id?, prompt_tokens, completion_tokens,
          est_cost, created_at)
app_state(key, value)   -- active_provider_id、快捷窗位置尺寸、onboarding_done、schema_version
```
key 不入库:`service="md-translator"`, `user=provider_id`(Keychain,07 号已定)。CONTEXT.md 无新术语,仅微调"生词本"定义补充例句累积语义。
