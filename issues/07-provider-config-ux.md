# 07: Provider 配置与模型管理 UX 定案

Type: grilling
Status: resolved
Blocked by: 04

## Question

基于工单 04 的调研,与用户 grilling 定案:设置页形态、内置预设清单(JSON,锦上添花)、Ollama 模型发现与选择交互、默认 provider/模型规则、连通性测试与用量提示(本地统计 token 成本)。

## Answer

经一轮 grilling 用户全部采纳推荐(2026-11-12):

1. **设置页形态**:主窗口内一页(侧栏"设置"入口);快捷窗 Provider chip 点击弹切换菜单(高频动作),"管理…"跳主窗设置页;首次启动引导在主窗完成(无 provider 时)。
2. **预设**:P0 内置 DeepSeek / 智谱 GLM / OpenAI / Ollama 四个预设 + "自定义(OpenAI 兼容)"空白项;模型名不硬编码,`GET /models` 拉取 + 手填兜底。
3. **Ollama P0 全做**:原生 `/api/*` 通道;`/api/tags` 发现与选择、`/api/pull` 拉取进度(复用 Channel,官方断点续传)、健康检查(区分未启动/无模型/加载中);每请求显式 `num_ctx`(默认 8192,可调);模型删除管理放 P1。
4. **默认 Provider 规则**:全局唯一 active,快捷窗与主窗共用、切换即时生效;首启检测本地 Ollama 运行且有模型 → 默认选它(零成本开箱即用),否则引导配置云端 key。
5. **测试与用量**:测试连接 = Rust 侧 1-token 最小请求,报告延迟/模型名/上下文上限;每次请求记录 usage 本地累计(按 provider/按日);每模型可手填单价(每百万 token,存本地)→ 状态栏与设置页显示估算成本,不内置价格表。
6. **技术默认值**:思考模型默认关思考(`reasoning_content` 隔离、折叠显示、绝不进译文);Base URL 归一化 + UI 预览最终 URL;设置页提供代理地址透传(reqwest);流式只设 connect/read timeout,断流按块重放。
7. 落地依赖(来自调研 04):Provider trait 全在 Rust 侧,command 面 `list/upsert/delete_provider + set_provider_key + test_connection + list_models + translate + ollama_pull + cancel`;key 存 macOS Keychain(`keyring` v4),前端永不回显完整 key。
