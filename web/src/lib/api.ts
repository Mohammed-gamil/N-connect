import type {
  ApiError,
  AppDefinition,
  AppId,
  Automation,
  Connection,
  CreateTokenConnectionRequest,
  DashboardStats,
  ErrorCode,
  Execution,
  ExecutionStatus,
  FieldOption,
  HttpTestRequest,
  HttpTestResult,
  Id,
  LoginRequest,
  Me,
  Page,
  RegisterRequest,
  SaveAutomationRequest,
  TestRunResult,
  WebhookInfo,
  WebhookSample,
} from "../contracts";

export class ApiClientError extends Error {
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;
  readonly requestId: string;
  readonly status: number;

  constructor(
    code: ErrorCode,
    message: string,
    fields: Record<string, string> | undefined,
    requestId: string,
    status: number,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
    this.status = status;
  }
}

function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
    case 400:
      return "validation_failed";
    case 429:
      return "rate_limited";
    case 502:
    case 503:
    case 504:
      return "upstream_error";
    default:
      return "internal";
  }
}

function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 401:
      return "Please sign in to continue.";
    case 403:
      return "You don't have permission to perform this action.";
    case 404:
      return "We couldn't find what you were looking for.";
    case 409:
      return "This conflicts with an existing item.";
    case 422:
    case 400:
      return "Please check your inputs and try again.";
    case 429:
      return "Too many attempts. Please wait a moment and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function isApiErrorBody(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const err = (value as { error?: unknown }).error;
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (method !== "GET") {
    headers["X-Requested-With"] = "hub";
  }

  let encodedBody: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    encodedBody = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: encodedBody,
      credentials: "include",
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new ApiClientError(
      "upstream_error",
      "Unable to reach the server. Check your connection and try again.",
      undefined,
      "",
      0,
    );
  }

  const headerRequestId = response.headers.get("X-Request-Id") ?? "";

  if (!response.ok) {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (isApiErrorBody(parsed)) {
      throw new ApiClientError(
        parsed.error.code ?? statusToErrorCode(response.status),
        parsed.error.message,
        parsed.error.fields,
        parsed.error.requestId || headerRequestId,
        response.status,
      );
    }

    throw new ApiClientError(
      statusToErrorCode(response.status),
      defaultMessageForStatus(response.status),
      undefined,
      headerRequestId,
      response.status,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export interface ListExecutionsParams {
  automationId?: Id;
  status?: ExecutionStatus;
  cursor?: string;
  limit?: number;
}

export const api = {
  // Auth
  register(body: RegisterRequest): Promise<Me> {
    return request<Me>("/api/auth/register", { method: "POST", body });
  },
  login(body: LoginRequest): Promise<Me> {
    return request<Me>("/api/auth/login", { method: "POST", body });
  },
  logout(): Promise<void> {
    return request<void>("/api/auth/logout", { method: "POST" });
  },
  me(signal?: AbortSignal): Promise<Me> {
    return request<Me>("/api/me", { signal });
  },

  // Apps catalog
  listApps(signal?: AbortSignal): Promise<{ apps: AppDefinition[] }> {
    return request<{ apps: AppDefinition[] }>("/api/apps", { signal });
  },

  // Connections
  listConnections(signal?: AbortSignal): Promise<{ connections: Connection[] }> {
    return request<{ connections: Connection[] }>("/api/connections", { signal });
  },
  startOAuth(appId: AppId, returnTo?: string): Promise<{ redirectUrl: string }> {
    return request<{ redirectUrl: string }>(`/api/connections/${appId}/oauth/start`, {
      method: "POST",
      body: returnTo ? { returnTo } : {},
    });
  },
  createTokenConnection(body: CreateTokenConnectionRequest): Promise<Connection> {
    return request<Connection>("/api/connections", { method: "POST", body });
  },
  testConnection(id: Id): Promise<{ ok: boolean; message: string }> {
    return request<{ ok: boolean; message: string }>(`/api/connections/${id}/test`, {
      method: "POST",
    });
  },
  deleteConnection(id: Id): Promise<void> {
    return request<void>(`/api/connections/${id}`, { method: "DELETE" });
  },
  getFieldOptions(
    connectionId: Id,
    fieldKey: string,
    parent?: string,
    signal?: AbortSignal,
  ): Promise<{ options: FieldOption[] }> {
    const query = parent ? `?parent=${encodeURIComponent(parent)}` : "";
    return request<{ options: FieldOption[] }>(
      `/api/connections/${connectionId}/options/${encodeURIComponent(fieldKey)}${query}`,
      { signal },
    );
  },

  // Automations
  listAutomations(signal?: AbortSignal): Promise<{ automations: Automation[] }> {
    return request<{ automations: Automation[] }>("/api/automations", { signal });
  },
  getAutomation(id: Id, signal?: AbortSignal): Promise<Automation> {
    return request<Automation>(`/api/automations/${id}`, { signal });
  },
  createAutomation(body: SaveAutomationRequest): Promise<Automation> {
    return request<Automation>("/api/automations", { method: "POST", body });
  },
  updateAutomation(id: Id, body: SaveAutomationRequest): Promise<Automation> {
    return request<Automation>(`/api/automations/${id}`, { method: "PUT", body });
  },
  deleteAutomation(id: Id): Promise<void> {
    return request<void>(`/api/automations/${id}`, { method: "DELETE" });
  },
  activateAutomation(id: Id): Promise<Automation> {
    return request<Automation>(`/api/automations/${id}/activate`, { method: "POST" });
  },
  pauseAutomation(id: Id): Promise<Automation> {
    return request<Automation>(`/api/automations/${id}/pause`, { method: "POST" });
  },
  testAutomation(id: Id): Promise<TestRunResult> {
    return request<TestRunResult>(`/api/automations/${id}/test`, { method: "POST" });
  },

  // Custom webhook (Advanced)
  getWebhookInfo(automationId: Id, signal?: AbortSignal): Promise<WebhookInfo> {
    return request<WebhookInfo>(`/api/automations/${automationId}/webhook`, { signal });
  },
  rotateWebhookSecret(automationId: Id): Promise<WebhookInfo> {
    return request<WebhookInfo>(`/api/automations/${automationId}/webhook/rotate-secret`, {
      method: "POST",
    });
  },
  listWebhookSamples(
    automationId: Id,
    signal?: AbortSignal,
  ): Promise<{ samples: WebhookSample[] }> {
    return request<{ samples: WebhookSample[] }>(
      `/api/automations/${automationId}/webhook/samples`,
      { signal },
    );
  },

  // HTTP test (Advanced)
  testHttp(body: HttpTestRequest): Promise<HttpTestResult> {
    return request<HttpTestResult>("/api/http/test", { method: "POST", body });
  },

  // Executions
  listExecutions(
    params: ListExecutionsParams = {},
    signal?: AbortSignal,
  ): Promise<Page<Execution>> {
    const search = new URLSearchParams();
    if (params.automationId) search.set("automationId", params.automationId);
    if (params.status) search.set("status", params.status);
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<Page<Execution>>(`/api/executions${qs ? `?${qs}` : ""}`, { signal });
  },
  getExecution(id: Id, signal?: AbortSignal): Promise<Execution> {
    return request<Execution>(`/api/executions/${id}`, { signal });
  },
  retryExecution(id: Id): Promise<Execution> {
    return request<Execution>(`/api/executions/${id}/retry`, { method: "POST" });
  },

  // Dashboard
  getDashboard(signal?: AbortSignal): Promise<DashboardStats> {
    return request<DashboardStats>("/api/dashboard", { signal });
  },
};
