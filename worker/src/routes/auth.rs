use std::collections::BTreeMap;

use worker::{Request, Response, RouteContext};

use crate::api_types::{LoginRequest, Me, MeOrganization, MeUser, RegisterRequest};
use crate::auth::password::{hash_password, verify_password};
use crate::auth::rate_limit::{
    clear_limit, client_ip, increment_limit, is_within_limit, login_rate_limit_key,
    register_rate_limit_key, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, REGISTER_MAX_ATTEMPTS,
    REGISTER_WINDOW_MS,
};
use crate::auth::session::{generate_session_token, CookieConfig, SESSION_TTL_MS, SESSION_TTL_SECS};
use crate::crypto::{new_id, PREFIX_ORG, PREFIX_USER};
use crate::db::{audit, d1, sessions, users};
use crate::http::{
    authenticate, empty_response, json_response, log_structured, now_ms, read_json_limited,
    AppError, MAX_API_BODY_BYTES,
};

// Dummy PBKDF2-SHA256 hash used when an email does not exist to equalize login verification timing.
const DUMMY_PBKDF2_HASH: &str =
    "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

fn is_valid_email(email: &str) -> bool {
    let trimmed = email.trim();
    if trimmed.is_empty() || trimmed.len() > 254 || trimmed.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = trimmed.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

pub async fn register(mut req: Request, ctx: RouteContext<String>) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let ip = client_ip(&req);
    let body: RegisterRequest = read_json_limited(&mut req, MAX_API_BODY_BYTES).await?;

    let mut fields = BTreeMap::new();
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        fields.insert(
            "name".to_string(),
            "Name must be between 1 and 80 characters.".to_string(),
        );
    }
    let email = body.email.trim().to_lowercase();
    if !is_valid_email(&email) {
        fields.insert(
            "email".to_string(),
            "Please enter a valid email address.".to_string(),
        );
    }
    if body.password.len() < 10 {
        fields.insert(
            "password".to_string(),
            "Password must be at least 10 characters.".to_string(),
        );
    } else if body.password.len() > 256 {
        fields.insert(
            "password".to_string(),
            "Password must be 256 characters or fewer.".to_string(),
        );
    }
    if !fields.is_empty() {
        return Err(AppError::Validation {
            message: "Please check your registration details.".to_string(),
            fields: Some(fields),
        });
    }

    let db = d1(&ctx.env)?;
    let rl_key = register_rate_limit_key(&ip);
    if !is_within_limit(&db, &rl_key, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MS, now).await? {
        return Err(AppError::RateLimited(
            "Too many registration attempts. Please try again later.".to_string(),
        ));
    }
    increment_limit(&db, &rl_key, REGISTER_WINDOW_MS, now).await?;

    if users::find_user_by_email(&db, &email).await?.is_some() {
        return Err(AppError::Conflict(
            "An account with that email already exists.".to_string(),
        ));
    }

    let password_hash = hash_password(&body.password).await?;
    let user_id = new_id(PREFIX_USER)?;
    let org_id = new_id(PREFIX_ORG)?;
    let org_name = format!("{name}'s Workspace");

    users::create_user_with_personal_org(
        &db,
        &user_id,
        &email,
        &password_hash,
        name,
        &org_id,
        &org_name,
        now,
    )
    .await?;

    let (raw_token, token_hash) = generate_session_token()?;
    sessions::create_session(&db, &token_hash, &user_id, &org_id, now + SESSION_TTL_MS, now)
        .await?;

    let _ = audit::insert_audit_log(
        &db,
        &org_id,
        Some(&user_id),
        "user.registered",
        Some("user"),
        Some(&user_id),
        None,
        now,
    )
    .await;

    log_structured(
        "info",
        "auth.register",
        request_id,
        Some(&org_id),
        Some(201),
        None,
    );

    let cookie_cfg = CookieConfig::from_env(&ctx.env);
    let set_cookie = cookie_cfg.format_set_cookie(&raw_token, SESSION_TTL_SECS);
    let me = Me {
        user: MeUser {
            id: user_id,
            name: name.to_string(),
            email,
        },
        organization: MeOrganization {
            id: org_id,
            name: org_name,
        },
    };
    Ok(json_response(201, &me, request_id, Some(&set_cookie))?)
}

pub async fn login(mut req: Request, ctx: RouteContext<String>) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let ip = client_ip(&req);
    let body: LoginRequest = read_json_limited(&mut req, MAX_API_BODY_BYTES).await?;

    let email = body.email.trim().to_lowercase();
    if email.is_empty() || body.password.is_empty() {
        return Err(AppError::Unauthenticated(
            "Invalid email or password.".to_string(),
        ));
    }

    let db = d1(&ctx.env)?;
    let rl_key = login_rate_limit_key(&email, &ip);
    if !is_within_limit(&db, &rl_key, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, now).await? {
        return Err(AppError::RateLimited(
            "Too many failed login attempts. Please wait 15 minutes and try again.".to_string(),
        ));
    }

    let maybe_user = users::find_user_by_email(&db, &email).await?;
    let valid = match &maybe_user {
        Some(user) => verify_password(&body.password, &user.password_hash)
            .await
            .unwrap_or(false),
        None => {
            let _ = verify_password(&body.password, DUMMY_PBKDF2_HASH).await;
            false
        }
    };

    let Some(user) = maybe_user.filter(|_| valid) else {
        increment_limit(&db, &rl_key, LOGIN_WINDOW_MS, now).await?;
        return Err(AppError::Unauthenticated(
            "Invalid email or password.".to_string(),
        ));
    };

    clear_limit(&db, &rl_key).await?;

    let membership = users::find_default_membership_for_user(&db, &user.id)
        .await?
        .ok_or_else(|| AppError::Internal("User has no organization membership.".to_string()))?;

    let (raw_token, token_hash) = generate_session_token()?;
    sessions::create_session(
        &db,
        &token_hash,
        &user.id,
        &membership.org_id,
        now + SESSION_TTL_MS,
        now,
    )
    .await?;

    log_structured(
        "info",
        "auth.login",
        request_id,
        Some(&membership.org_id),
        Some(200),
        None,
    );

    let cookie_cfg = CookieConfig::from_env(&ctx.env);
    let set_cookie = cookie_cfg.format_set_cookie(&raw_token, SESSION_TTL_SECS);
    let me: Me = membership.into();
    Ok(json_response(200, &me, request_id, Some(&set_cookie))?)
}

pub async fn logout(req: Request, ctx: RouteContext<String>) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let db = d1(&ctx.env)?;
    sessions::delete_session(&db, &auth.token_hash, &auth.org_id).await?;

    let cookie_cfg = CookieConfig::from_env(&ctx.env);
    let clear_cookie = cookie_cfg.format_clear_cookie();
    Ok(empty_response(204, request_id, Some(&clear_cookie))?)
}

pub async fn me(req: Request, ctx: RouteContext<String>) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let db = d1(&ctx.env)?;
    let membership = users::find_user_and_org_by_id(&db, &auth.user_id, &auth.org_id)
        .await?
        .ok_or_else(|| AppError::Unauthenticated("Account not found.".to_string()))?;

    let me: Me = membership.into();
    Ok(json_response(
        200,
        &me,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}
