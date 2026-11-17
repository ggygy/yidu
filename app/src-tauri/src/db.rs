// SQLite 存储十表(spec §5):key 只进 Keychain,不入库
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

pub struct Db {
    pub conn: Mutex<Connection>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const SCHEMA_V1: &str = r#"
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'paste',
  direction TEXT NOT NULL DEFAULT 'en2zh',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  src TEXT NOT NULL,
  hash TEXT NOT NULL,
  trans TEXT NOT NULL DEFAULT '',
  trans_status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(article_id, idx)
);
CREATE TABLE vocab_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lemma TEXT NOT NULL UNIQUE,
  phonetic TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE vocab_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES vocab_entries(id) ON DELETE CASCADE,
  article_id INTEGER,
  sentence TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE glossary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,
  translation TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE dict_cache (
  word TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE review_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL UNIQUE REFERENCES vocab_entries(id) ON DELETE CASCADE,
  due_at INTEGER,
  interval_days REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER,
  article_id INTEGER,
  kind TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

pub fn init(app: &tauri::AppHandle) -> Result<Db> {
    let dir = app
        .path()
        .app_data_dir()
        .context("无法取得应用数据目录")?;
    std::fs::create_dir_all(&dir)?;
    open_path(&dir.join("yidu.db"))
}

/// 供集成测试直接开库
pub fn open_path(path: &std::path::Path) -> Result<Db> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        // v2:块级术语命中(译后自动替换 + chip 标记)
        conn.execute_batch("ALTER TABLE blocks ADD COLUMN terms TEXT NOT NULL DEFAULT '';")?;
        conn.pragma_update(None, "user_version", 2)?;
    }
    if version < 3 {
        // v3(v0.3 §2.6.8):计时埋点 + 思考 token + 批规模
        conn.execute_batch(
            "ALTER TABLE usage_log ADD COLUMN ttft_ms INTEGER;
             ALTER TABLE usage_log ADD COLUMN first_block_ms INTEGER;
             ALTER TABLE usage_log ADD COLUMN first_byte_ms INTEGER;
             ALTER TABLE usage_log ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE usage_log ADD COLUMN batch_blocks INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE usage_log ADD COLUMN batch_chars INTEGER NOT NULL DEFAULT 0;",
        )?;
        conn.pragma_update(None, "user_version", 3)?;
    }
    if version < 4 {
        // v4(v0.3 §2.6.7 用量页):记录每次请求的模型名(各模型首字中位数);旧行按 provider 当前模型回填
        conn.execute_batch(
            "ALTER TABLE usage_log ADD COLUMN model TEXT NOT NULL DEFAULT '';
             UPDATE usage_log SET model = COALESCE((SELECT model FROM providers WHERE providers.id = usage_log.provider_id), '');",
        )?;
        conn.pragma_update(None, "user_version", 4)?;
    }
    if version < 5 {
        // v5(v0.3 §2.2 块模型):大列表拆项的 group、与前块的原文分隔、结构签名不一致的提示
        conn.execute_batch(
            "ALTER TABLE blocks ADD COLUMN grp INTEGER;
             ALTER TABLE blocks ADD COLUMN sep TEXT NOT NULL DEFAULT '';
             ALTER TABLE blocks ADD COLUMN format_warn TEXT NOT NULL DEFAULT '';",
        )?;
        conn.pragma_update(None, "user_version", 5)?;
    }
    Ok(Db { conn: Mutex::new(conn) })
}

// ---------- 行结构(与前端共享) ----------

