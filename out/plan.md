# 译读 · 阅读美化 + 更新 + 建仓 · 设计规格(可观察项)

来源:用户批准的 ExitPlanMode 计划(2026-11-15)。无源视频,全部为样式/行为规格;[S]=可观察规格,数值为验收实测值。

## A1 markdown 排版系统(app/src/styles.css,两窗共用)

- [S1] `.md h1~h6` 字号 20/17/15/13.5/13/12.5px,字重 650,行高 1.35,上边距 1.35em 下 0.5em,字体 --f-ui(译文正文衬线时标题仍无衬线)
- [S2] `.md h2` 有 padding-bottom 6px + 1px var(--border) 底线
- [S3] `.md p` margin 0 0 10px;首子元素 margin-top 0,末子元素 margin-bottom 0
- [S4] `.md strong/b` color var(--t1) + 字重 600;`.md a` accent 色 + 下划线(offset 2px)
- [S5] `.md li` 为 list-item(非 flex),margin 3px 0;ul/ol padding-left 1.5em;`li::marker` color var(--accent) —— 全文件仅 1 条 marker 规则(原 3 条重复 + flex bug 全删)
- [S6] `.md blockquote` 左边 3px var(--accent-soft) + 背景 var(--surface-2) + 圆角 0 10px 10px 0 + padding 8px 14px + 文字 var(--t2)
- [S7] `.md code`(行内)mono、0.88em、背景 var(--surface-2)、padding 1px 5px、圆角 4;pre 内 code 不重复染色
- [S8] `.md table` 边框 1px var(--border) 圆角 8、th 背景 var(--surface-2) 字重 600、td padding 6px 10px、行间 1px 底线(末行无)、列间 1px 右线(末列无)
- [S9] `.md hr` 1px var(--border) 居中;`.md img` max-width 100% 圆角 10

## A2 主窗阅读主次(app/src/styles.css)

- [S10] `.zh` 字号 16px、行高 1.95、颜色继承 --t1、字体 var(--f-title)(衬线;code 仍 mono)
- [S11] `.en` 字号 12.5px、行高 1.65、颜色 var(--t3)(与译文拉开两档);split 视图 `.cell-l` 同步降级
- [S12] 相邻 `.pair + .pair` 之间 padding-top 18px + 1px var(--border) 顶线;.col gap 30→26px
- [S13] `.content` 底 padding 150→170px(capsule 80px + hint 余量)
- [S14] 快捷窗 `.q-out .zh` 保持 --f-ui(小窗不用衬线),13px/1.8

## A3 CodeBox(app/src/md.tsx + styles.css)

- [S15] badge-row:左「lang 徽标」右「复制」按钮;点击后 1.2s 内显示「✓ 已复制」复原
- [S16] `.codebox` 加 1px var(--border) 边框;dark 主题 --code-tx #d4d4dc / --code-dim #8a8a94

## A4 快捷窗(app/src/quick/main.tsx + styles.css)

- [S17] q-cols 左列 code 块渲染灰字占位「··· 代码块(N 行)···」(N=真实行数),块序与右列 1:1 对齐(filter 移除)
- [S18] 快捷窗旧 `.q-out .md` 四条局部规则并入全局,li 的 display:flex 删除

## A5 TOC(app/src/main.tsx + styles.css)

- [S19] 从块 src 抽 `^#{1,3} ` 标题,≥3 条才显示;左缘悬浮轨,默认窄条态,hover/点击展开列示(h2/h3 缩进差 10px)
- [S20] 点击 TOC 项 → 对应块 scrollIntoView({behavior:"smooth"}) 且不高亮残留

## A6 段落原文折叠(app/src/main.tsx)

- [S21] interleave 视图每个 pair 的 en 区右上 chevron 按钮,点击切换该 pair 原文显隐(Set<idx>),默认全显;折叠后仅留 chevron 行

## A7 术语译后高亮(src/md.tsx Zh 路径)

- [S22] 命中块译文内 target 术语词:accent 下划线标记(非背景块);点击弹小卡显示 from → to + 「禁用」按钮(调 glossarySetEnabled 后刷新)
- [S23] 高亮只作用于文本子节点,不破坏 md 结构(代码/链接内不重复标记)

## B 软件内更新(tauri-plugin-updater + GitHub Releases)

- [S24] 依赖:Cargo tauri-plugin-updater="2" + tauri-plugin-process="2";npm 对应两个包
- [S25] `~/.tauri/yidu.key` minisign 私钥权限 600,公钥入 tauri.conf.json plugins.updater.pubkey;私钥不在仓库内
- [S26] tauri.conf.json:bundle.createUpdaterArtifacts=true;endpoints=[https://github.com/<owner>/yidu/releases/latest/download/latest.json](建仓后回填真实 owner)
- [S27] capabilities 含 updater:default + process:allow-restart;lib.rs 注册两插件
- [S28] 设置面板「关于与更新」区:显示当前版本号 + 「检查更新」按钮;点击走 check→download→install→relaunch,过程有进度文案;无更新/失败显示对应文案
- [S29] 启动静默 check,有新版本 toast 提示(不自动安装);README 含发布流程(TAURI_SIGNING_PRIVATE_KEY 签名、latest.json + .app.tar.gz 上传、tauri-action 可选)

## C 建仓推送(GitHub 私有仓)

- [S30] repo root=.scratch/md-translator;.gitignore 覆盖 node_modules/、**/target/、**/dist/、.env*、.DS_Store、*.log、src-tauri/gen/schemas/
- [S31] 推送前 `git ls-files` 无任何 .env 文件;全树 grep 无 sk- 密钥(proto/.env.local 被忽略)
- [S32] gh repo create yidu --private --source . --push 成功;远程含首提(译读 P0 全量)+ 二次提交(updater);gh repo view 可见

## 验证(ExitPlanMode 计划第 4 节)

- [S33] cargo test 42/42 + tsc --noEmit + npm run build 全绿
- [S34] 真机截图矩阵:主窗三视图×亮暗核对 S1-S13/S19-S23;快捷窗单/双栏含代码列表核对 S5/S17/S18;滚到底 capsule 不遮挡(S13)
- [S35] dev 启动无 updater 插件报错;点「检查更新」在无 Release 时显示「暂无更新」(通路验证)
