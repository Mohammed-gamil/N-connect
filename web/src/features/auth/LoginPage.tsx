import * as React from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Zap } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "../../components/ui";
import { ApiClientError } from "../../lib/api";
import { useAuth } from "./AuthContext";

interface LoginErrors {
  email?: string;
  password?: string;
  form?: string;
}

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || "/";

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState<LoginErrors>({});
  const [submitting, setSubmitting] = React.useState(false);

  if (user) {
    return <Navigate to="/" replace />;
  }

  function validate(): LoginErrors {
    const next: LoginErrors = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      next.email = "Enter your email address.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      next.email = "Enter a valid email address.";
    }
    if (!password) {
      next.password = "Enter your password.";
    }
    return next;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      await login({ email: email.trim(), password });
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrors({
          email: err.fields?.email,
          password: err.fields?.password,
          form: err.message,
        });
      } else {
        setErrors({ form: "Something went wrong. Please try again." });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="mb-6 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Zap className="h-4 w-4" aria-hidden="true" />
        </div>
        <span className="text-base font-semibold tracking-tight text-ink">
          Integration Hub
        </span>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>
            Sign in to manage your connected apps and automations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {errors.form && (
              <div
                role="alert"
                className="rounded-lg border border-danger-border bg-danger-soft px-3.5 py-2.5 text-sm text-danger-text"
              >
                {errors.form}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email address</Label>
              <Input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                error={Boolean(errors.email)}
                aria-describedby={errors.email ? "login-email-error" : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
                }}
              />
              {errors.email && (
                <p id="login-email-error" className="text-xs text-danger-text">
                  {errors.email}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                error={Boolean(errors.password)}
                aria-describedby={errors.password ? "login-password-error" : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
                }}
              />
              {errors.password && (
                <p id="login-password-error" className="text-xs text-danger-text">
                  {errors.password}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" size="lg" loading={submitting}>
              Sign in
            </Button>
          </form>

          <p className="mt-5 text-center text-sm text-ink-secondary">
            Don&apos;t have an account?{" "}
            <Link
              to="/register"
              className="font-medium text-accent hover:text-accent-hover focus-visible:outline-none focus-visible:underline"
            >
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
