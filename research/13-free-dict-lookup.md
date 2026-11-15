# 调研 13:免费词典查词通道(接口实测与选型定案)

> 工单:`issues/13-free-dict-lookup.md` · 状态:resolved · 日期:2026-11-14
> 产品前提:Tauri 2 Markdown 翻译器(macOS arm64,Rust 后端,BYOK LLM 做段落翻译)。用户定案:单词级查词走免费词典接口,段落/句子翻译全部走模型。
> 实测环境:macOS 27.0.1 arm64,curl 8.7.1,国内网络直连(无系统代理、无环境代理,`scutil --proxy` 全部关闭)。

---

## 一、结论先行

### 定案回落链(对工单 13 候选链的修正)

```
dict_cache 命中 → 有道 jsonapi(英汉双义+音标+词性)
              → dictionaryapi.dev(英文单语,音标/定义/例句,有道 miss 时补)
              → 当前 LLM Provider 兜底(可关,设置页开关)
```

与原候选链的差异(均由实测驱动):

1. **有道 jsonapi 存活且无 UA/Referer/限频校验,确认可任主接口**——130~370ms 低延迟,英汉双语义项 + 美英音标 + 词性 + 双语例句 + 词形变化,最贴生词本需求。原链成立。
2. **Google gtx `dt=bd` 从默认链中剔除**:本机(国内直连、无代理)对 `translate.googleapis.com` 与 `translate.google.com` 均 TCP 建连超时(10s/75s 无响应),目标用户网络直连不可用,且为非官方端点。仅当用户配了代理才可能可达——不值得为它加"第三条腿",其词典义项质量也不如有道。
3. **aidemo.youdao.com/trans 剔除**(实测):纯 MT 接口(只回 `translation: ["你好"]`,无音标/词性/义项),与 LLM 兜底能力重复;且限频极紧(连发 4~5 次即 411「请求频率过快」,约 20s 恢复)。参数还大小写敏感(`from=EN` 报 102)。
4. **MyMemory 剔除**:可用但延迟 2.1s、纯 MT、匿名日限(约 5000 词/日),同上与 LLM 兜底重复。
5. **有道智云 openapi(官方付费)列为"设置项可选项",不入默认链**:新用户 50 元体验金后按量计费,需注册 + appKey + 签名,与"免费无 key 免注册"的通道目标冲突;好处是完全合规,未来可作为高级设置里的用户自配选项(同 BYOK 思路)。

### payload 存什么:存**解析后的归一化结构**,不存原始 JSON

有道 jsonapi 对常用词返回 **614KB**(内含 oxford/webster/collins/词源/视频等十几类节点,查词只需要其中 `ec` 等两三个),存原始 JSON 会让缓存库迅速膨胀,且每次展示都要重复解析。定案:`payload` 存归一化后的精简 JSON(见第四节),建议额外带 `schema_version` 以便解析器升级时失效重建。

### Ollama 纯离线用户行为确认成立

离线时两个词典接口都是**快速网络错误**(reqwest connect_timeout 3~5s 内返回,DNS/连接失败即刻报错,不会挂 75s——curl 那是没设超时的默认行为),链路自然落到本地 Ollama Provider 出词义;`dict_cache` 是本地 SQLite,命中即出,**离线词典缓存可用**。描述成立,前提是把超时设好(见第五节)。

---

## 二、实测记录

### 2.1 有道 jsonapi(定案主接口)

端点:`GET https://dict.youdao.com/jsonapi?q=<word>`

**存活 / UA 校验**(三种 UA 响应 md5 完全一致 `34e403da…`,无 UA/Referer 校验):

```bash
curl -sS -o yd_curlua.json    -w '%{http_code} %{time_total}s %{size_download}B\n' \
  'https://dict.youdao.com/jsonapi?q=webview'                        # curl 默认 UA → 200 0.146s 6397B
curl -sS -o yd_browserua.json -w '…' -H 'User-Agent: Mozilla/5.0 …Chrome/130…' '<同URL>'  # 200 0.134s 6397B
curl -sS -o yd_noua.json      -w '…' -H 'User-Agent:' '<同URL>'      # 空 UA → 200 0.130s 6397B
```

**响应大小分档**(对缓存设计关键):

