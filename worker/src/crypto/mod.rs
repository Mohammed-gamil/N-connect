use std::fmt;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64_URL};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

type HmacSha256 = Hmac<Sha256>;

pub const PREFIX_USER: &str = "usr_";
pub const PREFIX_ORG: &str = "org_";
pub const PREFIX_CONNECTION: &str = "con_";
pub const PREFIX_AUTOMATION: &str = "aut_";
pub const PREFIX_EXECUTION: &str = "exe_";
pub const PREFIX_EVENT: &str = "evt_";
pub const PREFIX_WEBHOOK: &str = "whk_";
pub const PREFIX_CREDENTIAL: &str = "crd_";
pub const PREFIX_AUDIT: &str = "aud_";
pub const PREFIX_REQUEST: &str = "req_";

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("random number generation failed")]
    RngFailed,
    #[error("invalid master key encoding or length")]
    InvalidKey,
    #[error("invalid nonce length")]
    InvalidNonce,
    #[error("encryption failed")]
    EncryptFailed,
    #[error("decryption failed")]
    DecryptFailed,
    #[error("secret is not valid UTF-8")]
    InvalidUtf8,
    #[error("missing credential key configuration")]
    MissingKeyConfig(String),
}

/// Sensitive byte buffer whose Debug and Display implementations ALWAYS redact.
/// Intentionally does NOT implement `serde::Serialize`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn from_string(s: String) -> Self {
        Self(s.into_bytes())
    }

    pub fn from_str_slice(s: &str) -> Self {
        Self(s.as_bytes().to_vec())
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn expose_str(&self) -> Result<&str, CryptoError> {
        std::str::from_utf8(&self.0).map_err(|_| CryptoError::InvalidUtf8)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Debug, Clone)]
pub struct EncryptedBlob {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; 12],
    pub key_version: i32,
}

pub fn random_bytes(buf: &mut [u8]) -> Result<(), CryptoError> {
    getrandom::getrandom(buf).map_err(|_| CryptoError::RngFailed)
}

pub fn random_token_b64url(num_bytes: usize) -> Result<String, CryptoError> {
    let mut buf = vec![0u8; num_bytes];
    random_bytes(&mut buf)?;
    let encoded = B64_URL.encode(&buf);
    buf.zeroize();
    Ok(encoded)
}

/// Generates a prefixed opaque identifier with 128 bits of CSPRNG entropy.
pub fn new_id(prefix: &str) -> Result<String, CryptoError> {
    let mut bytes = [0u8; 16];
    random_bytes(&mut bytes)?;
    Ok(format!("{prefix}{}", B64_URL.encode(bytes)))
}

/// Generates a 128-bit URL-safe public webhook identifier.
pub fn new_public_id() -> Result<String, CryptoError> {
    let mut bytes = [0u8; 16];
    random_bytes(&mut bytes)?;
    Ok(B64_URL.encode(bytes))
}

pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex::encode(digest)
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    bool::from(a.ct_eq(b))
}

pub fn hmac_sha256(secret: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(secret)
        .expect("HMAC accepts keys of any size");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

pub fn hmac_sha256_hex(secret: &[u8], data: &[u8]) -> String {
    hex::encode(hmac_sha256(secret, data))
}

/// Constant-time verification of a hex-encoded HMAC-SHA256 signature.
/// Accepts uppercase or lowercase hex (64 hex chars).
pub fn verify_hmac_sha256_hex(secret: &[u8], data: &[u8], signature_hex: &str) -> bool {
    let clean = signature_hex.trim();
    let Ok(provided) = hex::decode(clean) else {
        return false;
    };
    if provided.len() != 32 {
        return false;
    }
    let expected = hmac_sha256(secret, data);
    constant_time_eq(&expected, &provided)
}

pub fn make_credential_aad(org_id: &str, cred_id: &str, kind: &str) -> Vec<u8> {
    format!("{org_id}:{cred_id}:{kind}").into_bytes()
}

pub fn decode_master_key_b64(b64: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let raw = Zeroizing::new(
        B64_STD
            .decode(b64.trim())
            .map_err(|_| CryptoError::InvalidKey)?,
    );
    if raw.len() != 32 {
        return Err(CryptoError::InvalidKey);
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&raw);
    Ok(key)
}

pub fn load_master_key(
    env: &worker::Env,
    key_version: i32,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let var_name = format!("CREDENTIALS_KEY_V{key_version}");
    let secret = env
        .secret(&var_name)
        .map_err(|_| CryptoError::MissingKeyConfig(var_name.clone()))?;
    decode_master_key_b64(&secret.to_string())
}

pub fn encrypt_secret(
    master_key: &[u8; 32],
    key_version: i32,
    plaintext: &Secret,
    aad: &[u8],
) -> Result<EncryptedBlob, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(master_key).map_err(|_| CryptoError::InvalidKey)?;
    let mut nonce_bytes = [0u8; 12];
    random_bytes(&mut nonce_bytes)?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad,
            },
        )
        .map_err(|_| CryptoError::EncryptFailed)?;

    Ok(EncryptedBlob {
        ciphertext,
        nonce: nonce_bytes,
        key_version,
    })
}

