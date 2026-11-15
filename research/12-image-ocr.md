# 调研 12:图片粘贴 OCR(快捷窗 ⌘V 贴图直译)

> 工单:`issues/12-image-ocr-research.md` · 状态:resolved · 日期:2026-11-14
> 产品前提:Tauri 2 桌面 Markdown 翻译器(macOS arm64 优先,Rust 后端 + React 前端,BYOK LLM 翻译)。P1 范围 = 快捷翻译浮窗支持 ⌘V 粘贴截图 → macOS Vision 本地 OCR(免费、离线)→ 识别文字进入现有翻译管线;P2 的区域截图遮罩(快捷键框选)不在本工单范围。Windows 只做"不阻断"的接口预留。

---

## 一、结论先行

### 推荐方案(三层,全部零新增服务、零网络)

1. **Rust 侧直接用 `objc2-vision` 0.3.x 调 Vision 框架**,走 `VNRecognizeTextRequest` + `VNImageRequestHandler::initWithData_options` + **同步 `performRequests_error`** 路径。不引 Swift 工具链(排除 swift-rs / apple-vision),不碰 completion block 回调(排除 block2 依赖与 run loop 坑)。OCR 代码约 100 行 unsafe Rust,纯本地。
2. **剪贴板图片走前端 onPaste**:快捷窗监听 `paste` 事件,从 `clipboardData.items` 拿到 `image/*` 的 `File` → `arrayBuffer()` → `invoke('ocr_image', bytes)` 以 **raw body(octet-stream)** 传给 Rust。不用 Rust 侧 arboard / tauri-plugin-clipboard-manager 读图——它们返回的是**解码后的 RGBA 像素**而非编码图片字节,喂给 Vision 前还得重编码(或手工造 CGImage),平白多一道工序。
3. **接入点 = 现有"非 md 粘贴输入"入口,零管线改动**:Rust OCR 模块输出"归一化纯文本"(行序整理 + 去断行拼接 + 空行分段),前端把它当作用户粘贴的文本塞进快捷窗输入并触发翻译;后续空行切段 → `<s>/<t>` 协议 → Provider 流式上屏,全部复用工单 03/06 的既有管线。OCR 不碰翻译管线内部。

### 关键 crate / 依赖清单

| crate / 模块 | 用途 | 备注 |
|---|---|---|
| `objc2-vision = "0.3"`(0.3.2,2025-10-04) | Vision 框架绑定 | `VNRecognizeTextRequest` 在 default feature 里;依赖 `objc2 >=0.6.2, <0.8.0`,与最新 objc2 0.6.5(2026-10-05)兼容;madsmtm/objc2 项目自动生成、持续维护;MSRV 1.71;下载约 16.5 万/月 |
| `objc2-foundation = "0.3"` | `NSData` / `NSArray` / `NSString` / `NSDictionary` / `NSError` | 构造图片数据与语言数组;与 objc2-vision 同套版本系 |
| `objc2 = "0.6"` | 运行时(传递依赖,不必直接声明) | 除非要 `Retained` / `rc` 工具 |
| 不需要 `block2` | — | 同步 `performRequests_error` 不用 completion handler;开了 `block2` feature 反而会引入回调 API 误用面 |
| (前端)`invoke` raw body | 传图片字节 | Tauri 2 原生支持 `ArrayBuffer/Uint8Array` → `application/octet-stream`,无需 base64 |
| (P2 / 兜底)`arboard = "3"`(3.7.0,2026-10-15) | Rust 直读剪贴板图 | `get_image()` 返回 RGBA 像素 + 宽高;留给 P2"全局快捷键不聚焦窗口读剪贴板"场景 |
| (排除)`tauri-plugin-clipboard-manager`(2.5.0) | 官方剪贴板插件 | `readImage()` 同样返回 `Image`(RGBA),且要配 capability 权限;对本需求是绕路 |
| (排除)`apple-vision`(vision-rs,0.17.2) | swift-bridge 高层封装 | 引入 Swift 编译链、macOS 13+ 硬依赖、月下载仅数百;API 好看但不值得 |
| (排除)`swift-rs`(1.0.9) | 手写 Swift 桥 | 需自建 Swift 工程与构建集成,为一次 OCR 调用过重 |