| 查询词 | HTTP | 延迟 | 大小 | 顶层节点 |
|---|---|---|---|---|
| `webview`(生僻技术词) | 200 | 0.13~0.15s | 6.4KB | `web_trans, blng_sents_part, typos, meta`(**无 `ec`**) |
| `take`(常用词) | 200 | 0.37s | **614KB** | 34 个节点(ec/oxford/webster/collins/ee/etym/phrs/…) |
| `look up`(短语) | 200 | 0.14s | 18.9KB | 有 `ec`,义项为中文 |
| `翻译`(中文词,中→英) | 200 | 0.15s | 18.7KB | `ce, ce_new, newhh` 等中英节点 |
| `zzxqv`(不存在) | 200 | 0.14s | **149B** | 仅 `input, lang, le, meta` |

**关键字段路径摘录**(英→中,以 `take` 为例):

```text
.ec.word[0].usphone / .ukphone                  # 音标 IPA:"teɪk"
.ec.word[0].usspeech / .ukspeech                # 发音参数 "take&type=2|1" → 拼 dictvoice URL
.ec.word[0]."return-phrase".l.i                 # 词头 "take"(string 或数组)
.ec.word[0].trs[].tr[].l.i[]                    # 义项,词性内嵌在串首: "v. 携带，拿走；…"
.ec.word[0].wfs[].wf.{name,value}               # 词形变化(第三人称单数/过去式…)
.ec.exam_type[]                                 # 考试标签(中考/考研…)
.web_trans."web-translation"[0].trans[].value   # 网络释义(生僻词回落): "网络视图" "网页视图"
.blng_sents_part."sentence-pair"[].sentence / .sentence-translation   # 双语例句
.phrs.phrs[].phr.headword_l.i / .trs[].tr.l.i   # 常用词组
.meta.isHasSimpleDict == "0" && dicts==["meta"] # 未收录信号(非错误码,HTTP 仍 200)
# 中→英(查中文词): .ce_new.word[0].phone(拼音) / .trs[].tr[].l.i[]
```

发音 URL 独立可用(生词本发音播放可直接用,无需另接 TTS):

```bash
curl -o /dev/null -sD - 'https://dict.youdao.com/dictvoice?type=0&audio=webview'
# HTTP/1.1 200 · Content-Type: audio/mpeg · 16320B · 0.165s   (type=0 英音/1 美音…type 与 ukspeech 参数对应)
```

**限频**:30+ 个不同词零间隔连发 + 同词连发,全部 200、130~270ms,无限频迹象(个人级生词查询远够用;仍建议客户端并发≤4 + 缓存,不做爬虫式压力)。

**协议细节**:`Content-Type: application/json;charset=utf-8`;支持 gzip(6397B→1736B),reqwest 需开 gzip;短词返回内嵌 `typos` 拼写建议。

### 2.2 dictionaryapi.dev(定案第二级)

端点:`GET https://api.dictionaryapi.dev/api/v2/entries/en/<word>`,无 key。

```bash
curl -sS -o dictapi.json -w '…' 'https://api.dictionaryapi.dev/api/v2/entries/en/webview'
# HTTP 404 · 1.03s · {"title":"No Definitions Found","message":"Sorry pal, …"}   ← 未收录=404+JSON,即 miss 信号
curl -sS -o dictapi_hello.json -w '…' 'https://api.dictionaryapi.dev/api/v2/entries/en/hello'
# HTTP 200 · 0.78s · 2007B
```

**关键字段路径摘录**(顶层是数组):

```text
[0].word                                       # "hello"
[0].phonetic                                   # 顶层简版 IPA(可空)
[0].phonetics[].text                           # IPA 列表: "/həˈləʊ/" "/həˈloʊ/"(英/美混排)
[0].phonetics[].audio                          # 发音 mp3 直链
[0].meanings[].partOfSpeech                    # "noun" / "verb" / "interjection"
[0].meanings[].definitions[].definition        # 英文释义
[0].meanings[].definitions[].example           # 英文例句(可空)
[0].meanings[].synonyms[] / antonyms[]         # 同反义词
```

**延迟采样(10 连发)**:0.61 ~ 2.81s,均值约 1.2s——海外源站国内直连,明显慢于有道,但无限频。**英文单语**(释义是英文),定位是"有道没收录时的音标/释义补充 + 英文学习向信息",不是双语主力。

### 2.3 Google translate gtx(剔除,实测不可达)

```bash
curl -sS -m 10 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=bd&dj=1&q=webview'
# curl: (28) Failed to connect … port 443 after 75016 ms    ← 首测 75s 全超时
curl -sS -m 10 'https://translate.google.com/translate_a/single?…'   # (28) Connection timed out after 10004ms
curl -sS -m 10 'https://translate.googleapis.com/translate_a/single?…' # (28) 复测同上,TCP 层即不通
```

