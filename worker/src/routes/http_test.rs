use worker::{Request, Response, RouteContext};

use crate::api_types::HttpTestRequest;
use crate::connectors::http::test_http_request;
use crate::http::{
    authenticate, json_response, now_ms, read_json_limited, AppError, MAX_API_BODY_BYTES,
};

pub async fn http_test(
    mut req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let body: HttpTestRequest = read_json_limited(&mut req, MAX_API_BODY_BYTES).await?;

    let result = test_http_request(&ctx.env, &auth.org_id, body).await?;
    Ok(json_response(
        200,
        &result,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}
