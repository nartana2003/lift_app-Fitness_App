// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoginPage from "@/app/login/page";

const signInWithPassword = vi.fn();
const signUp = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ auth: { signInWithPassword, signUp } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  signUp.mockResolvedValue({ data: { session: {} }, error: null });
});

function fill(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}

describe("LoginPage", () => {
  it("sign in has an eye toggle and no confirm field", () => {
    render(<LoginPage />);
    expect(screen.queryByPlaceholderText("Confirm password")).toBeNull();
    const input = screen.getByPlaceholderText("Password");
    expect(input).toHaveProperty("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveProperty("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveProperty("type", "password");
  });

  it("sign in still submits email and password", async () => {
    render(<LoginPage />);
    fill("Email", "a@b.co");
    fill("Password", "secret1");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith({ email: "a@b.co", password: "secret1" }));
  });

  it("create account shows a confirm field with its own eye toggle", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /Create an account/ }));
    const confirm = screen.getByPlaceholderText("Confirm password");
    expect(confirm).toHaveProperty("type", "password");
    const toggles = screen.getAllByRole("button", { name: "Show password" });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[1]);
    expect(confirm).toHaveProperty("type", "text");
    expect(screen.getByPlaceholderText("Password")).toHaveProperty("type", "password");
  });

  it("create account blocks mismatched passwords", async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /Create an account/ }));
    fill("Email", "a@b.co");
    fill("Password", "secret1");
    fill("Confirm password", "secret2");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Passwords do not match.")).toBeTruthy();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("create account submits when passwords match", async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /Create an account/ }));
    fill("Email", "a@b.co");
    fill("Password", "secret1");
    fill("Confirm password", "secret1");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    expect(signUp.mock.calls[0][0]).toMatchObject({ email: "a@b.co", password: "secret1" });
  });

  it("switching back to sign in drops the confirm field and message", async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /Create an account/ }));
    fill("Email", "a@b.co");
    fill("Password", "secret1");
    fill("Confirm password", "nope123");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("Passwords do not match.");
    fireEvent.click(screen.getByRole("button", { name: /Have an account/ }));
    expect(screen.queryByPlaceholderText("Confirm password")).toBeNull();
    expect(screen.queryByText("Passwords do not match.")).toBeNull();
  });
});
