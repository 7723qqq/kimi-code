//! At-rest encryption for MCP OAuth credentials.
//!
//! Mirrors v2 `app/mcpConfig/oauthStore.ts:22-103`: AES-256-GCM with a 12-byte
//! IV, a key derived from `hostname:machineId:username:kimi-code-mcp-oauth-v1`,
//! and a hex-encoded `{iv, tag, data}` blob on disk.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const IV_LENGTH: usize = 12;
const KEY_CONTEXT: &str = "kimi-code-mcp-oauth-v1";

/// The on-disk credential envelope (v2 `EncryptedBlob`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedBlob {
    pub iv: String,
    pub tag: String,
    pub data: String,
}

fn hostname() -> String {
    whoami::fallible::hostname().unwrap_or_else(|_| "unknown-host".into())
}

fn username() -> String {
    whoami::username()
}

/// Machine id, matching the v2 probe order (`oauthStore.ts:28-53`): the Windows
/// registry `MachineGuid`, then `/etc/machine-id`, then the macOS IOPlatform
/// UUID. Missing ids fall back to the sentinel `no-machine-id`.
fn machine_id() -> Option<String> {
    if cfg!(windows) {
        let output = std::process::Command::new("reg.exe")
            .args([
                "query",
                "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Some(index) = line.find("REG_SZ") {
                let value = line[index + "REG_SZ".len()..].trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        return None;
    }
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(id) = std::fs::read_to_string(path) {
            let id = id.trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }
    if cfg!(target_os = "macos") {
        let output = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let marker = "\"IOPlatformUUID\"";
        for line in stdout.lines() {
            if let Some(index) = line.find(marker) {
                let rest = &line[index + marker.len()..];
                let value = rest.split('"').nth(1)?;
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Derive the 32-byte AES key (v2 `deriveKey`, `oauthStore.ts:63-73`).
pub fn derive_key() -> [u8; 32] {
    let raw = format!(
        "{}:{}:{}:{}",
        hostname(),
        machine_id().unwrap_or_else(|| "no-machine-id".into()),
        username(),
        KEY_CONTEXT
    );
    let digest = Sha256::digest(raw.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("invalid hex length".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|e| e.to_string())
        })
        .collect()
}

/// Encrypt `value` into the on-disk envelope (v2 `encrypt`).
pub fn encrypt(value: &str) -> Result<EncryptedBlob, String> {
    let cipher = Aes256Gcm::new_from_slice(&derive_key()).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, value.as_bytes())
        .map_err(|_| "failed to encrypt MCP OAuth credentials".to_string())?;
    // `encrypt` appends the 16-byte tag; split it back out so the envelope
    // matches v2's `{iv, tag, data}` shape.
    let (data, tag) = ciphertext.split_at(ciphertext.len() - 16);
    Ok(EncryptedBlob {
        iv: hex(&nonce),
        tag: hex(tag),
        data: hex(data),
    })
}

/// Decrypt an envelope produced by [`encrypt`] (v2 `decrypt`).
pub fn decrypt(blob: &EncryptedBlob) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(&derive_key()).map_err(|e| e.to_string())?;
    let iv = unhex(&blob.iv)?;
    if iv.len() != IV_LENGTH {
        return Err("invalid IV length".into());
    }
    let mut ciphertext = unhex(&blob.data)?;
    ciphertext.extend_from_slice(&unhex(&blob.tag)?);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&iv), ciphertext.as_ref())
        .map_err(|_| "failed to decrypt MCP OAuth credentials".to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_key_is_stable_and_32_bytes() {
        let first = derive_key();
        assert_eq!(first.len(), 32);
        assert_eq!(first, derive_key(), "key derivation must be deterministic");
    }

    #[test]
    fn test_encrypt_decrypt_round_trip() {
        let blob = encrypt(r#"{"access_token":"example-token"}"#).expect("encrypt");
        assert_eq!(blob.iv.len(), IV_LENGTH * 2);
        assert_eq!(blob.tag.len(), 32);
        assert!(!blob.data.contains("example-token"));
        assert_eq!(
            decrypt(&blob).expect("decrypt"),
            r#"{"access_token":"example-token"}"#
        );
    }

    #[test]
    fn test_encrypt_uses_a_fresh_iv_each_time() {
        let first = encrypt("same").unwrap();
        let second = encrypt("same").unwrap();
        assert_ne!(first.iv, second.iv);
        assert_ne!(first.data, second.data);
    }

    #[test]
    fn test_tampered_blob_fails_to_decrypt() {
        let mut blob = encrypt("secret").unwrap();
        blob.data = format!("00{}", &blob.data[2..]);
        assert!(decrypt(&blob).is_err());
    }
}
