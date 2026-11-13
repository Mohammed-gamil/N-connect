use base64::engine::general_purpose::STANDARD as B64_STD;
use base64::Engine as _;
use thiserror::Error;

use crate::crypto::{constant_time_eq, random_bytes, CryptoError};

const ALGORITHM_TAG: &str = "pbkdf2-sha256";
const DEFAULT_ITERATIONS: u32 = 100_000;
const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;

#[derive(Debug, Error)]
pub enum PasswordError {
    #[error("crypto error: {0}")]
    Crypto(#[from] CryptoError),
    #[error("invalid password hash format")]
    InvalidHashFormat,
    #[error("password derivation failed: {0}")]
    DerivationFailed(String),
}

/// Hash a plaintext password using PBKDF2-HMAC-SHA256 (100,000 iterations, 16-byte salt).
/// Format: `pbkdf2-sha256$100000$<salt_b64>$<hash_b64>`
pub async fn hash_password(password: &str) -> Result<String, PasswordError> {
    let mut salt = [0u8; SALT_LEN];
    random_bytes(&mut salt)?;
    let dk = derive_pbkdf2_sha256(password.as_bytes(), &salt, DEFAULT_ITERATIONS).await?;
    Ok(format!(
        "{ALGORITHM_TAG}${DEFAULT_ITERATIONS}${}${}",
        B64_STD.encode(salt),
        B64_STD.encode(dk)
    ))
}

/// Verify a plaintext password against a stored PBKDF2-SHA256 hash in constant time.
pub async fn verify_password(password: &str, stored_hash: &str) -> Result<bool, PasswordError> {
    let parts: Vec<&str> = stored_hash.split('$').collect();
    if parts.len() != 4 || parts[0] != ALGORITHM_TAG {
        return Err(PasswordError::InvalidHashFormat);
    }
    let iterations: u32 = parts[1]
        .parse()
        .map_err(|_| PasswordError::InvalidHashFormat)?;
    if iterations == 0 || iterations > 1_000_000 {
        return Err(PasswordError::InvalidHashFormat);
    }
    let salt = B64_STD
        .decode(parts[2])
        .map_err(|_| PasswordError::InvalidHashFormat)?;
    let expected = B64_STD
        .decode(parts[3])
        .map_err(|_| PasswordError::InvalidHashFormat)?;
    if salt.is_empty() || expected.len() != HASH_LEN {
        return Err(PasswordError::InvalidHashFormat);
    }

    let derived = derive_pbkdf2_sha256(password.as_bytes(), &salt, iterations).await?;
    Ok(constant_time_eq(&derived, &expected))
}

#[cfg(not(target_arch = "wasm32"))]
async fn derive_pbkdf2_sha256(
    password: &[u8],
    salt: &[u8],
    iterations: u32,
) -> Result<[u8; HASH_LEN], PasswordError> {
    let mut dk = [0u8; HASH_LEN];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password, salt, iterations, &mut dk);
    Ok(dk)
}

#[cfg(target_arch = "wasm32")]
async fn derive_pbkdf2_sha256(
    password: &[u8],
    salt: &[u8],
    iterations: u32,
) -> Result<[u8; HASH_LEN], PasswordError> {
    use js_sys::{Array, Reflect, Uint8Array};
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{Crypto, CryptoKey, Pbkdf2Params};

    let global = js_sys::global();
    let crypto_val = Reflect::get(&global, &JsValue::from_str("crypto"))
        .map_err(|e| PasswordError::DerivationFailed(format!("{e:?}")))?;
    let crypto: Crypto = crypto_val.unchecked_into();
    let subtle = crypto.subtle();

    let pw_arr = Uint8Array::from(password);
    let usages = Array::of1(&JsValue::from_str("deriveBits"));
    let import_promise = subtle
        .import_key_with_str("raw", &pw_arr.into(), "PBKDF2", false, &usages)
        .map_err(|e| PasswordError::DerivationFailed(format!("{e:?}")))?;
    let key_js = JsFuture::from(import_promise)
        .await
        .map_err(|e| PasswordError::DerivationFailed(format!("{e:?}")))?;
    let base_key: CryptoKey = key_js.unchecked_into();

    let salt_arr = Uint8Array::from(salt);
    let params = Pbkdf2Params::new_with_str("PBKDF2", "SHA-256", iterations, &salt_arr.into());
    let derive_promise = subtle
        .derive_bits_with_object(&params.into(), &base_key, (HASH_LEN * 8) as u32)
        .map_err(|e| PasswordError::DerivationFailed(format!("{e:?}")))?;
    let bits_js = JsFuture::from(derive_promise)
        .await
        .map_err(|e| PasswordError::DerivationFailed(format!("{e:?}")))?;

    let bytes = Uint8Array::new(&bits_js).to_vec();
    if bytes.len() != HASH_LEN {
        return Err(PasswordError::DerivationFailed(
            "unexpected derived key length".to_string(),
        ));
    }
    let mut out = [0u8; HASH_LEN];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        use std::pin::Pin;
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn clone(p: *const ()) -> RawWaker {
            RawWaker::new(p, &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = Box::pin(fut);
        loop {
            match Pin::as_mut(&mut fut).poll(&mut cx) {
                Poll::Ready(v) => return v,
                Poll::Pending => panic!("unexpected pending future in sync test"),
            }
        }
    }

    #[test]
    fn pbkdf2_hash_and_verify_roundtrip() {
        let hash = block_on(hash_password("correct-horse-battery-staple")).unwrap();
        assert!(hash.starts_with("pbkdf2-sha256$100000$"));
        let parts: Vec<&str> = hash.split('$').collect();
        assert_eq!(parts.len(), 4);

        assert!(block_on(verify_password("correct-horse-battery-staple", &hash)).unwrap());
        assert!(!block_on(verify_password("wrong-password", &hash)).unwrap());

        // Malformed hashes fail cleanly
        assert!(block_on(verify_password("pw", "argon2$100$abc$def")).is_err());
        assert!(block_on(verify_password("pw", "pbkdf2-sha256$100000$not_b64")).is_err());
    }
}