本机无任何代理(`scutil --proxy` 全 0,env 无 `*_PROXY`),这是国内直连用户的真实默认网络。结论:**默认链里不能有它**;有代理的用户走 LLM Provider(自带代理生态)也更稳,没必要单独照顾 gtx。

### 2.4 aidemo.youdao.com/trans(剔除:纯 MT + 严限频)

```bash
curl -sS -X POST 'https://aidemo.youdao.com/trans' -d 'q=hello&from=en&to=zh-CHS' -H 'Content-Type: application/x-www-form-urlencoded'
# 200 → {"translation":["你好"],"errorCode":"0","mTerminalDict":{"url":"https://m.youdao.com/…"},…}
#   只回整句译文,无音标/词性/义项;响应里还带 AIGC 水印大对象(噪声)
curl -sS -X POST 'https://aidemo.youdao.com/trans' -d 'q=hello&from=EN&to=ZH-CHS'   # {"errorCode":"102"} ← 大小写敏感
curl -sS -X POST 'https://aidemo.youdao.com/trans' -d 'q=hello'                      # {"msg":"请求频率过快","errorCode":411}
```

连发 4~5 次即 411,约 20s 后恢复。它是有道智云官网 demo 页的内嵌端点(响应里 `tSpeakUrl` 挂着官方 demo appKey),既非官方公开 API、能力又被 LLM 兜底覆盖,**不入链**。

### 2.5 其他补充候选

- **MyMemory** `api.mymemory.translated.net/get?q=webview&langpair=en|zh-CN`:200,2.14s,`responseData.translatedText:"网页视图"`,纯 MT + 匿名日限,剔除。
- **有道智云 openapi(官方)**:注册赠 50 元体验金、之后按量计费,需 appKey+secret+sha256 签名(官方文档 ai.youdao.com)。文本翻译 API,不是词典结构;作为合规逃生舱可进"高级设置:自带有道 key",P0 不做。
- **LibreTranslate 公共实例**:纯 MT、公共实例限频且不稳定,与 LLM 兜底重复,剔除。

---

## 三、回落链判定逻辑(实测依据)

```
查词(word)
 ├─ dict_cache 命中(含 negative 缓存且未过期)→ 直接返回
 ├─ 有道 jsonapi:HTTP 200 且 (ec 存在 或 web_trans 存在)
 │    ├─ ec 存在 → 完整卡片(音标+词性义项+例句)
 │    └─ 仅 web_trans(生僻词如 webview)→ 网络释义卡片 + 可并发打 dictionaryapi.dev 补音标
 ├─ miss 信号:仅 meta 空壳(isHasSimpleDict=="0")或网络错误 → 下一级
 ├─ dictionaryapi.dev:200 → 单语卡片(IPA+英文释义);404/网络错误 → 下一级
 └─ LLM Provider 兜底(设置可关):提示词让模型出「音标/词性/中文义项」结构化 JSON
      ├─ 在线 BYOK(DeepSeek/GLM/中转)→ 正常
      └─ Ollama 纯离线 → 词典接口快速连接失败后自然落到本地模型,行为与描述一致
```

未收录词的 negative 缓存也写入 `dict_cache`(`source:"miss"`、短 TTL),避免用户反复点同一个查不到的词打接口。

## 四、dict_cache 表设计确认与失效策略

工单草案 `dict_cache(word TEXT UNIQUE, payload TEXT, fetched_at INTEGER)` **结构成立,补两点**:

1. **payload 存解析后的归一化结构**(定案),不存原始 JSON:
   - 原始 JSON 体量失控:常用词 614KB/词,100 个生词即 60MB 级;解析后的卡片约 1~3KB(截断例句数量,如义项≤8、例句≤4、网络释义≤5)。
   - 归一化 schema(建议):`{"schema_version":1, "source":"youdao|dictapi|model|miss", "phonetic":{"us":"…","uk":"…"}, "senses":[{"pos":"v","gloss":"…"}], "web_trans":["…"], "examples":[{"en":"…","zh":"…"}], "audio":"dictvoice URL 或 dictapi mp3"}`。
   - 解析在 Rust 侧做一次(serde_json Value 走路径,顶层节点按需取 `ec/web_trans/blng_sents_part/phrs`,其余丢弃)。
