//! 缓存键哈希：payload 字符串 → 16 位小写 hex（SHA256 前 8 字节）。
//!
//! 缩略图（`thumbnail::cache`）、LUMEN 预览（`lumen::cache`）、LUMEN 细节
//! （`lumen::detail`）三处缓存键此前各自重复了同一段「拼 payload →
//! SHA256 → 取前 8 字节 hex」逻辑（issue #142 候选 3）。收敛到这里后，
//! 口径只有一份；改截断长度/大小写会同时影响三处，须由向量单测锁住。

use sha2::{Digest, Sha256};

/// 对 payload 做 SHA256，取前 8 字节渲染为 16 位小写 hex。
///
/// 与三处旧实现的逐字等价：`Sha256::digest(payload)` 后
/// `digest.iter().take(8).map(|b| format!("{:02x}", b))`。缩略图旧实现
/// 是整 hex 再 `&hash[..16]`，结果相同（前 8 字节的 hex 即前 16 字符）。
pub(crate) fn sha256_hex16(payload: &str) -> String {
    let digest = Sha256::digest(payload.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 已知向量：SHA256("abc") = ba7816bf8f01cfea414140de5dae2223…
    /// 前 8 字节即 `ba7816bf8f01cfea`。变异 `take(8)`（如改成 7）必须红。
    #[test]
    fn sha256_hex16_known_vectors() {
        assert_eq!(sha256_hex16("abc"), "ba7816bf8f01cfea");
        // SHA256("") = e3b0c44298fc1c149afbf4c8996fb924…
        assert_eq!(sha256_hex16(""), "e3b0c44298fc1c14");
    }

    #[test]
    fn sha256_hex16_is_lowercase_hex16() {
        let h = sha256_hex16("lumen-preview-v2|payload");
        assert_eq!(h.len(), 16, "必须是 16 位，实际 {h}");
        assert!(
            h.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "必须全小写 hex，实际 {h}"
        );
    }
}
