import { describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../src/lib/api";

describe("api client", () => {
  it("sends credentials: include on GET requests without X-Requested-With", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ apps: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.listApps();
    expect(result).toEqual({ apps: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/apps");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBeUndefined();
  });

  it("sends X-Requested-With: hub and credentials: include on mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteAutomation("aut_123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/automations/aut_123");
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBe("hub");
  });

  it("parses ApiError JSON and throws typed ApiClientError with fields and requestId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "validation_failed",
            message: "Please fix the highlighted fields.",
            fields: {
              email: "That email is already registered.",
              password: "Password must be at least 10 characters.",
            },
            requestId: "req_abc123",
          },
        }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.register({ name: "Alex", email: "alex@example.com", password: "short" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe("validation_failed");
      expect(apiErr.message).toBe("Please fix the highlighted fields.");
      expect(apiErr.fields).toEqual({
        email: "That email is already registered.",
        password: "Password must be at least 10 characters.",
      });
      expect(apiErr.requestId).toBe("req_abc123");
      expect(apiErr.status).toBe(422);
      return true;
    });
  });

  it("falls back gracefully on non-JSON error responses using X-Request-Id header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: {
          "Content-Type": "text/html",
          "X-Request-Id": "req_gateway_9",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getDashboard()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe("upstream_error");
      expect(apiErr.status).toBe(502);
      expect(apiErr.requestId).toBe("req_gateway_9");
      expect(apiErr.message).toBe("Something went wrong. Please try again.");
      return true;
    });
  });

  it("wraps network failures as ApiClientError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(api.me()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe("upstream_error");
      expect(apiErr.status).toBe(0);
      return true;
    });
  });
});
