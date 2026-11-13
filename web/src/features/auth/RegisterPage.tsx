import * as React from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
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

interface RegisterErrors {
  name?: string;
  email?: string;
  password?: string;
  form?: string;
}

export function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState<RegisterErrors>({});
  const [submitting, setSubmitting] = React.useState(false);

  if (user) {
    return <Navigate to="/" replace />;
  }

  function validate(): RegisterErrors {
    const next: RegisterErrors = {};
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      next.name = "Enter your name.";
    } else if (trimmedName.length > 80) {
      next.name = "Name must be 80 characters or fewer.";
    }

    if (!trimmedEmail) {
      next.email = "Enter your email address.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      next.email = "Enter a valid email address.";
    }

    if (!password) {
      next.password = "Password must be at least 10 characters.";
    } else if (password.length < 10) {
      next.password = "Password must be at least 10 characters.";
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
      await register({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrors({
          name: err.fields?.name,
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
          <CardTitle className="text-xl">Create your account</CardTitle>
          <CardDescription>
            Start automating ClickUp and Slack in under a minute.
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
              <Label htmlFor="register-name">Your name</Label>
              <Input
                id="register-name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Alex Rivera"
                value={name}
                error={Boolean(errors.name)}
                aria-describedby={errors.name ? "register-name-error" : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
                }}
              />
              {errors.name && (
                <p id="register-name-error" className="text-xs text-danger-text">
                  {errors.name}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="register-email">Email address</Label>
              <Input
                id="register-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                error={Boolean(errors.email)}
                aria-describedby={errors.email ? "register-email-error" : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
                }}
              />
              {errors.email && (
                <p id="register-email-error" className="text-xs text-danger-text">
                  {errors.email}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="register-password">Password</Label>
              <Input
                id="register-password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder="Choose a strong password"
                value={password}
                error={Boolean(errors.password)}
                aria-describedby={
                  errors.password
                    ? "register-password-hint register-password-error"
                    : "register-password-hint"
                }
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
                }}
              />
              <p id="register-password-hint" className="text-xs text-ink-muted">
                Must be at least 10 characters.
              </p>
              {errors.password && (
                <p id="register-password-error" className="text-xs text-danger-text">
                  {errors.password}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" size="lg" loading={submitting}>
              Create account
            </Button>
          </form>

          <p className="mt-5 text-center text-sm text-ink-secondary">
            Already have an account?{" "}
            <Link
              to="/login"
              className="font-medium text-accent hover:text-accent-hover focus-visible:outline-none focus-visible:underline"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
