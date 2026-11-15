# 13: 免费词典查词通道(选型与接入路径)

Type: research
Status: resolved
Blocked by: -
Blocks: 11

## Question

用户定案(2026-11-14):**单词级查词走免费接口,段落/句子翻译全部走模型**——取代此前「释义与音标由当前 Provider 顺带生成(无第二 API)」的子决策。需调研定案:

1. **接口选型**(候选,需验证存活/返回结构/限频/稳定性/ToS 风险):
   - 有道词典非官方接口(`dict.youdao.com/jsonapi` 或 `aidemo.youdao.com/trans`):英→中双语 + 美英音标 + 词性 + 多义项,最贴生词本需求;
   - dictionaryapi.dev:免费无 key,英文单语(音标/定义/例句),作双语缺失时的补充;
   - Google translate gtx `dt=bd`(词典义项):免费无 key,非官方;
   - LibreTranslate / MyMemory:纯 MT,只给词译文,无词典信息(兜底候选,优先级低)。
2. **回落链**:推荐 有道 → dictionaryapi.dev → 当前 Provider 兜底(可关,设置页 S 已画「单词查词:免费词典 → 模型兜底」);Ollama-only 离线用户联网缺失时直接回落本地模型。
3. **Rust 侧接入**:reqwest 直连(与工单 04 Provider 层并存,无 key、不走前端 plugin-http);查词非流式,普通 invoke + 事件即可,无需 Channel 流式。
4. **数据模型增补**(对工单 08 的修订):新表 `dict_cache(word UNIQUE, payload, fetched_at)` 词查缓存(命中即不再请求);`vocab_entries` 增 `phonetic`、`source(dict|model|manual)` 字段;例句仍取自所在块(vocab_examples 不变)。
5. **与 P1 划词的边界**:单词 → 查词通道;多词短语/句子 → 模型管线。

## Resolution

- **定案接口链**(全部 curl 实测):`dict_cache` 命中 → 有道 `dict.youdao.com/jsonapi`(存活、无 UA/Referer 校验、130~370ms、30+ 连发无限频;生僻词仅回 `web_trans` 空壳即 miss 信号)→ `dictionaryapi.dev`(无 key、英文单语、0.6~2.8s、404=未收录)→ 当前 LLM Provider 兜底(可关)。**Google gtx 剔除**(国内直连 TCP 不通,实测 75s/10s 超时);**aidemo.youdao.com/trans 剔除**(纯 MT 无词典信息,连发 4~5 次即 411 限频)。
- **payload/失效策略**:存解析后归一化 JSON(约 1~3KB,含 `schema_version/source/phonetic/senses/web_trans/examples`),不存原始 JSON(有道常用词原始返回 614KB);正常命中永不过期,`schema_version` 变更触发懒迁移,`source:"miss"` negative 缓存 24h TTL。
- **Rust 接入要点**:独立 `reqwest::Client`,`timeout(8s) + connect_timeout(3s) + gzip(true)`(两端点均回 gzip);UA 实测不校验但仍设固定 UA 保险;`Semaphore(4)` + in-flight HashMap 去重;任何网络错误映射为该级 miss 直落下一级(保证 Ollama 离线用户秒级落到本地模型,缓存离线可用)。

详见 `research/13-free-dict-lookup.md`。
