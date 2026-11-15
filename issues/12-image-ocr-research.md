# 12: 图片粘贴 OCR 技术方案调研

Type: research
Status: resolved

## Question

P1「图片粘贴 OCR」怎么实现?调研:Tauri 2 中调用 macOS Vision 框架做本地 OCR 的路径(`objc2-vision` / VNRecognizeTextRequest 绑定,或其他方案如 swift-rs 桥接 swift 脚本);剪贴板图片(⌘⌃⇧4 截图 / 其他应用复制)如何进 Rust 侧(arboard / tauri clipboard 插件的图片支持);识别文本(含中英混排、多行段落结构)进入现有翻译管线(工单 06 的块管线)的接入点;识别质量与性能注意点;是否覆盖快捷窗「粘贴即译」交互(贴图即出译文)。产出:推荐方案 + 关键依赖清单 + 风险。

背景:用户已定案轻量版进 P1(快捷窗 ⌘V 贴图直译);完整区域截图遮罩(快捷键框选)留 P2,不在本工单范围。目标:零成本、离线、本地 OCR。

## Resolution

调研报告:`research/12-image-ocr.md`。定案:

1. **技术路径**:Rust 直接用 `objc2-vision` 0.3.x(纯 Rust 构建,无需 Swift 工具链),`VNRecognizeTextRequest` + `initWithData_options` + 同步 `performRequests_error`,不碰 completion block(block2/run loop 坑);accurate 档 + `recognitionLanguages = ["zh-Hans", "en-US"]`(中文在前),OCR 放 `spawn_blocking`。
2. **剪贴板路径**:前端 onPaste 拿 `image/*` File → `arrayBuffer` → `invoke` raw body(octet-stream)传 Rust;不用 arboard / clipboard-manager(它们返回解码 RGBA,喂 Vision 还得重编码,留给 P2 全局快捷键场景)。
3. **接入点**:OCR 文本视作"非 md 粘贴输入"零改动进既有管线;Rust OCR 模块内先做归一化(boundingBox 排阅读序、CJK 无空格/拉丁加空格去断行、垂直间距插空行分段),再返回纯文本,前端走与手工粘贴同一入口触发翻译。
4. Windows 不阻断:对应路径为 WinRT `Windows.Media.Ocr`,OCR 收口在平台条件编译的 `ocr_image` command 后即可。