### 技术路径选型对比(Rust 侧调 Vision)

| 路径 | 结论 | 理由 |
|---|---|---|
| **objc2-vision(推荐)** | ✅ | 纯 Rust 构建(只链系统 Vision 框架,无需 Xcode Swift 编译);API 是 Apple 头文件的直接映射,与 Swift 样例一一对应;objc2 系生态活跃(周级更新) |
| objc2 + 手写 `msg_send!` | 备选 | objc2-vision 就是它的生成版,手写无收益、易错,仅当需要 objc2-vision 未覆盖的新 API 时局部补 |
| swift-rs 桥接 Swift 脚本 | ❌ | 多一门语言 + 构建链;Swift 侧代码要与 Rust 类型对齐,维护双份;仅在需要 Swift-only API(如 macOS 26 的 RecognizeDocumentsRequest)时才有必要 |
| apple-vision(vision-rs) | ❌ | 基于 swift-bridge,同样要 Swift 工具链;单人小项目(2 star),bus factor 低 |
| 子进程调 `osascript` / 快捷指令 | ❌ | 进程开销 + 沙盒/权限变量 + 输出转义地狱,无任何优势 |

---

## 二、Rust 侧:objc2-vision 现状、API 形态与最小示例

### 2.1 crate 现状(2026-11 查证)

