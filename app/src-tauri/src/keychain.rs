// API key 存 macOS Keychain(keyring crate);绝不入库、不回传前端。
// dev 构建:环境变量 YIDU_DEV_PROVIDER_KEY 优先 —— 规避 Keychain ACL
// 授权弹框把 app 卡死的问题(同一路径的二进制 SecItemUpdate 已有项也会弹)。
use anyhow::Result;
use keyring::Entry;

const SERVICE: &str = "com.yidu.desktop";

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
    Ok(())
}

pub fn get_key(provider_id: i64) -> Result<Option<String>> {
    let e = entry(provider_id)?;
    match e.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
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