pub fn decrypt_secret(
    master_key: &[u8; 32],
    ciphertext: &[u8],
    nonce_bytes: &[u8],
    aad: &[u8],
) -> Result<Secret, CryptoError> {
    if nonce_bytes.len() != 12 {
        return Err(CryptoError::InvalidNonce);
    }
    let cipher = Aes256Gcm::new_from_slice(master_key).map_err(|_| CryptoError::InvalidKey)?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::DecryptFailed)?;
    Ok(Secret::from_bytes(plaintext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_redacts_debug_and_display() {
        let s = Secret::from_str_slice("xoxb-super-secret-token-12345");
        assert_eq!(format!("{s:?}"), "[REDACTED]");
        assert_eq!(format!("{s}"), "[REDACTED]");
        assert_eq!(s.expose_str().unwrap(), "xoxb-super-secret-token-12345");
    }

    #[test]
    fn aes_gcm_roundtrip_and_aad_tamper_and_wrong_key() {
        let mut raw_key = [0u8; 32];
        random_bytes(&mut raw_key).unwrap();
        let b64 = B64_STD.encode(raw_key);
        let key = decode_master_key_b64(&b64).unwrap();

        let aad = make_credential_aad("org_1", "crd_1", "oauth_token");
        let plaintext = Secret::from_str_slice("pk_901234_secret_token");

        let blob = encrypt_secret(&key, 1, &plaintext, &aad).unwrap();
        assert_eq!(blob.key_version, 1);
        assert_eq!(blob.nonce.len(), 12);
        assert_ne!(blob.ciphertext, plaintext.as_bytes());

        // Valid decrypt
        let dec = decrypt_secret(&key, &blob.ciphertext, &blob.nonce, &aad).unwrap();
        assert_eq!(dec.expose_str().unwrap(), "pk_901234_secret_token");

        // Wrong AAD (cross-tenant tamper) MUST fail
        let wrong_aad = make_credential_aad("org_2", "crd_1", "oauth_token");
        assert!(decrypt_secret(&key, &blob.ciphertext, &blob.nonce, &wrong_aad).is_err());

        // Ciphertext tamper MUST fail
        let mut tampered_ct = blob.ciphertext.clone();
        tampered_ct[0] ^= 0x01;
        assert!(decrypt_secret(&key, &tampered_ct, &blob.nonce, &aad).is_err());

        // Wrong key MUST fail
        let mut wrong_key = *key;
        wrong_key[0] ^= 0xff;
        assert!(decrypt_secret(&wrong_key, &blob.ciphertext, &blob.nonce, &aad).is_err());

        // Invalid nonce length MUST fail
        assert!(decrypt_secret(&key, &blob.ciphertext, &[0u8; 8], &aad).is_err());
    }

    #[test]
    fn hmac_sha256_vectors_and_constant_time_verify() {
        // RFC 4231 Test Case 2: key = "Jefe", data = "what do ya want for nothing?"
        let mac = hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            mac,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert!(verify_hmac_sha256_hex(
            b"Jefe",
            b"what do ya want for nothing?",
            &mac
        ));
        // Uppercase hex also accepted
        assert!(verify_hmac_sha256_hex(
            b"Jefe",
            b"what do ya want for nothing?",
            &mac.to_uppercase()
        ));

        // ClickUp webhook signature verification example
        let clickup_secret = b"CU_SECRET_KEY_12345";
        let raw_body = br#"{"event":"taskCreated","task_id":"8688abc","webhook_id":"wh_1"}"#;
        let clickup_sig = hmac_sha256_hex(clickup_secret, raw_body);
        assert_eq!(clickup_sig.len(), 64);
        assert!(verify_hmac_sha256_hex(clickup_secret, raw_body, &clickup_sig));

        // Tampered body fails
        let tampered_body = br#"{"event":"taskCreated","task_id":"8688abd","webhook_id":"wh_1"}"#;
        assert!(!verify_hmac_sha256_hex(
            clickup_secret,
            tampered_body,
            &clickup_sig
        ));

        // Wrong signature length or invalid hex fails
        assert!(!verify_hmac_sha256_hex(clickup_secret, raw_body, "deadbeef"));
        assert!(!verify_hmac_sha256_hex(clickup_secret, raw_body, "zzzz"));
    }

    #[test]
    fn prefixed_ids_and_sha256_hex() {
        let prefixes = [
            PREFIX_USER,
            PREFIX_ORG,
            PREFIX_CONNECTION,
            PREFIX_AUTOMATION,
            PREFIX_EXECUTION,
            PREFIX_EVENT,
            PREFIX_WEBHOOK,
            PREFIX_CREDENTIAL,
            PREFIX_AUDIT,
        ];
        for p in prefixes {
            let id = new_id(p).unwrap();
            assert!(id.starts_with(p));
            assert_eq!(id.len(), p.len() + 22);
        }
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
