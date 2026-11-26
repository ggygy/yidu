# 译读(app)— P0 实现

spec 定稿(2026-11-14)后的真实现,位于 `.scratch/md-translator/app/`。v3 视觉与交互沿用 `proto/`(交互基准),mock 全部替换为 Rust 侧真实现。

## 状态:M1 + M2 完成,M3 主体完成(2026-11-15)

### M1(2026-11-14)

| 能力 | 状态 |
|---|---|
| `<s>/<t>` 协议管线(切块→组批→流式→校验修复→逐块上屏) | ✅ 真实跑通(DeepSeek) |
| 快捷窗:⌥T(Rust 侧注册)/pin/失焦互斥/粘贴即译/剪贴板预填/对照(⌘D 双栏)/复制 | ✅ |
| 翻译自动入库 + 主窗三视图阅读(react-markdown + 点词)+ ⌘N 全键盘流 | ✅ |
| SQLite 十表(schema 版本化迁移)/ Provider 四件套 / 1-token 测试 / tray / window-state 禁可见性恢复 | ✅ |

### M2(2026-11-15)

| 能力 | 状态 |
|---|---|
| 词典查词链:有道 jsonapi → dictionaryapi.dev → Provider 兜底(可关);归一化卡片缓存(命中永不过期)+ miss 负缓存 24h;connect_timeout(3s)+Semaphore(4) | ✅ 真网络 2/2(`cargo test -- --ignored`) |
| 真 VocabCard(音标/义项/网络释义/词典例句/本文例句/有道发音 URL/加入生词本) | ✅ |
| 生词本落库(词元去重 + 例句 ≤5)+ 生词本面板(展开例句/删除) | ✅ |
| 术语库:CRUD 面板 + system prompt 注入 + **译后全词替换**(大小写不敏感、子串不误伤)+ 块级 chip 标记(blocks.terms,migration v2) | ✅(替换逻辑单测 3 条) |
| 断点续译 UI:pending 时 meta 条「▶ 续译 N 块」+ ⌘R;续译=取消旧会话+只译未完成块 | ✅ |
| 成本估算:手填单价(¥/1M tokens)→ 设置页用量+成本显示 | ✅ |
| 设置增强:单词查词兜底开关、⌘, 打开设置 | ✅ |

### M3 部分(2026-11-15)

| 能力 | 状态 |
|---|---|
| 暗色跨窗同步(theme-changed 事件,隐藏快捷窗即时跟随)+ ⌘L 全局切换 | ✅ |
| 首启引导:无 provider 时自动弹出设置面板 | ✅ |
| Ollama 实装:/api/chat NDJSON 流式 + 显式 num_ctx(extra JSON)+ /api/tags 健康检查 | ✅ 代码+单测(**未实机验证**,本机无 Ollama) |
| 打包:`npm run tauri build` 出 .app | ✅ |
| Ollama 模型发现/拉取进度 UI、P1 划词/OCR/SRS | ⬜ 后续 |

**GUI 五项验证已全部补齐(2026-11-15 上午,解锁后实测)**:术语 chip(命中块挂「术语库」徽标)、⌘R 续译(注错→恢复→续译全链路)、⌘L 暗色跨窗同步、⌘, 设置面板成本估算、tray 图标(菜单栏深色圆角块+双横条)。详见下方实测记录。

**三个验证期发现的缺口已修复并实测(同日)**:
1. **主窗翻译取消入口**:`busy` 状态 + meta 行「■ 取消(Esc)」按钮;**翻译中 Esc = 取消会话**(非翻译时 Esc 仍关层)。实测:60 段长文 2.5s 后 Esc → 停在 10/61 且不再推进 → ⌘R 续完 61/61。
2. **apply_terms 跳过代码 span/围栏**:`split_code_spans` 按「n 个反引号开、恰好 n 个反引号闭」切分,代码段原样保留、不替换;同术语跨段命中去重。新增 3 条单测(行内/围栏/未闭合),共 42 条。实测:`` `rust` ``、`` `cargo --version` `` 译后原样保留,span 外正常替换,`rustc` 不被子串误伤。
3. **翻译失败持久错误横幅**:`streamErr` 状态,doc-head 下红色横幅(点击关闭),新翻译自动清除;附「可 ⌘R 续译」提示。实测:坏 base_url 失败后横幅持久显示(注意连接错误要走完修复梯度重试才发 Error,约 10s+,勿过早截图)。
4. 顺带:**续译前先取消旧会话**(防旧会话迟到的 Error 事件误伤新会话的 busy/横幅状态);⌘R 闭包 bug 修复见踩坑 8。

