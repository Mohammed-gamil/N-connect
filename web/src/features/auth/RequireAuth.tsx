import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Skeleton } from "../../components/ui";
import { useAuth } from "./AuthContext";

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas" aria-label="Loading workspace">
        <div className="h-14 border-b border-border bg-surface">
          <div className="mx-auto flex h-full max-w-5xl items-center justify-between px-4 sm:px-6">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-8 w-28" />
          </div>
        </div>
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
          <Skeleton className="h-8 w-56" />
          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
          <Skeleton className="mt-8 h-48 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