- 版本线:`0.2.2`(2024-05)→ `0.3.0`(2025-01)→ `0.3.1`(2025-04)→ **`0.3.2`(2025-10-04,最新)**。框架 crate 版本号独立于核心 `objc2`(后者 2026-10-05 发了 0.6.5 / 0.5.3),依赖范围声明为 `objc2 >=0.6.2, <0.8.0`,当前互相兼容。
- 维护:madsmtm/objc2 仓库持续活跃,绑定从 Apple SDK 接口文件自动生成,issue 有维护者答疑(见 #664);月下载 ~16.6 万,是被 tauri 生态外的 Rust/macOS 项目普遍使用的正路。
- feature:`VNRecognizeTextRequest`、`VNRequest`、`VNObservation` 等常用类在 **default features** 中,直接 `objc2-vision = "0.3"` 即可用;`block2`(回调)、`objc2-core-graphics`(CGImage)等是可选 feature。

### 2.2 API 形态(Apple → Rust 映射)

方法名与 Objective-C 选择器一致(`:` 换成 `_`),与 Swift 样例几乎逐行对应:

| Apple(Swift) | objc2-vision(Rust) | 安全性 |
|---|---|---|
| `VNRecognizeTextRequest()` | `VNRecognizeTextRequest::new()` | safe |
| `recognitionLanguages = [...]` | `setRecognitionLanguages(&NSArray<NSString>)` | safe |
| `recognitionLevel = .accurate/.fast` | `setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate/Fast)` | safe |
| `usesLanguageCorrection = true` | `setUsesLanguageCorrection(bool)` | safe |
| `automaticallyDetectsLanguage`(rev3+) | `setAutomaticallyDetectsLanguage(bool)` | safe |
| —(查询支持语言) | `supportedRecognitionLanguagesAndReturnError()` | unsafe |
| `VNImageRequestHandler(data:options:)` | `initWithData_options(alloc, &NSData, &NSDictionary)` | unsafe |
| `VNImageRequestHandler(cgImage:options:)` | `initWithCGImage_options`(需 `objc2-core-graphics` feature) | unsafe |
| `handler.performRequests([req])` | `performRequests_error(&NSArray<VNRequest>) -> Result<(), Retained<NSError>>` | safe(方法本身 safe,前置构造 unsafe) |
| `request.results` | `results() -> Option<Retained<NSArray<VNRecognizedTextObservation>>>` | safe |
| `obs.topCandidates(1)[0].string` | `topCandidates(1)` → 遍历取 `.string()` / `.confidence()` | safe |

### 2.3 最小可用代码(同步路径,可直接落库)

综合 objc2 #664 维护者给出的修复与 andelf/picc 项目的实测代码(`src/vision.rs` + `examples/local-ocr.rs`,该仓库正是"Vision 中英混排 OCR"场景):

```rust
// src-tauri/src/ocr.rs —— macOS Vision 本地 OCR(同步路径)
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
};

/// 输入:图片编码字节(PNG / JPEG / TIFF 均可,走 ImageIO 解码)
/// 输出:按阅读序排列的"行"文本列表
pub fn ocr_lines(image_bytes: &[u8]) -> Result<Vec<Line>, String> {
    // 1. 构造 request(每次调用新建,不跨线程/跨调用复用)
    let request = VNRecognizeTextRequest::new();
    // 语言顺序 = 处理优先级;中英混排把 zh-Hans 放首位(Apple 官方样例的建议)
    let zh = NSString::from_str("zh-Hans");
    let en = NSString::from_str("en-US");
    request.setRecognitionLanguages(&NSArray::from_slice(&[&*zh, &*en]));
    // recognitionLevel 默认即 Accurate;fast 档语言集合小,不保证含 zh-Hans,勿切
    // request.setUsesLanguageCorrection(false); // 语言纠正默认关;技术文本建议保持关

    // 2. 用原始字节构造 handler(截图无需先解码成 RGBA)
    let data = NSData::with_bytes(image_bytes);
    let options = NSDictionary::new();
    let handler = unsafe {
        VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        )
    };

    // 3. 同步执行:阻塞当前线程直到完成,不需要 completion block / run loop
    let requests = NSArray::from_retained_slice(&[request.clone()]);
    let requests: &NSArray<VNRequest> = unsafe { &*((&*requests) as *const _ as *const _) };
    unsafe { handler.performRequests_error(requests) }.map_err(|e| e.to_string())?;

    // 4. 取结果:每个 observation 约"一行";带归一化包围盒(原点在左下角)
    let mut lines = Vec::new();
    if let Some(results) = request.results() {
        for obs in results.iter() {
            let candidates = obs.topCandidates(1);
            for c in candidates.iter() {
                let bb = unsafe { obs.boundingBox() }; // CGRect,归一化坐标
                lines.push(Line {
                    text: c.string().to_string(),
                    x: bb.origin.x as f64,
                    mid_y: (bb.origin.y + bb.size.height / 2.0) as f64,
                    h: bb.size.height as f64,
                });
            }
        }
    }
    // 5. 排阅读序:midY 降序(y 向上)→ 同行 minX 升序
    lines.sort_by(|a, b| {
        b.mid_y.partial_cmp(&a.mid_y).unwrap()
            .then(a.x.partial_cmp(&b.x).unwrap())
    });
    Ok(lines)
}

pub struct Line { pub text: String, pub x: f64, pub mid_y: f64, pub h: f64 }
```

Tauri command 侧(接前端 raw body,OCR 放 blocking 线程池):

```rust
// 前端以 Uint8Array/ArrayBuffer 作为 invoke 第二参 → 请求体为 application/octet-stream
#[tauri::command]
async fn ocr_image(request: tauri::ipc::Request<'_>) -> Result<OcrResult, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("expected raw body (Uint8Array/ArrayBuffer)".into()),
    };
    // Vision 是同步阻塞调用(accurate 档单张截图亚秒~2 秒级),放 spawn_blocking 别卡 runtime
    let lines = tauri::async_runtime::spawn_blocking(move || ocr::ocr_lines(&bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(OcrResult { text: normalize(lines), /* 可选:保留行框给 UI 高亮 */ })
}
```

### 2.4 线程模型与已知坑

1. **走同步 `performRequests_error`,不要碰 completion handler 路径**。objc2 issue #664 的原坑:用户想用 `initWithCompletionHandler`,但 completion block 需要用 `block2::RcBlock` 手工构造、传裸指针,且 Vision 的回调经 run loop 派发——后台线程没有跑 run loop 时请求可能永远不完成(维护者原话)。同步版本 `performRequests_error` 阻塞到出结果,天然无此问题,P1 完全不需要 block2。
2. **request 必须真的放进传给 perform 的数组**(#664 用户第二个错误:传了空数组还期望有结果)。`results()` 只能在 `performRequests` 成功返回后访问(VNRequest 文档明言)。
3. **一次一建,不要共享**:每次 OCR 调用新建 `VNRecognizeTextRequest` + `VNImageRequestHandler`,在单个线程内完成构造→执行→取结果,不缓存、不并发复用(Apple 对 handler 的线程约定;顺带绕开 objc2 对象是否 `Send` 的问题)。
4. **同步调用会占住线程**:accurate 档单张截图典型亚秒到 2 秒,务必 `spawn_blocking`(或 `std::thread`),避免阻塞 tokio worker / 主线程造成 UI 卡顿。
5. **泛型数组上转**:`NSArray<VNRecognizeTextRequest>` → `NSArray<VNRequest>` 目前需一次显式 cast(picc 的写法),objc2 对 lightweight generics 不做自动 downcast/upcast,属已知工效学粗糙点。
6. **构建产物**:只链系统框架,无需嵌入模型文件;Vision 的 OCR 神经网络由系统提供(macOS 自带),**完全离线、免费、无 API 配额**。

### 2.5 识别质量:语言、档位与版本

- **recognitionLevel**:默认 `Accurate`(精度优先);`Fast` 档语言集合远小于 accurate——**zh-Hans 属于 accurate 档能力**(rev2 起),fast 档对 CJK 的支持随 OS 版本变化且不保证。翻译器场景直接用默认 accurate,单张截图的速度完全可接受。
- **recognitionLanguages = ["zh-Hans", "en-US"]**:数组顺序即语言处理优先级;Apple《Recognizing Text in Images》样例明确建议**把 zh-Hans/zh-Hant 放数组最前**来正确处理中文及中英混排。中英混排截图实测(picc 项目即此配置)效果可用。
- **版本要求**:`VNRecognizeTextRequest` 本身 macOS 10.15+;**zh-Hans 需 revision 2(macOS 11+)**;revision 3(macOS 13+,现在 Apple silicon 机型的默认 revision)新增 `automaticallyDetectsLanguage`(语言自动检测,rev3 前是 no-op)。本项目 arm64 最低即 macOS 11+,无兼容风险;**不建议**开自动检测——我们有明确的中英领域知识,显式设置语言更稳(Apple 文档同样建议有领域知识时显式设置)。
- **运行时兜底**:语言集随 OS/revision 变化,落地时用 `supportedRecognitionLanguagesAndReturnError()`(unsafe)做一次性探测 + 日志,别硬编码长列表。
- **usesLanguageCorrection**:默认 NO。语言纠正会"修"技术词(如把代码标识符纠正成单词),对翻译器输入(常含代码/术语)风险大于收益,建议保持默认关,未来做成设置项。
- **结果顺序**:observations 返回顺序**不保证阅读序**,必须按 `boundingBox` 自己排(归一化坐标、原点在**左下角**,所以"从上到下"是 midY 降序);同一行多个框再按 minX 升序。这是所有 Vision OCR 使用者的固定工序(SO 上有专门讨论)。
- **能力边界**:多栏/表格/复杂版式的阅读序重组会出错(行分组按垂直重叠切,双栏会被逐行交错);手写体、艺术字、极低分辨率识别率下降。P1 快捷窗场景(单栏截图)可接受,P2 区域截图同样复用。

---

## 三、剪贴板图片:前端 onPaste(推荐)vs Rust 直读

### 3.1 推荐路径:前端 `paste` 事件 + raw body invoke

快捷窗是获得焦点的 webview,用户按 ⌘V 时 DOM `paste` 事件天然携带剪贴板内容:

```ts
// quick window(quick.html / src/quick/main.tsx)
import { invoke } from '@tauri-apps/api/core';

window.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imgItem = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!imgItem) return;                    // 纯文本粘贴 → 走既有输入逻辑,不拦截
  e.preventDefault();
  const file = imgItem.getAsFile();        // 必须同步取出 File 引用,事件返回后 clipboardData 不可靠
  if (!file) return;
  const buf = await file.arrayBuffer();
  // raw body:整个请求体是 octet-stream,不是 JSON,无 base64 膨胀
  const result = await invoke<OcrResult>('ocr_image', new Uint8Array(buf), {
    headers: { 'content-type': file.type },  // png / tiff,交给 Rust 侧 ImageIO 处理
  });
  // 识别文本进入既有"粘贴输入"入口,触发翻译
  setInputAndTranslate(result.text);
});
```

事实依据:

- **macOS 的 WKWebView 与 Safari 同引擎**,粘贴截图时 `clipboardData.items` 会给出 `kind === 'file'`、`type` 为 `image/*` 的条目(Safari 多年行为)。反例是 Linux:WebKitGTK 曾长期不给 paste 事件图片数据(WebKit bug 218519),**2025-10 才修进 WebKitGTK 2.52.0**——本项目 macOS 优先,不受此影响;若日后做 Linux,可加 `navigator.clipboard.read()` 兜底。
- **格式勿硬编码**:截图进剪贴板是 TIFF,浏览器/WKWebView 暴露给 JS 时常见 PNG,但来源决定格式(浏览器复制图 = PNG/TIFF,设计工具可能给别的);按 `File.type` 或 magic bytes 透传即可——Vision 的 `initWithData_options` 走 ImageIO,PNG/JPEG/TIFF 通吃,不需要 Rust 侧预解码。
- **传输用 raw body**:Tauri 2 官方文档明确 `invoke` 第二参传 `ArrayBuffer/Uint8Array/number[]` 时整个请求体按 `application/octet-stream` 发送,Rust 侧 `tauri::ipc::Request` 收 `InvokeBody::Raw(Vec<u8>)`;对比 base64 进 JSON(体积 +33%、还要 JS 侧编码开销),1–3 MB 的截图明显更优。

### 3.2 为什么不用 Rust 侧直读剪贴板(P1)

| 方案 | 返回物 | 问题 |
|---|---|---|
| `arboard::Clipboard::get_image()`(3.7.0) | `ImageData { width, height, bytes: RGBA }` | **解码后的裸像素**,不是 PNG 字节;喂 Vision 要么用 `image` crate 重编码 PNG、要么 CGBitmapContext 手工造 CGImage,多一道工序与依赖 |
| `tauri-plugin-clipboard-manager` 的 `readImage()`(2.5.0) | `Image`(`rgba(): Promise<Uint8Array>` + 宽高) | 底层就是 arboard,同样返回 RGBA;还要加插件、capability 权限(`allow-read-image`);Linux 侧另有 read 挂死的 open issue |
| 前端 onPaste(推荐) | `File` → 编码字节(PNG/TIFF) | 直接是 Vision 想要的形态;用户手势语义清晰;跨平台代码路径统一 |

另一个决定性理由:**P1 交互本身就是"快捷窗获得焦点后按 ⌘V"**,paste 事件是这个交互的原生表达,不读剪贴板就不存在"读了用户没粘贴的东西"的隐私观感问题(前台、有明确手势)。Rust 直读的价值场景是 P2 的"全局快捷键呼出 + 免聚焦读剪贴板",届时再上 arboard/NSPasteboard 直读 TIFF 即可,接口按 `OcrSource` 抽象预留。

---

## 四、识别文本接入现有翻译管线

### 4.1 接入点:非 md 粘贴输入,零管线改动

工单 06 已定案"非 md 粘贴输入:空行切段为 paragraph 块走同一管线"。OCR 文本就视作一类非 md 粘贴输入:

```
快捷窗 ⌘V(图)→ invoke ocr_image(Rust Vision OCR + 文本归一化)
    → 返回纯文本 → 前端 setInputAndTranslate(text)   ← 与手工粘贴文本同一个入口
    → 既有管线:非 md 空行切段归一化 → paragraph 块 → <s>/<t> 协议批量流式翻译 → 逐块上屏
```

- **不做独立管线、不做"先整理再翻译"两步 pass**(工单 06 第 5 条明确不做,OCR 文本同样适用)。
- OCR 模块的职责边界:图片字节进、**归一化纯文本**出;翻译管线对"这文本来自 OCR"无感知。

### 4.2 预处理建议(在 Rust OCR 模块内完成,约 50 行)

OCR 原始输出是"一框一行",直接进翻译管线会有大量硬断行,建议在返回前做轻量归一化:

1. **行序**(必须):按 2.3 的 boundingBox 排序,midY 降序 + minX 升序,同行多框横向拼接。
2. **去断行拼接**(必须):同一视觉段落内的行,按行尾/行首字符决定连接符——**两侧都是 CJK 字符 → 直接拼接(无空格)**;涉及拉丁字母/数字 → 加一个空格;顺带 trim 掉 Vision 常给的行尾空格。中英混排一行内交替时按字符逐段判断即可。
3. **段落分段**(必须):相邻行的垂直间距(归一化 midY 差)超过约 1.5 倍行高 → 判为新段落,**插入空行**。这样现有"空行切段"逻辑自然把每个视觉段落切成一个 paragraph 块,批式请求(工单 06:3~10 块/批)也能对齐 UI 布局。
4. **不做**(明确出界):不去"修"OCR 错字、不猜语言方向(语言检测交给现有管线/用户设置)、不识别表格结构。识别置信度(`VNRecognizedText.confidence()`)可透传给前端,对低分行打可折叠的"识别存疑"提示,让用户能查看/编辑识别原文再翻译——OCR 是有损通道,给用户一个纠错出口比追求全自动更稳。
5. **空结果处理**:截图无文字 → 返回明确错误码(`NoTextFound`),前端提示"未在图片中识别到文字",不要把空字符串塞进翻译管线。

### 4.3 UI 交互(快捷窗"贴图即译")

- 状态机:`粘贴图片 → [识别中](Vision,亚秒~2s)→ 输入框填充识别文本 → [翻译中](流式)`,两个阶段都要有可见反馈。
- 识别文本默认折叠展示(首行 + 字数),点击展开可编辑,编辑后走正常"重译"。
- 快捷窗粘贴纯文本时行为不变(本方案的 paste 拦截只吃 `image/*`)。

---

## 五、Windows 不阻断注意点

Windows 侧对应能力是 **WinRT `Windows.Media.Ocr`**(`windows` crate 有绑定,同样本地离线,注意需系统装了对应语言包、返回 BGRA 像素要转 SoftwareBitmap)——P1 不实现,只需把 OCR 收口在 `ocr_image` command + `OcrEngine` trait 后面按平台条件编译(`#[cfg(target_os = "macos")]`),前端协议(图字节进、归一化文本出)平台无关,即不阻断。

---

## 六、风险与坑(汇总)

1. **别走 completion handler 路径**:block2 构造 + run loop 依赖是 objc2-vision 最常见的卡点(#664);同步 `performRequests_error` 一条道走到黑。
2. **observations 无阅读序保证**:boundingBox 原点在左下,排序方向容易写反;不排序直接 join 会出现"倒序/交错"文本。
3. **fast 档可能不支持 zh-Hans**:保持默认 accurate;语言显式 `["zh-Hans", "en-US"]`,中文在前。
4. **剪贴板格式不定**:WKWebView 给 JS 的可能是 PNG 也可能是 TIFF;按 type/magic bytes 透传,`initWithData` 通吃,严禁假定单一格式。
5. **Rust 侧剪贴板库返回 RGBA 而非编码字节**:arboard / clipboard-manager 的 readImage 都要二次加工才能喂 Vision——这是"前端 onPaste"成为首选的核心理由。
6. **同步 OCR 占线程**:放 `spawn_blocking`;accurate 档大图(4K 截图全屏文字)可能到 2s+,UI 状态要覆盖。
7. **objc2-vision 版本号与 objc2 不同步**(0.3.x vs 0.6.x):升级 objc2 时看依赖范围(`<0.8.0`)而非版本号直觉;unsafe 调用的参数生命周期(`&NSData` 等必须活得比 handler 久)由编译器兜底,但别提前 drop。
8. **多栏/表格版式阅读序会错乱**:行分组只按垂直重叠,P1 单栏截图可接受;复杂版式留给用户手动编辑识别文本兜底。
9. **usesLanguageCorrection 对技术文本有反作用**:默认关,后续做成设置项。
10. **隐私与权限**:Vision 本地 OCR 无网络、macOS 桌面 App 读前台 paste 事件无额外 entitlement;不上 Mac App Store 则无剪贴板隐私声明负担(上了也只需在营销材料 note 一下 paste 用途)。
11. **识别空结果与低置信度**:区分"无文字"错误与低置信度文本,前者提示用户,后者可编辑重试。

---

## 七、来源

**objc2 / Rust 绑定**
- objc2-vision 版本与元数据:https://crates.io/crates/objc2-vision 、https://lib.rs/crates/objc2-vision
- objc2-vision API 文档(VNRecognizeTextRequest / VNImageRequestHandler / 生成规则):https://docs.rs/objc2-vision
- objc2 仓库与维护状态:https://github.com/madsmtm/objc2
- 同步 vs 回调路径的坑(含维护者给出的 block2 写法与 run loop 说明):https://github.com/madsmtm/objc2/issues/664
- 实测参考代码(andelf/picc,中英混排 Vision OCR 包装):https://github.com/andelf/picc (`src/vision.rs`、`examples/local-ocr.rs`、`examples/screen-ocr.rs`)
- 备选高层封装 apple-vision(vision-rs,swift-bridge):https://github.com/doom-fish/vision-rs 、https://crates.io/crates/apple-vision
- swift-rs(备选,已排除):https://crates.io/crates/swift-rs

**Apple Vision**
- VNRecognizeTextRequest(recognitionLevel 默认 accurate、recognitionLanguages、usesLanguageCorrection、结果为 VNRecognizedTextObservation):https://developer.apple.com/documentation/vision/vnrecognizetextrequest
- supportedRecognitionLanguages(for:revision:)(按档位/revision 查语言,旧方法 deprecated):https://developer.apple.com/documentation/vision/vnrecognizetextrequest/supportedrecognitionlanguages(for:revision:)
- VNRecognizedTextObservation / VNRecognizedText(topCandidates、boundingBox):https://developer.apple.com/documentation/vision/vnrecognizedtextobservation 、https://developer.apple.com/documentation/vision/vnrecognizedtext
- 官方样例"Recognizing Text in Images"(zh-Hans/zh-Hant 放语言数组首位):https://developer.apple.com/documentation/vision/recognizing-text-in-images
- 语言列表随 revision/level 变化的讨论:https://stackoverflow.com/questions/58219769/which-languages-are-available-for-text-recognition-in-vision-framework
- 观察结果需自行排序/分行(多行文本忽略真实换行、boundingBox 归一化且原点左下):https://stackoverflow.com/questions/69865252/vnrecognizetextrequest-text-detection-line-break 、https://medium.com/@osangarine/detecting-text-with-vnrecognizetextrequest-in-ios-13-134078f03f5d

**Tauri 2 IPC / 剪贴板**
- command 收 raw body(`Request` / `InvokeBody::Raw` / invoke 传 ArrayBuffer·Uint8Array → octet-stream):https://v2.tauri.app/develop/calling-rust/
- 官方剪贴板插件(readImage 返回 Image.rgba() 即 RGBA 像素;权限配置):https://v2.tauri.app/plugin/clipboard/ 、https://v2.tauri.app/reference/javascript/clipboard-manager
- arboard(get_image 返回 RGBA ImageData;版本 3.7.0 / 2026-10-15):https://crates.io/crates/arboard 、https://docs.rs/arboard
- WebKit paste 事件图片支持的平台差异(GTK 2.52.0 才修复;WKWebView/macOS 无此问题)与"DOM paste 优于剪贴板插件"的同行论证:https://github.com/IgorKvasn/note-taker/issues/67 、https://bugs.webkit.org/show_bug.cgi?id=218519

**管线衔接(本项目内部)**
- 工单 03(切块管线与非 md 空行切段)、工单 06(`<s>/<t>` 协议、批式流式、非 md 粘贴输入定案):`issues/03-llm-translation-pipeline.md`、`issues/06-translation-protocol.md`