**遗留(非阻断)**:①Keychain 保存路径未做 release 实测(dev 走环境变量是设计如此);②旧会话错误事件的 session 级过滤未做(取消已大幅收窄窗口,但极端时序下旧 Error 仍可能到达);③取消时若恰在修复梯度中,横幅文案会复用「本批 N 块经修复仍未完成」略欠精确。

## 开发

```bash
cd .scratch/md-translator/app
npm install
# dev 模式 key 经环境变量注入(不碰 Keychain,原因见下):
YIDU_DEV_PROVIDER_KEY=<你的 key> npm run tauri dev
cargo test                     # 39 个单测
cargo test -- --ignored        # 词典真链路 2 个(需网络)
npx tsc --noEmit               # 前端类型检查
```

- vite 端口 **1430**(proto 占 1420,两者可并行)。
- 改 quick 窗代码后需重启 dev(隐藏 webview 收不到 HMR)。
- 应用图标:`node scripts/make-icon.mjs && npx tauri icon app-icon.png`。
- 长时间自动化验证时建议 `caffeinate -dis` 防锁屏中断。

## 软件内更新与发布流程

- **机制**:tauri-plugin-updater + minisign 签名;endpoint 指向 GitHub Releases(`ggygy/yidu`)的 `latest.json`;安装后 relaunch(process 插件)。启动时静默检查(有新版仅 toast),设置面板「关于与更新」可手动 检查→下载→安装→重启。
- **密钥**:私钥在 `~/.tauri/yidu.key`(权限 600,空密码,**绝不入库,丢失即无法再发更新**);公钥已写入 `tauri.conf.json` 的 `plugins.updater.pubkey`。生产建议换带密码的密钥并妥善保管。
- **发版步骤**:

```bash
# 1. 升版本号(tauri.conf.json 的 version)
# 2. 带签名构建(产物在 target/release/bundle/macos/)
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/yidu.key npm run tauri build
# 3. 建 Release 并上传(gh):
gh release create v0.x.y target/release/bundle/macos/译读.app.tar.gz target/release/bundle/macos/译读.app.tar.gz.sig
# 4. 手写 latest.json 上传到同一 Release(参考 tauri 文档字段:version/pubnotes(可省)/platforms.darwin-aarch64.signature/url)
```

