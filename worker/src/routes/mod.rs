pub mod apps;
pub mod auth;
pub mod automations;
pub mod connections;
pub mod dashboard;
pub mod executions;
pub mod hooks;
pub mod http_test;
pub mod oauth;

use std::future::Future;

use worker::{Request, Response, RouteContext, Router};

use crate::http::AppError;

fn wrap<F, Fut>(
    handler: F,
) -> impl Fn(Request, RouteContext<String>) -> std::pin::Pin<Box<dyn Future<Output = worker::Result<Response>>>>
where
    F: Fn(Request, RouteContext<String>) -> Fut + Copy + 'static,
    Fut: Future<Output = Result<Response, AppError>> + 'static,
{
    move |req: Request, ctx: RouteContext<String>| {
        let request_id = ctx.data.clone();
        Box::pin(async move {
            match handler(req, ctx).await {
                Ok(resp) => Ok(resp),
                Err(app_err) => app_err.into_response(&request_id),
            }
        })
    }
}

pub fn build_router(request_id: String) -> Router<'static, String> {
    Router::with_data(request_id)
        // Auth
        .post_async("/api/auth/register", wrap(auth::register))
        .post_async("/api/auth/login", wrap(auth::login))
        .post_async("/api/auth/logout", wrap(auth::logout))
        .get_async("/api/me", wrap(auth::me))
        // Catalog & Dashboard
        .get_async("/api/apps", wrap(apps::list_apps))
        .get_async("/api/dashboard", wrap(dashboard::get_dashboard))
        // Automations CRUD + lifecycle
        .get_async("/api/automations", wrap(automations::list_automations))
        .post_async("/api/automations", wrap(automations::create_automation))
        .get_async("/api/automations/:id", wrap(automations::get_automation))
        .put_async("/api/automations/:id", wrap(automations::update_automation))
        .delete_async("/api/automations/:id", wrap(automations::delete_automation))
        .post_async(
            "/api/automations/:id/activate",
            wrap(automations::activate_automation),
        )
        .post_async(
            "/api/automations/:id/pause",
            wrap(automations::pause_automation),
        )
        .post_async(
            "/api/automations/:id/test",
            wrap(automations::test_automation),
        )
        .get_async(
            "/api/automations/:id/webhook",
            wrap(automations::get_webhook_info),
        )
        .post_async(
            "/api/automations/:id/webhook/rotate-secret",
            wrap(automations::rotate_webhook_secret),
        )
        .get_async(
            "/api/automations/:id/webhook/samples",
            wrap(automations::list_webhook_samples),
        )
        // Connections, OAuth & HTTP test
        .get_async("/api/connections", wrap(connections::list_connections))
        .post_async("/api/connections", wrap(connections::create_connection))
        .delete_async("/api/connections/:id", wrap(connections::delete_connection))
        .post_async(
            "/api/connections/:id/test",
            wrap(connections::test_connection),
        )
        .get_async(
            "/api/connections/:id/options/:fieldKey",
            wrap(connections::field_options),
        )
        .post_async(
            "/api/connections/:appId/oauth/start",
            wrap(oauth::oauth_start),
        )
        .get_async(
            "/api/oauth/:appId/callback",
            wrap(oauth::oauth_callback),
        )
        .post_async("/api/http/test", wrap(http_test::http_test))
        // Executions
        .get_async("/api/executions", wrap(executions::list_executions))
        .get_async("/api/executions/:id", wrap(executions::get_execution))
        .post_async(
            "/api/executions/:id/retry",
            wrap(executions::retry_execution),
        )
        // Public webhook receiver
        .post_async("/hooks/:publicId", wrap(hooks::receive_webhook))
        // Fallback for unmatched /api/* and SPA static assets
        .or_else_any_method_async("/*catchall", |req, ctx| async move {
            let path = req.path();
            let request_id = ctx.data.clone();
            if path.starts_with("/api/") || path == "/api" {
                return AppError::NotFound("API endpoint not found.".to_string())
                    .into_response(&request_id);
            }
            if let Ok(assets) = ctx.env.assets("ASSETS") {
                return assets.fetch_request(req).await;
            }
            AppError::NotFound("Not found.".to_string()).into_response(&request_id)
        })
}
