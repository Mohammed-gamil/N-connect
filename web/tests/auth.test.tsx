import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/ui";
import { AuthProvider } from "../src/features/auth/AuthContext";
import { LoginPage } from "../src/features/auth/LoginPage";
import { RegisterPage } from "../src/features/auth/RegisterPage";
import { api, ApiClientError } from "../src/lib/api";

function renderAuthRoute(initialPath: "/login" | "/register") {
  vi.spyOn(api, "me").mockRejectedValue(
    new ApiClientError("unauthenticated", "Please sign in.", undefined, "req_1", 401),
  );

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/" element={<div>Dashboard Home</div>} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("Auth pages", () => {
  it("shows inline validation errors on LoginPage when fields are empty or invalid", async () => {
    const user = userEvent.setup();
    const loginSpy = vi.spyOn(api, "login");
    renderAuthRoute("/login");

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(loginSpy).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Email address"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
  });

  it("displays server error and redirects to / on successful login", async () => {
    const user = userEvent.setup();
    const loginSpy = vi
      .spyOn(api, "login")
      .mockRejectedValueOnce(
        new ApiClientError(
          "unauthenticated",
          "Incorrect email or password.",
          undefined,
          "req_2",
          401,
        ),
      )
      .mockResolvedValueOnce({
        user: { id: "usr_1", name: "Alex", email: "alex@example.com" },
        organization: { id: "org_1", name: "Alex's Workspace" },
      });

    renderAuthRoute("/login");

    await user.type(screen.getByLabelText("Email address"), "alex@example.com");
    await user.type(screen.getByLabelText("Password"), "correcthorsebattery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Incorrect email or password.",
    );

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText("Dashboard Home")).toBeInTheDocument();
    });
    expect(loginSpy).toHaveBeenCalledTimes(2);
  });

  it("shows password >= 10 chars hint and validates registration fields", async () => {
    const user = userEvent.setup();
    const registerSpy = vi.spyOn(api, "register").mockResolvedValue({
      user: { id: "usr_2", name: "Maya", email: "maya@example.com" },
      organization: { id: "org_2", name: "Maya's Workspace" },
    });

    renderAuthRoute("/register");

    expect(screen.getByText("Must be at least 10 characters.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Your name"), "Maya");
    await user.type(screen.getByLabelText("Email address"), "maya@example.com");
    await user.type(screen.getByLabelText("Password"), "short123");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      screen.getByText("Password must be at least 10 characters."),
    ).toBeInTheDocument();
    expect(registerSpy).not.toHaveBeenCalled();

    const passwordInput = screen.getByLabelText("Password");
    await user.clear(passwordInput);
    await user.type(passwordInput, "super-secure-passphrase");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByText("Dashboard Home")).toBeInTheDocument();
    });
    expect(registerSpy).toHaveBeenCalledWith({
      name: "Maya",
      email: "maya@example.com",
      password: "super-secure-passphrase",
    });
  });
});
