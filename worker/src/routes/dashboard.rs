use worker::{Request, Response, RouteContext};

use crate::api_types::DashboardStats;
use crate::db::{automations, connections, d1, executions};
use crate::http::{authenticate, json_response, now_ms, AppError};

const THIRTY_DAYS_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub async fn get_dashboard(req: Request, ctx: RouteContext<String>) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let db = d1(&ctx.env)?;

    let active_automations = automations::count_active_automations(&db, &auth.org_id).await?;
    let (successful_executions, failed_executions) =
        executions::dashboard_execution_counts(&db, &auth.org_id, now - THIRTY_DAYS_MS).await?;
    let connected_apps = connections::count_connected_apps(&db, &auth.org_id).await?;

    let stats = DashboardStats {
        active_automations,
        successful_executions,
        failed_executions,
        connected_apps,
    };

    Ok(json_response(
        200,
        &stats,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}
