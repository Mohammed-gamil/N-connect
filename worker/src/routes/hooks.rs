use worker::{Request, Response, RouteContext};

use crate::engine::receiver;
use crate::http::AppError;

/// Public webhook ingress (`POST /hooks/:publicId`).
pub async fn receive_webhook(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    receiver::handle_webhook(req, ctx).await
}
