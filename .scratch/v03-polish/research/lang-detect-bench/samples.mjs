// 标注样本:lang = 真实源语言;cat = 场景分组
// 方向判定规则与 app 一致:zh → zh2en,其余 X → X2zh
const FENCE = "```";
export const samples = [
  // ---- A. 短文本 (<15 字符) ----
  { cat: "short", lang: "zh", text: "你好" },
  { cat: "short", lang: "zh", text: "翻译" },
  { cat: "short", lang: "zh", text: "调用 API 失败" },
  { cat: "short", lang: "en", text: "Hello" },
  { cat: "short", lang: "en", text: "OK" },
  { cat: "short", lang: "en", text: "Save changes" },
  { cat: "short", lang: "ja", text: "ありがとう" },
  { cat: "short", lang: "ja", text: "テスト" },
  { cat: "short", lang: "ko", text: "감사합니다" },
  { cat: "short", lang: "ru", text: "Привет" },
  { cat: "short", lang: "fr", text: "Merci beaucoup" },
  { cat: "short", lang: "de", text: "Danke schön" },
  { cat: "short", lang: "es", text: "¿Dónde está?" },

  // ---- B. 中英混排技术文 / 代码 ----
  { cat: "mixed-tech", lang: "zh", text: `## 安装\n\n先安装依赖:\n\n${FENCE}bash\nnpm install --save-dev @tauri-apps/cli @tauri-apps/api\ncargo install tauri-cli --version "^2.0.0"\nexport RUST_LOG=debug\n${FENCE}\n\n然后运行开发服务器。` },
  { cat: "mixed-tech", lang: "zh", text: "运行 `npm install --save-dev @tauri-apps/cli` 然后执行 `cargo tauri dev`" },
  { cat: "mixed-tech", lang: "zh", text: "详见 https://github.com/tauri-apps/tauri/blob/dev/README.md 的说明" },
  { cat: "mixed-tech", lang: "zh", text: "在 useEffect 里调用 invoke('translate_stream') 返回 Promise<void>" },
  { cat: "mixed-tech", lang: "zh", text: `${FENCE}ts\nexport async function translate(req: TranslateRequest, onEvent: (e: StreamEvent) => void): Promise<string> {\n  const channel = new Channel<StreamEvent>();\n  channel.onmessage = onEvent;\n  return invoke<string>("translate_stream", { req, channel });\n}\n${FENCE}\n上面的函数负责发起流式翻译。` },
  { cat: "mixed-tech", lang: "zh", text: "- 修复 `detectDir()` 的 bug\n- 更新 `src-tauri/src/prompt.rs`\n- 见 PR #42" },
  { cat: "mixed-tech", lang: "zh", text: "日志里出现 `エラー` 字样就重试一次" },
  { cat: "mixed-tech", lang: "zh", text: "日本的「おもてなし」文化很有名" },
  { cat: "mixed-tech", lang: "zh", text: "韩语的 안녕 是你好的意思" },
  { cat: "mixed-tech", lang: "en", text: `The parser keeps comments verbatim:\n\n${FENCE}js\n// 这里是中文注释,不要翻译\nconst 名称 = "测试";\n${FENCE}\n\nSee the docs for details.` },
  { cat: "mixed-tech", lang: "en", text: "Set the locale to `zh-CN` so the menu shows 设置 instead of Settings." },
  { cat: "mixed-tech", lang: "ru", text: "Запустите `npm run build` и проверьте вывод" },
  { cat: "mixed-tech", lang: "ko", text: "React 컴포넌트에서 useState를 사용하세요" },
  { cat: "mixed-tech", lang: "ja", text: "`cargo build` を実行してからアプリを起動してください" },

  // ---- C. 纯汉字日文 ----
  { cat: "kanji-ja", lang: "ja", text: "東京駅" },
  { cat: "kanji-ja", lang: "ja", text: "経済産業省" },
  { cat: "kanji-ja", lang: "ja", text: "取扱説明書" },
  { cat: "kanji-ja", lang: "ja", text: "日本国憲法第九条" },
  { cat: "kanji-ja", lang: "ja", text: "株式会社" },
  { cat: "kanji-ja", lang: "ja", text: "人工知能研究所" },

  // ---- D. 带重音借词的英文 ----
  { cat: "en-loanword", lang: "en", text: "I had a croissant at the café." },
  { cat: "en-loanword", lang: "en", text: "Please attach your résumé to the email." },
  { cat: "en-loanword", lang: "en", text: "The naïve approach fails on large inputs." },
  { cat: "en-loanword", lang: "en", text: "We met in front of the façade of the old building." },
  { cat: "en-loanword", lang: "en", text: "The piñata was a hit at the party." },
  { cat: "en-loanword", lang: "en", text: "Über-style apps dominate the market." },

  // ---- E. 欧/俄/韩/日/英/中 普通句子 ----
  { cat: "sentence", lang: "fr", text: "Le système de traduction fonctionne très bien aujourd'hui." },
  { cat: "sentence", lang: "fr", text: "Il faut lire la documentation avant de commencer" },
  { cat: "sentence", lang: "de", text: "Die Übersetzung ist schön und schnell fertig." },
  { cat: "sentence", lang: "de", text: "Bitte lesen Sie die Anleitung sorgfältig durch." },
  { cat: "sentence", lang: "de", text: "Das Programm ist sehr gut und funktioniert" },
  { cat: "sentence", lang: "es", text: "La aplicación está lista para producción." },
  { cat: "sentence", lang: "es", text: "El rendimiento mejoró después de la actualización" },
  { cat: "sentence", lang: "es", text: "Necesito ayuda con el proyecto" },
  { cat: "sentence", lang: "ru", text: "Перевод технической документации требует точности." },
  { cat: "sentence", lang: "ko", text: "이 앱은 마크다운 문서를 번역합니다." },
  { cat: "sentence", lang: "ja", text: "このアプリはMarkdown文書を翻訳します。" },
  { cat: "sentence", lang: "en", text: "The quick brown fox jumps over the lazy dog." },
  { cat: "sentence", lang: "zh", text: "这个应用可以把英文文档翻译成中文。" },
];
