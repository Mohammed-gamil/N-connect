import * as React from "react";
import type { LoginRequest, Me, RegisterRequest } from "../../contracts";
import { api, ApiClientError } from "../../lib/api";

interface AuthContextValue {
  user: Me["user"] | null;
  organization: Me["organization"] | null;
  loading: boolean;
  login: (body: LoginRequest) => Promise<Me>;
  register: (body: RegisterRequest) => Promise<Me>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refreshMe = React.useCallback(async () => {
    try {
      const me = await api.me();
      setSession(me);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setSession(null);
      } else {
        setSession(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then((me) => {
        setSession(me);
        setLoading(false);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setSession(null);
        setLoading(false);
      });

    return () => controller.abort();
  }, []);

  const login = React.useCallback(async (body: LoginRequest) => {
    const me = await api.login(body);
    setSession(me);
    return me;
  }, []);

  const register = React.useCallback(async (body: RegisterRequest) => {
    const me = await api.register(body);
    setSession(me);
    return me;
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setSession(null);
    }
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      organization: session?.organization ?? null,
      loading,
      login,
      register,
      logout,
      refreshMe,
    }),
    [session, loading, login, register, logout, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