2. **失效策略:词典内容近乎不可变,不做时间过期;以"命中即不再请求"为主(工单 08 原案),辅以两个失效通道**:
   - `schema_version` 不匹配(解析器升级/字段调整)→ 整表视为失效,懒迁移(读到旧版本重新请求并覆写)。
   - 唯一例外是 `source:"miss"` 的 negative 记录,给短 TTL(建议 24h,查询时比对 `fetched_at`),因为生僻词将来可能被有道收录。
   - `fetched_at` 保留为诊断字段(何时抓的),不参与正常命中判断。

## 五、Rust reqwest 接入要点

- **Client 复用**:全局一个 `reqwest::Client`(带连接池),builder `.timeout(Duration::from_secs(8)).connect_timeout(Duration::from_secs(3)).gzip(true)`(两端点都回 gzip,不开则 614KB 裸传)。与工单 04 Provider 层的 Client 可以共用构建方式但建议**独立实例**,便于单独加代理/超时策略。
- **UA**:实测无校验,curl 默认 UA 与空 UA 都 200。仍建议设置固定 UA(如 `md-translator/1.0`)+ 可选 `Referer: https://dict.youdao.com/`,降低将来被针对性收紧的概率,属于零成本保险。
- **超时必须显式设置**:离线场景下 DNS/连接失败虽快,但一旦遇到黑洞路由(本次 gtx 实测 75s)默认配置会挂满内核超时;`connect_timeout(3s)` 保证 Ollama 离线用户在秒级内落到本地模型。
- **并发与去重**:查词是用户点词驱发的低频动作,但批量"预取整篇生词"时会并发。建议 `Semaphore(4)` 限并发 + `tokio::sync::Mutex<HashMap<String, SharedFuture>>` 做 in-flight 去重(同词并发只发一次),SQLite 端 `INSERT OR REPLACE` 兜住唯一约束。
- **非流式**:普通 `#[tauri::command]` invoke 同步返回结果即可,无需 Channel(与工单 13 判断一致);查词结果也可以顺手 `emit` 一个事件刷新生词本列表。
- **错误即回落**:reqwest 的任何错误(超时/连接/DNS/非 200/解析失败)都映射为「该级 miss」,进下一级,不要向用户抛词典网络错误——最后一级总会有结果(LLM 或明确的"未收录"卡片)。

## 六、ToS / 合规风险评估

| 接口 | 性质 | 风险 | 评估 |
|---|---|---|---|
| 有道 jsonapi | 有道词典网页版内部 AJAX API,被 Saladict、各类开源 CLI 逆向使用多年 | **灰度**:非公开授权接口,服务条款未授权第三方商用调用;单用户低频查询 + 本地缓存(命中即不再请求)的行为特征与网页用户一致,风险低;但无 SLA,随时可能改版/收紧(如出现签名) | 接受。需在代码层做好"主接口失效 24h 内自动降级"的开关级容错;README 注明数据来源 |
| dictionaryapi.dev | 开源项目(meetDeveloper/freeDictionaryAPI),官方定位"完全免费" | 低:公开免费无 key;但第三方源站无 SLA | 接受 |
| Google gtx | 非官方逆向端点 + 国内直连不可达(实测) | 高(可达性 + ToS 双重) | 剔除 |
| aidemo.youdao.com | 有道智云 demo 页内嵌端点,挂着官方 demo appKey | 中高:限频紧(411)、能力弱(纯 MT) | 剔除 |
| 有道智云 openapi | 官方付费 API(50 元体验金) | 无合规风险,但需注册/签名/计费 | 不入默认链,可作未来设置项 |

兜底缓冲:因为链路末端永远有 LLM Provider(含离线 Ollama),任何一个词典接口失效都不造成功能不可用——这是整条链最重要的工程保险,也是"免费灰度接口"可接受的核心理由。

## 七、遗留/建议

- 有道 jsonapi 若哪天开始要求 cookie/签名(历史上 fsearch 等端点已收紧过),降级路径已内建(dictionaryapi.dev → LLM),无需提前写适配代码。
- `vocab_entries` 增 `phonetic`(TEXT)、`source`(TEXT: dict|model|manual)两字段(工单 08 修订项),直接按本报告归一化 schema 的 `source` 枚举对齐。
- 例句取词所在块(工单 13 已定),词典接口的 `blng_sents_part` 例句只作查词卡片展示,不写 `vocab_examples`。
