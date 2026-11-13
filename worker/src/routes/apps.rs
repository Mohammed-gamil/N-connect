use worker::{Request, Response, RouteContext};

use crate::api_types::AppsResponse;
use crate::connectors::Catalog;
use crate::http::{json_response, AppError};

pub async fn list_apps(_req: Request, ctx: RouteContext<String>) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let catalog = Catalog::mvp();
    let resp = AppsResponse {
        apps: catalog.apps().to_vec(),
    };
    Ok(json_response(200, &resp, request_id, None)?)
}
