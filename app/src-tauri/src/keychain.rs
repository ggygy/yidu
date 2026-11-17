// API key 存 macOS Keychain(keyring crate);绝不入库、不回传前端。
// dev 构建:环境变量 YIDU_DEV_PROVIDER_KEY 优先 —— 规避 Keychain ACL
// 授权弹框把 app 卡死的问题(同一路径的二进制 SecItemUpdate 已有项也会弹)。
use anyhow::Result;
use keyring::Entry;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "com.yidu.desktop";

/// 会话内缓存(v0.3 §1):每次翻译请求都读 Keychain 既慢又可能弹授权框。
/// 值 = 读到的结果(含「确认没有」);只有 set_key 会改写,读失败(非 NoEntry)不缓存。
fn cache() -> &'static Mutex<HashMap<i64, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<i64, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn entry(provider_id: i64) -> Result<Entry> {
    Ok(Entry::new(SERVICE, &format!("provider-{provider_id}"))?)
}

pub fn set_key(provider_id: i64, key: &str) -> Result<()> {
    let e = entry(provider_id)?;
    if key.is_empty() {
        // 空值 = 清除
        let _ = e.delete_credential();
    } else {
        e.set_password(key)?;
    }
    let v = if key.is_empty() { None } else { Some(key.to_string()) };
    cache().lock().unwrap().insert(provider_id, v);
    Ok(())
}

pub fn get_key(provider_id: i64) -> Result<Option<String>> {
    if let Some(v) = cache().lock().unwrap().get(&provider_id) {
        return Ok(v.clone());
    }
    let e = entry(provider_id)?;
    let v = match e.get_password() {
        Ok(k) => Some(k),
        Err(keyring::Error::NoEntry) => None,
        Err(err) => return Err(err.into()),
    };
    cache().lock().unwrap().insert(provider_id, v.clone());
    Ok(v)
}

/// dev 环境变量后备(仅 debug 构建)
fn dev_env_key() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        let k = std::env::var("YIDU_DEV_PROVIDER_KEY").unwrap_or_default();
        if !k.is_empty() {
            return Some(k);
        }
    }
    None
}

/// Provider 层实际可用的 key:dev 环境变量优先,否则 Keychain
pub fn effective_key(provider_id: i64) -> Option<String> {
    if let Some(k) = dev_env_key() {
        return Some(k);
    }
    get_key(provider_id).ok().flatten()
}

pub fn has_key(provider_id: i64) -> bool {
    effective_key(provider_id).is_some()
}