- **自动化(已配)**:`.github/workflows/release.yml`(方案移植自 ai-trainer-platform 实测过的 CI)。Actions 页**手动运行 = 快照预发布**(tag 形如 `v0.1.0-日期-sha`,不被 updater 命中,可随时试跑流水线);**推送 `v*` 标签 = 正式发布**(`--latest`,应用内更新即拉到它)。macOS 双架构(aarch64 + x64,同一 arm64 runner 交叉编译),产物改名 `yidu_*`(GitHub assets 不支持中文),统一在 publish job 汇合后建 Release:dmg ×2 + `.app.tar.gz`+sig ×2 + `latest.json` + `checksums.txt`。
- **Secrets 状态(2026-11-15,6/7 已配)**:✅ `APPLE_CERTIFICATE`(Developer ID p12 的 base64,自钥匙串新导,含 1 有效身份 Developer ID Application + 1 过期 Apple Development,无害)、✅ `APPLE_CERTIFICATE_PASSWORD`、✅ `APPLE_SIGNING_IDENTITY`(`Developer ID Application: zhou wangjun (2VS7ZAN44A)`)、✅ `APPLE_TEAM_ID`(`2VS7ZAN44A`)、✅ `APPLE_ID`(1820909770@qq.com,若 Apple ID 登录邮箱不是这个请改)、✅ `TAURI_SIGNING_PRIVATE_KEY`。**仅剩 1 步**:[appleid.apple.com](https://appleid.apple.com) → 登录与安全 → App 专用密码 → 生成,`gh secret set APPLE_PASSWORD -R ggygy/yidu`(配齐前勿跑 CI——签名已激活但公证缺凭据会失败)。
  - 配齐后自动 Developer ID 签名+公证,CI 内置 `codesign/spctl/stapler` 校验;若想临时回退未签名构建,删除 `APPLE_CERTIFICATE` secret 即可。
- 注意:私有仓的 Release 资产匿名下载 404,updater 检查会失败——对外分发时转公开仓,或自托管 latest.json(改 `plugins.updater.endpoints` 即可);仅自用无妨(手动下载 dmg 安装)。

## v0.4:划词 / 截图 / 替换

| 能力 | 入口 | 说明 |
|---|---|---|
| 划词翻译 | ⌥D(可改 / 可停用) | 辅助功能 API 取 `AXSelectedText`;取不到(Electron 等)→ 模拟 ⌘C 并原样还原剪贴板。单个英文词 → 词典卡,其余 → 模型 |
| 截图翻译 | ⌥S、托盘菜单 | macOS `screencapture -i` 写临时文件;Windows 截图工具 + 监视剪贴板。识别后立即翻译 |
| 粘贴图片 | 快捷窗 ⌘V | 剪贴板里只有图片时走 OCR(文本与图片并存取文本) |
| 翻译并替换 | ⌥R | 不出窗口:译完确认前台仍是原应用 → 粘贴覆盖选区;方向恒按自动规则。托盘标题「译…」是唯一进度提示 |
| OCR 引擎 | 设置 → 快捷窗 | 本机(macOS Vision / Windows.Media.Ocr,离线)或多模态模型(转写成 markdown 再翻译,失败回落本机) |

- **不自动入库**:三个热键触发的翻译建的是 `articles.ephemeral=1` 的临时文章(管线依赖块表),不进文章库列表;快捷窗「存入文章库」转正,否则 24h 后启动时清理。粘贴(文本 / 图片)仍自动入库。
- **权限(仅 macOS)**:划词 / 替换要「辅助功能」,截图要「屏幕录制」。首次使用时快捷窗内引导,设置页显示状态。dev 下授权对象是 `target/debug/yidu`(或启动它的终端),与正式包分开授权。
- **Vision 绑定**:crates.io 不可达时拿不到 `objc2-vision`,改为 `objc2` 的 `msg_send!` 直调(调研 12 的备选路径),见 `ocr.rs`。真引擎冒烟:`YIDU_OCR_SAMPLE=<图片> cargo test -- --ignored ocr_sample --nocapture`。
- **Windows**:本机无法编译验证,见 [`docs/windows-test-checklist.md`](../docs/windows-test-checklist.md)。
- 新模块:`flow.rs`(热键流程编排)/ `selection.rs` / `capture.rs` / `ocr.rs` / `permissions.rs`;前端 `vocabcard.tsx`(主窗与快捷窗共用查词卡)。

## v0.4:生词复习

- 入口:生词本面板「复习(N 个待复习)」、托盘菜单「复习生词」。全屏卡片:空格揭示,1 忘了 / 2 模糊 / 3 记得,Esc 结束;例句在揭示前把目标词挖空。
- 调度 `srs.rs`(纯函数,SM-2 变体):记得 = 1 天 → 3 天 → ×ease;模糊 = ×1.2 且 ease −0.15;忘了 = 10 分钟后重学、ease −0.20(下限 1.3);间隔上限 365 天。
- 新词第二天到期;每 24 小时(滚动窗口,不依赖时区)最多引入 20 个新词。migration v11:`review_state.introduced_at` + 为既有生词补建状态(立即到期,仍受上限约束)。
- 不发通知;托盘菜单的待复习数在评分 / 删词后及每 10 分钟刷新。

## 快捷键

全局:⌥T 快捷窗 · ⌥D 划词翻译 · ⌥S 截图翻译 · ⌥R 翻译并替换(均可在 设置 → 快捷窗 改键;后三个可停用)。


主窗:⌘N 新建 · ⌘K 文章库 · ⌘R 续译 · ⌘L 亮暗 · ⌘, 设置 · **1/2/3/4 切视图(对照/分栏/纯译文/纯净)** · Esc 取消翻译/关层;快捷窗:⌥T 唤出(可改)· ⌘D 对照 · ⌘↩ 翻译 · Esc 取消。

**纯净模式(视图 4)**:纯译文静态渲染,无点词/术语/chip/目录交互,文本可自由选择复制;所有视图下拖选文本不会误弹查词卡。

**阅读外观自定义(设置 → 阅读外观)**:阅读背景(跟随主题/护眼米黄/OLED 纯黑/自定义取色,深底自动配浅字)、正文字体(衬线/无衬线/楷体/等宽)、字号 14-20px、行距 1.5-2.2、段间距 4-24px、页宽 640-1000px、强调色五色;全部即时预览,localStorage 持久化,「恢复默认」一键还原。

**多语言与自定义提示词(设置 → 翻译)**:默认方向为任意源→目标组合(内置 8 语:中/英/日/韩/法/德/西/俄,或「其他…」输入任意语言名);「翻译提示词」可整体替换默认风格段(默认英文,支持 `{from}`/`{to}` 占位),`<s>/<t>` 标签协议与方向指令由应用自动附加、不可移除,保证翻译管线稳定。

## 跨平台(Windows)

- CI 产物:`yidu_<版本>_x64-setup.exe`(NSIS);未做 Windows 代码签名,首次运行 SmartScreen 弹「Windows 已保护你的电脑」→ 点「更多信息 → 仍要运行」。
- 快捷键映射:macOS 的 ⌘/⌥ 在 Windows 对应 Ctrl/Alt(默认呼出快捷键 Alt+T,可改)。
- 窗口:Windows 用系统原生标题栏(红绿灯 Overlay 仅 macOS);API Key 走 Windows 凭据管理器(keyring windows-native),其余行为一致。
- 应用内更新三平台通用(latest.json 含 darwin-aarch64 / darwin-x86_64 / windows-x86_64)。

## 架构(Rust 侧)

```
src-tauri/src/
├─ lib.rs       装配:window-state(!VISIBLE)+ global-shortcut + clipboard + tray + 命令注册
├─ db.rs        SQLite 十表 + 版本化迁移(v2:blocks.terms);文章/块/Provider/用量/偏好/词典缓存/生词/术语
├─ keychain.rs  keyring 封装 + dev 环境变量后备(effective_key)
├─ blocks.rs    pulldown-cmark 字节区间切块;纯文本天然按空行分块;sha256 规范化哈希
├─ batch.rs     组批 3~10 块/约 2000 字符(CJK→非 CJK 目标 ÷1.6)
├─ prompt.rs    英文三段(风格段可被 prefs.custom_prompt 替换 + 协议段恒附加 + 术语段)/userMsg;方向编码 A2B(~名 = 自定义语言)
├─ sse.rs       SSE 行解析 + `</t>` 状态机(标签跨 chunk 安全)+ partial 预览
├─ validate.rs  id 序列/标签外文本/URL 集合/围栏数 + 重排补救
├─ dict.rs      词典链(有道→dictapi→Provider)+ 归一化卡片 + 缓存;真链路集成测试
├─ providers/   trait(mpsc 流式)+ openai.rs + ollama.rs(NDJSON + num_ctx)
├─ translate.rs 管线编排 + 修复梯度 + 术语译后替换(apply_terms);会话取消;断点续译
└─ commands.rs  invoke 命令面(24 个)
```

前端:`src/main.tsx`(主窗)+ `src/quick/main.tsx`(快捷窗)+ `src/md.tsx`(共享 md 渲染/点词)+ `src/api.ts`(invoke/Channel 封装)。

## 实测记录

### 2026-11-14(M1)

- 快捷窗链路:剪贴板预填 → ⌥T 唤出自动预填并翻译 → 4 块全 done、URL 保留;usage 294+70 tokens / 1471ms;文章自动入库。
- 主窗链路:⌘N → ⌘V → ⌘↩ 全键盘 → 阅读视图双语对照、代码块直通、进度满格。
- 重启:文章/provider 持久、快捷窗不自动显示;key 泄漏扫描干净。

### 2026-11-15(M2/M3)

- 词典真链路:hydration 命中有道(义项+例句)、webview 走网络释义回落;二次查询命中缓存(集成测试 2/2)。
- migration v2 对既有库自动升级(user_version 2,blocks.terms 列就位)。
- 术语替换:全词/大小写不敏感/webview 不被 web 误伤(3 条单测)。
- `tauri build` 产出 release .app。
- key 泄漏扫描:零 `sk-`、无 .env。
- **GUI 实测(上午)**:①术语链路——prompt 注入有效(hydration→水合、webview→网页视图模型直接照译);译后强制替换用代码 span 里的 `` `rust` `` 触发命中,blocks.terms 落库 `[["rust","铁锈语言"]]`,阅读视图命中块挂「术语库」chip;WKWebView 未被子串误伤。②⌘R 续译——坏 base_url 注错→3 块 pending 持久→恢复 URL→⌘R 2 秒内 3/3 完成;**顺带修掉 ⌘R 空依赖闭包冻结 doc 的真 bug**(resumeRef 转发)。③⌘L 暗色:主窗+隐藏快捷窗唤出后即时同步。④⌘, 设置:用量 21 次 · 12.1K tokens,成本估算 ≈¥0.024(单价 ¥2/1M,数字自洽)。⑤tray 图标菜单栏可见。
- **缺口修复实测(同日)**:Esc 取消长文停 10/61 不再推进→⌘R 续完;坏 URL 失败横幅 15s 后仍持久显示且取消按钮消失、续译按钮出现;代码 span `` `rust` ``/`` `cargo --version` `` 译后原样保留、span 外替换正常、rustc 不误伤;42 单测 + tsc + vite build 全绿。

## 本轮踩坑(重要教训)

1. **Keychain ACL 在 dev 下是雷区**:他进程建的项、甚至同路径二进制对已有项的 SecItemUpdate 都会弹授权框,并卡死 spawn_blocking/同步 command(整窗白屏)。对策:dev 走 `YIDU_DEV_PROVIDER_KEY`(`keychain::effective_key`),Keychain 只留 release;孤儿 SecurityAgent 弹框 `kill -9` 清掉。
2. **同步 command 里不要做 Keychain/网络**:`provider_list` 等一律 async + `spawn_blocking`。
3. **osascript 发 ⌥T**:`keystroke "t" using option down` 生效,`key code 11` 不生效;`System Events click at` 报 -25208 不可用,UI 验证走键盘可达路径。
4. tauri dev 的 Rust watcher 自动重编重启;排查「新代码没生效」先 `stat` 二进制 mtime。
5. 并发集成测试不要共享同一 SQLite 文件(database is locked)——每个测试独立临时目录。
6. 过夜自动化会被锁屏打断;长会话先 `caffeinate -dis`。
7. **sqlite3 `json_set` 对不存在的行是静默 0 行操作**——种子 prefs 要用 `INSERT OR REPLACE` 整行写,别假设行已存在(本轮成本估算显示空就是踩的这个)。
8. React 空依赖 `useEffect` 里调用依赖 state 的函数 = 闭包冻结首帧(⌘R 曾因此静默无效);键盘处理器经 ref 转发最新函数,⌘L 读 DOM dataset 同理。