#[derive(Serialize, Clone, Debug)]
pub struct ArticleRow {
    pub id: i64,
    pub title: String,
    pub kind: String,
    pub direction: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub blocks_total: i64,
    pub blocks_done: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct BlockRow {
    pub idx: usize,
    pub kind: String,
    pub src: String,
    pub trans: String,
    pub status: String,
    pub terms: String, // 命中术语 JSON [{"from","to"}]
    /// 大列表拆项:同 group 渲染时合回一个列表
    pub group: Option<i64>,
    /// 与前一块之间的原文分隔(拼回 / 复制为 md 用)
    pub sep: String,
    /// 结构签名不一致(自动重译一次后仍不一致)的说明;空 = 正常
    pub format_warn: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct GlossaryRow {
    pub id: i64,
    pub term: String,
    pub translation: String,
    pub note: String,
    pub enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct VocabEntryRow {
    pub id: i64,
    pub lemma: String,
    pub phonetic: String,
    pub definition: String,
    pub source: String,
    pub created_at: i64,
    pub examples: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProviderRow {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub extra: String,
    pub is_active: bool,
    pub has_key: bool,
}

/// usage_log 一行(一次 HTTP 请求)
#[derive(Debug, Default, Clone)]
pub struct UsageRecord {
    pub provider_id: i64,
    pub article_id: Option<i64>,
    pub kind: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub latency_ms: i64,
    /// 首个正文 token − 请求发出
    pub ttft_ms: Option<i64>,
    /// 首个完整块 − 请求发出
    pub first_block_ms: Option<i64>,
    pub first_byte_ms: Option<i64>,
    pub reasoning_tokens: i64,
    pub batch_blocks: i64,
    pub batch_chars: i64,
    pub model: String,
}

/// 用量页一行(最近请求)
#[derive(Debug, Clone, serde::Serialize)]
pub struct UsageRow {
    pub created_at: i64,
    pub model: String,
    pub provider: String,
    pub ttft_ms: Option<i64>,
    pub latency_ms: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub reasoning_tokens: i64,
}

// ---------- 文章 ----------

impl Db {
    pub fn create_article_with_blocks(
        &self,
        title: &str,
        kind: &str,
        direction: &str,
        blocks: &[crate::blocks::Block],
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let t = now();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO articles(title, kind, direction, created_at, updated_at) VALUES(?1,?2,?3,?4,?4)",
            params![title, kind, direction, t],
        )?;
        let id = tx.last_insert_rowid();
        for (i, b) in blocks.iter().enumerate() {
            // 直通块(代码 / HTML / hr / 脚注 / 链接定义):建库即 done,译文 = 原文
            let (trans, status) = if b.kind.translatable() { ("", "pending") } else { (b.src.as_str(), "done") };
            tx.execute(
                "INSERT INTO blocks(article_id, idx, kind, src, hash, trans, trans_status, created_at, updated_at, grp, sep)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9,?10)",
                params![id, i as i64, b.kind.as_str(), b.src, b.hash, trans, status, t, b.group, b.sep],
            )?;
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn list_articles(&self, query: &str) -> Result<Vec<ArticleRow>> {
        let conn = self.conn.lock().unwrap();
        let like = format!("%{}%", query.replace('%', "\\%"));
        let mut stmt = conn.prepare(
            "SELECT a.id, a.title, a.kind, a.direction, a.pinned, a.created_at, a.updated_at,
                    COUNT(b.id), COALESCE(SUM(b.trans_status='done'),0)
             FROM articles a LEFT JOIN blocks b ON b.article_id=a.id
             WHERE a.title LIKE ?1 ESCAPE '\\'
             GROUP BY a.id
             ORDER BY a.pinned DESC, a.updated_at DESC",
        )?;
        let rows = stmt
            .query_map(params![like], |r| {
                Ok(ArticleRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    kind: r.get(2)?,
                    direction: r.get(3)?,
                    pinned: r.get::<_, i64>(4)? != 0,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                    blocks_total: r.get(7)?,
                    blocks_done: r.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_article(&self, id: i64) -> Result<(ArticleRow, Vec<BlockRow>)> {
        let conn = self.conn.lock().unwrap();
        let article = conn.query_row(
            "SELECT a.id, a.title, a.kind, a.direction, a.pinned, a.created_at, a.updated_at,
                    COUNT(b.id), COALESCE(SUM(b.trans_status='done'),0)
             FROM articles a LEFT JOIN blocks b ON b.article_id=a.id WHERE a.id=?1 GROUP BY a.id",
            params![id],
            |r| {
                Ok(ArticleRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    kind: r.get(2)?,
                    direction: r.get(3)?,
                    pinned: r.get::<_, i64>(4)? != 0,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                    blocks_total: r.get(7)?,
                    blocks_done: r.get(8)?,
                })
            },
        )?;
        let mut stmt = conn.prepare(
            "SELECT idx, kind, src, trans, trans_status, terms, grp, sep, format_warn FROM blocks WHERE article_id=?1 ORDER BY idx",
        )?;
        let blocks = stmt
            .query_map(params![id], |r| {
                Ok(BlockRow {
                    idx: r.get::<_, i64>(0)? as usize,
                    kind: r.get(1)?,
                    src: r.get(2)?,
                    trans: r.get(3)?,
                    status: r.get(4)?,
                    terms: r.get(5)?,
                    group: r.get(6)?,
                    sep: r.get(7)?,
                    format_warn: r.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok((article, blocks))
    }

    pub fn update_block(&self, article_id: i64, idx: usize, trans: &str, status: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE blocks SET trans=?1, trans_status=?2, updated_at=?3 WHERE article_id=?4 AND idx=?5",
            params![trans, status, now(), article_id, idx as i64],
        )?;
        Ok(())
    }

    /// 结构签名提示(空串 = 清除)
    pub fn update_block_warn(&self, article_id: i64, idx: usize, warn: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE blocks SET format_warn=?1, updated_at=?2 WHERE article_id=?3 AND idx=?4",
            params![warn, now(), article_id, idx as i64],
        )?;
        Ok(())
    }

    /// 单块重译:清空译文与提示,回到待译(随后走续译)
    pub fn reset_block(&self, article_id: i64, idx: usize) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE blocks SET trans='', trans_status='pending', format_warn='', terms='', updated_at=?1 WHERE article_id=?2 AND idx=?3",
            params![now(), article_id, idx as i64],
        )?;
        Ok(())
    }

    pub fn update_block_terms(&self, article_id: i64, idx: usize, terms_json: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE blocks SET terms=?1, updated_at=?2 WHERE article_id=?3 AND idx=?4",
            params![terms_json, now(), article_id, idx as i64],
        )?;
        Ok(())
    }

    pub fn touch_article(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE articles SET updated_at=?1 WHERE id=?2", params![now(), id])?;
        Ok(())
    }

    pub fn set_pinned(&self, id: i64, pinned: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE articles SET pinned=?1 WHERE id=?2", params![pinned as i64, id])?;
        Ok(())
    }

    pub fn delete_article(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM blocks WHERE article_id=?1", params![id])?;
        conn.execute("DELETE FROM articles WHERE id=?1", params![id])?;
        Ok(())
    }

    // ---------- 术语 ----------

    pub fn glossary_terms(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT term, translation FROM glossary WHERE enabled=1 ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn glossary_all(&self) -> Result<Vec<GlossaryRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, term, translation, note, enabled FROM glossary ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(GlossaryRow {
                    id: r.get(0)?,
                    term: r.get(1)?,
                    translation: r.get(2)?,
                    note: r.get(3)?,
                    enabled: r.get::<_, i64>(4)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn upsert_glossary(&self, term: &str, translation: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO glossary(term, translation, created_at) VALUES(?1,?2,?3)
             ON CONFLICT(term) DO UPDATE SET translation=?2",
            params![term.trim(), translation.trim(), now()],
        )?;
        Ok(())
    }

    pub fn set_glossary_enabled(&self, id: i64, enabled: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE glossary SET enabled=?1 WHERE id=?2", params![enabled as i64, id])?;
        Ok(())
    }

    pub fn delete_glossary(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM glossary WHERE id=?1", params![id])?;
        Ok(())
    }

    // ---------- 词典缓存 ----------

    pub fn get_dict(&self, word: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT payload FROM dict_cache WHERE word=?1", params![word], |r| r.get(0))
            .optional()?)
    }

    pub fn dict_fetched_at(&self, word: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT fetched_at FROM dict_cache WHERE word=?1", params![word], |r| r.get(0))
            .optional()?)
    }

    pub fn set_dict(&self, word: &str, card: &crate::dict::DictCard) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO dict_cache(word, payload, fetched_at) VALUES(?1,?2,?3)
             ON CONFLICT(word) DO UPDATE SET payload=?2, fetched_at=?3",
            params![word, serde_json::to_string(card)?, now()],
        )?;
        Ok(())
    }

    // ---------- 生词本 ----------

    pub fn add_vocab(
        &self,
        lemma: &str,
        phonetic: &str,
        definition: &str,
        source: &str,
        sentence: Option<&str>,
        article_id: Option<i64>,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let t = now();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO vocab_entries(lemma, phonetic, definition, source, created_at, updated_at)
             VALUES(?1,?2,?3,?4,?5,?5)
             ON CONFLICT(lemma) DO UPDATE SET phonetic=?2, definition=?3, source=?4, updated_at=?5",
            params![lemma.trim().to_lowercase(), phonetic, definition, source, t],
        )?;
        let id = tx.query_row(
            "SELECT id FROM vocab_entries WHERE lemma=?1",
            params![lemma.trim().to_lowercase()],
            |r| r.get(0),
        )?;
        if let Some(s) = sentence.filter(|s| !s.trim().is_empty()) {
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM vocab_examples WHERE entry_id=?1",
                params![id],
                |r| r.get(0),
            )?;
            if count < 5 {
                // 每词条例句累积 ≤5
                tx.execute(
                    "INSERT INTO vocab_examples(entry_id, article_id, sentence, created_at) VALUES(?1,?2,?3,?4)",
                    params![id, article_id, s.trim(), t],
                )?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn vocab_list(&self) -> Result<Vec<VocabEntryRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT v.id, v.lemma, v.phonetic, v.definition, v.source, v.created_at,
                    (SELECT COUNT(*) FROM vocab_examples e WHERE e.entry_id = v.id)
             FROM vocab_entries v ORDER BY v.created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(VocabEntryRow {
                    id: r.get(0)?,
                    lemma: r.get(1)?,
                    phonetic: r.get(2)?,
                    definition: r.get(3)?,
                    source: r.get(4)?,
                    created_at: r.get(5)?,
                    examples: r.get(6)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn vocab_examples(&self, entry_id: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT sentence FROM vocab_examples WHERE entry_id=?1 ORDER BY id DESC LIMIT 5",
        )?;
        let rows = stmt
            .query_map(params![entry_id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete_vocab(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM vocab_examples WHERE entry_id=?1", params![id])?;
        conn.execute("DELETE FROM review_state WHERE entry_id=?1", params![id])?;
        conn.execute("DELETE FROM vocab_entries WHERE id=?1", params![id])?;
        Ok(())
    }

    // ---------- Provider ----------

    pub fn upsert_provider(
        &self,
        id: Option<i64>,
        name: &str,
        kind: &str,
        base_url: &str,
        model: &str,
        extra: &str,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let t = now();
        if let Some(id) = id {
            conn.execute(
                "UPDATE providers SET name=?1, kind=?2, base_url=?3, model=?4, extra=?5, updated_at=?6 WHERE id=?7",
                params![name, kind, base_url, model, extra, t, id],
            )?;
            Ok(id)
        } else {
            conn.execute(
                "INSERT INTO providers(name, kind, base_url, model, extra, created_at, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
                params![name, kind, base_url, model, extra, t],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }

    pub fn list_providers(&self, has_key: &dyn Fn(i64) -> bool) -> Result<Vec<ProviderRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, kind, base_url, model, extra, is_active FROM providers ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProviderRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    base_url: r.get(3)?,
                    model: r.get(4)?,
                    extra: r.get(5)?,
                    is_active: r.get::<_, i64>(6)? != 0,
                    has_key: false,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(conn);
        Ok(rows
            .into_iter()
            .map(|mut p| {
                p.has_key = has_key(p.id);
                p
            })
            .collect())
    }

    pub fn get_provider(&self, id: i64) -> Result<ProviderRow> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT id, name, kind, base_url, model, extra, is_active FROM providers WHERE id=?1",
            params![id],
            |r| {
                Ok(ProviderRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    base_url: r.get(3)?,
                    model: r.get(4)?,
                    extra: r.get(5)?,
                    is_active: r.get::<_, i64>(6)? != 0,
                    has_key: false,
                })
            },
        )?)
    }

    pub fn active_provider(&self) -> Result<Option<ProviderRow>> {
        let conn = self.conn.lock().unwrap();
        let found = conn
            .query_row(
                "SELECT id, name, kind, base_url, model, extra, is_active FROM providers WHERE is_active=1 LIMIT 1",
                [],
                |r| {
                    Ok(ProviderRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        kind: r.get(2)?,
                        base_url: r.get(3)?,
                        model: r.get(4)?,
                        extra: r.get(5)?,
                        is_active: r.get::<_, i64>(6)? != 0,
                        has_key: false,
                    })
                },
            )
            .optional()?;
        Ok(found)
    }

    pub fn set_active_provider(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("UPDATE providers SET is_active=0", [])?;
        tx.execute("UPDATE providers SET is_active=1 WHERE id=?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_provider(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM providers WHERE id=?1", params![id])?;
        Ok(())
    }

    // ---------- 用量 ----------

    pub fn insert_usage(&self, u: &UsageRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage_log(provider_id, article_id, kind, prompt_tokens, completion_tokens, latency_ms,
                                   ttft_ms, first_block_ms, first_byte_ms, reasoning_tokens, batch_blocks, batch_chars, created_at, model)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                u.provider_id,
                u.article_id,
                u.kind,
                u.prompt_tokens,
                u.completion_tokens,
                u.latency_ms,
                u.ttft_ms,
                u.first_block_ms,
                u.first_byte_ms,
                u.reasoning_tokens,
                u.batch_blocks,
                u.batch_chars,
                now(),
                u.model
            ],
        )?;
        Ok(())
    }

    /// 关思考字段被服务商拒绝 → 写回 extra.thinking_unsupported=true(下次不再注入)
    pub fn mark_provider_thinking_unsupported(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let extra: String = conn
            .query_row("SELECT extra FROM providers WHERE id=?1", params![id], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| "{}".into());
        let mut v: serde_json::Value = serde_json::from_str(&extra).unwrap_or_else(|_| serde_json::json!({}));
        if !v.is_object() {
            v = serde_json::json!({});
        }
        v["thinking_unsupported"] = serde_json::json!(true);
        conn.execute("UPDATE providers SET extra=?1 WHERE id=?2", params![v.to_string(), id])?;
        Ok(())
    }

    pub fn usage_summary(&self) -> Result<(i64, i64, i64)> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0) FROM usage_log WHERE kind='translate'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?)
    }

    /// 自 since(unix 秒)以来的翻译请求合计:(请求, 输入, 输出, 思考)
    pub fn usage_since(&self, since: i64) -> Result<(i64, i64, i64, i64)> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(reasoning_tokens),0)
             FROM usage_log WHERE kind='translate' AND created_at >= ?1",
            params![since],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    }

    /// 最近 n 次翻译请求(新→旧)
    pub fn usage_recent(&self, n: i64) -> Result<Vec<UsageRow>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT u.created_at, u.model, COALESCE(p.name, ''), u.ttft_ms, u.latency_ms, u.prompt_tokens, u.completion_tokens, u.reasoning_tokens
             FROM usage_log u LEFT JOIN providers p ON p.id = u.provider_id
             WHERE u.kind='translate' ORDER BY u.id DESC LIMIT ?1",
        )?;
        let rows = st.query_map(params![n], |r| {
            Ok(UsageRow {
                created_at: r.get(0)?,
                model: r.get(1)?,
                provider: r.get(2)?,
                ttft_ms: r.get(3)?,
                latency_ms: r.get(4)?,
                prompt_tokens: r.get(5)?,
                completion_tokens: r.get(6)?,
                reasoning_tokens: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ---------- 杂项状态 ----------

    pub fn get_state(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT value FROM app_state WHERE key=?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_state(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_state(key, value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("yidu-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        (open_path(&path).unwrap(), dir)
    }

    #[test]
    fn usage_model_and_report() {
        let (db, _dir) = temp_db("report");
        db.insert_usage(&UsageRecord { kind: "translate".into(), model: "m1".into(), ttft_ms: Some(700), latency_ms: 900, completion_tokens: 10, reasoning_tokens: 4, ..Default::default() }).unwrap();
        db.insert_usage(&UsageRecord { kind: "translate".into(), model: "m2".into(), ttft_ms: None, latency_ms: 300, ..Default::default() }).unwrap();
        let recent = db.usage_recent(20).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].model, "m2");
        assert_eq!(recent[1].ttft_ms, Some(700));
        let (n, _, c, r) = db.usage_since(0).unwrap();
        assert_eq!((n, c, r), (2, 10, 4));
    }

    #[test]
    fn migration_v3_usage_columns_roundtrip() {
        let (db, dir) = temp_db("usage");
        db.insert_usage(&UsageRecord {
            provider_id: 1,
            article_id: None,
            kind: "translate".into(),
            prompt_tokens: 10,
            completion_tokens: 20,
            latency_ms: 900,
            ttft_ms: Some(300),
            first_block_ms: Some(450),
            first_byte_ms: Some(120),
            reasoning_tokens: 5,
            batch_blocks: 1,
            batch_chars: 42,
            model: "m".into(),
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(v, 5);
            let row: (Option<i64>, Option<i64>, Option<i64>, i64, i64, i64) = conn
                .query_row(
                    "SELECT ttft_ms, first_block_ms, first_byte_ms, reasoning_tokens, batch_blocks, batch_chars FROM usage_log",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .unwrap();
            assert_eq!(row, (Some(300), Some(450), Some(120), 5, 1, 42));
        }
        assert_eq!(db.usage_summary().unwrap(), (1, 10, 20));
        drop(db);
        // 重开不重复迁移
        let db2 = open_path(&dir.join("t.db")).unwrap();
        assert_eq!(db2.usage_summary().unwrap().0, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_thinking_unsupported_merges_extra() {
        let (db, dir) = temp_db("extra");
        let id = db
            .upsert_provider(None, "DeepSeek", "openai_compatible", "https://api.deepseek.com", "m", r#"{"temperature":0.3}"#)
            .unwrap();
        db.mark_provider_thinking_unsupported(id).unwrap();
        let row = db.get_provider(id).unwrap();
        let v: serde_json::Value = serde_json::from_str(&row.extra).unwrap();
        assert_eq!(v["thinking_unsupported"], serde_json::json!(true));
        assert_eq!(v["temperature"], serde_json::json!(0.3));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
