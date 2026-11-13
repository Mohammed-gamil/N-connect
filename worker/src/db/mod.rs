pub mod audit;
pub mod automations;
pub mod connections;
pub mod credentials;
pub mod events;
pub mod executions;
pub mod sessions;
pub mod users;
pub mod webhooks;

use thiserror::Error;
use worker::d1::{D1Database, D1Type};
use worker::wasm_bindgen::JsValue;
use worker::Env;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Worker(#[from] worker::Error),
    #[error("missing D1 binding: {0}")]
    MissingBinding(String),
    #[error("data integrity error: {0}")]
    Integrity(String),
}

pub fn d1(env: &Env) -> Result<D1Database, DbError> {
    env.d1("DB")
        .map_err(|_| DbError::MissingBinding("DB".to_string()))
}

pub fn d1_i64(v: i64) -> JsValue {
    JsValue::from_f64(v as f64)
}

pub fn d1_opt_i64(v: Option<i64>) -> JsValue {
    match v {
        Some(n) => JsValue::from_f64(n as f64),
        None => JsValue::NULL,
    }
}

pub fn d1_opt_str(v: Option<&str>) -> JsValue {
    match v {
        Some(s) => JsValue::from_str(s),
        None => JsValue::NULL,
    }
}

pub fn d1_blob(b: &[u8]) -> JsValue {
    JsValue::from(&D1Type::Blob(b))
}
