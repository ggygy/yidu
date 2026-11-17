# 01: 试用复现与性能基线

Type: task (HITL — 用户本机执行)
Status: closed(超出终点:剩余实测并入 spec §6,M1 后补测)
Assignee: wangjunzhou(本机执行,2026-11-17 认领)
Blocked by: —
Note: 本会话环境 npm 源 403、screencapture 无权限,无法跑;需用户本机执行或授权屏幕录制。

## Question

跑 `app` 的 dev 版,逐项复现六大痛点(自动方向误判样例、md 结构走样样例、配置流程卡点、快捷窗唤不出的触发路径、窄窗竖排/标题体正文、流式一次性出现),每项截图存(另补工单 11 标注「无稿无截图」各屏的实机截图到 `baseline/visual/`) `.scratch/v03-polish/baseline/`;并对当前 provider(ada)与 DeepSeek 实测 TTFT / 首块完成 / 整批耗时 / in·out tokens(可复用 `proto/scripts/protocol-test.mjs`),落一张基线表;并按工单 08 验收跑 ⌥T 50 次多场景唤出测试,作为 spec 验收指标的起点。

## Progress(2026-11-17,部分完成,工单仍 open)

原始记录:[baseline/ticket-01-partial-results.json](../baseline/ticket-01-partial-results.json)。在已安装的 v0.2.3 上执行;未能截图与操控界面(屏幕录制、辅助功能权限缺失),DeepSeek 基准缺 key 未跑。

已得事实:
- **方向识别(函数级复现 v0.2.3 `detectDir`,4 条)**:中文对照组 ✓;中文技术文 + 代码块 → `en2zh` ✗(CJK 59 vs Latin 479,印证「代码计入拉丁」);`東京駅` → `zh2en` ✗(纯汉字日文);英文含 café → `fr2zh`(源语错、目标对)。与工单 02 结论一致。
- **ada 历史延迟(usage_log 21 次,单请求总耗时,非 TTFT)**:最小 0.66s / 中位 **4.5s** / 最大 **48.0s**;prompt 11,238 tok vs completion **16,801 tok**。译文输出通常与输入同量级,completion 约为 prompt 的 1.5 倍,**疑似思考 token 计入输出**(推断,未验证),支持工单 05「默认开着思考」的假设。

仍缺:六项界面复现截图、9 屏视觉补拍、TTFT/首块实测、⌥T 多场景唤出测试(拔显示器需人工)。
