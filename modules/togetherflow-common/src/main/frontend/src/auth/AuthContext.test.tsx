import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

const signinRedirect = vi.fn().mockResolvedValue(undefined);
const signoutRedirect = vi.fn().mockResolvedValue(undefined);
const getUser = vi.fn().mockResolvedValue(null);
const signinRedirectCallback = vi.fn();

vi.mock("oidc-client-ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("oidc-client-ts")>();
  return {
    ...actual,
    UserManager: class {
      events = {
        addUserLoaded: vi.fn(),
        addUserUnloaded: vi.fn(),
        addAccessTokenExpired: vi.fn(),
        removeUserLoaded: vi.fn(),
        removeUserUnloaded: vi.fn(),
        removeAccessTokenExpired: vi.fn(),
      };
      signinRedirect = signinRedirect;
      signoutRedirect = signoutRedirect;
      getUser = getUser;
      signinRedirectCallback = signinRedirectCallback;
    },
  };
});

function Probe() {
  const { session, mode, signIn, signOut, isInitialising, getAuthHeaders } = useAuth();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="init">{String(isInitialising)}</span>
      <span data-testid="user">{session?.userId ?? "none"}</span>
      <span data-testid="header">{getAuthHeaders()?.Authorization ?? "none"}</span>
      <button onClick={() => void signIn("alice", "secret")}>sign in</button>
      <button onClick={signOut}>sign out</button>
    </div>
  );
}

const OIDC = { authority: "https://idp.example.com/realms/Flowable", clientId: "togetherflow-ui" };

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear();
});

describe("AuthProvider — oidc mode", () => {
  it("is the default mode", async () => {
    render(
      <AuthProvider baseUrl="/process-api" oidc={OIDC}>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("mode")).toHaveTextContent("oidc");
    await waitFor(() => expect(screen.getByTestId("init")).toHaveTextContent("false"));
  });

  it("refuses to start without an oidc config rather than downgrading auth", () => {
    // A misconfigured deployment must fail loudly, not silently fall back to Basic.
    expect(() =>
      render(
        <AuthProvider baseUrl="/process-api">
          <Probe />
        </AuthProvider>,
      ),
    ).toThrow(/requires an oidc config/i);
  });

  it("starts a redirect instead of collecting credentials", async () => {
    render(
      <AuthProvider baseUrl="/process-api" oidc={OIDC}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("init")).toHaveTextContent("false"));

    await userEvent.click(screen.getByRole("button", { name: "sign in" }));
    expect(signinRedirect).toHaveBeenCalled();
  });

  it("adopts an existing non-expired session on load", async () => {
    getUser.mockResolvedValueOnce({
      access_token: "tok-123",
      token_type: "Bearer",
      expired: false,
      profile: { preferred_username: "alice", name: "Alice A" },
    });

    render(
      <AuthProvider baseUrl="/process-api" oidc={OIDC}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("alice"));
    expect(screen.getByTestId("header")).toHaveTextContent("Bearer tok-123");
  });

  it("ignores an expired stored session", async () => {
    getUser.mockResolvedValueOnce({
      access_token: "stale",
      expired: true,
      profile: { preferred_username: "alice" },
    });

    render(
      <AuthProvider baseUrl="/process-api" oidc={OIDC}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("init")).toHaveTextContent("false"));
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  it("completes a redirect callback and clears the code from the URL", async () => {
    window.history.replaceState({}, "", "/?code=abc&state=xyz");
    signinRedirectCallback.mockResolvedValueOnce({
      access_token: "tok-cb",
      token_type: "Bearer",
      expired: false,
      profile: { preferred_username: "bob" },
    });

    render(
      <AuthProvider baseUrl="/process-api" oidc={OIDC}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("bob"));
    // Leaving ?code= in the URL would make a reload try to redeem a spent code.
    expect(window.location.search).not.toContain("code=");
  });

  it("recovers to signed-out if the callback fails, rather than hanging", async () => {
    window.history.replaceState({}, "", "/?code=bad&state=xyz");
    signinRedirectCallback.mockRejectedValueOnce(new Error("invalid_grant"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AuthProvider baseUrl="/process-api" oidc={OIDC}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("init")).toHaveTextContent("false"));
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    consoleError.mockRestore();
  });

  it("ends the IdP session on sign-out", async () => {
    getUser.mockResolvedValueOnce({
      access_token: "tok",
      token_type: "Bearer",
      expired: false,
      profile: { preferred_username: "alice" },
    });
    render(
      <AuthProvider baseUrl="/process-api" oidc={OIDC}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("alice"));

    await userEvent.click(screen.getByRole("button", { name: "sign out" }));

    expect(screen.getByTestId("user")).toHaveTextContent("none");
    // Without this, the next sign-in silently reuses the IdP session.
    expect(signoutRedirect).toHaveBeenCalled();
  });
});

describe("AuthProvider — basic mode", () => {
  it("signs in against the REST layer and exposes a Basic header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total: 0, start: 0, size: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(
      <AuthProvider baseUrl="/process-api" mode="basic" fetchImpl={fetchImpl as never}>
        <Probe />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "sign in" }));

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("alice"));
    expect(screen.getByTestId("header")).toHaveTextContent(`Basic ${btoa("alice:secret")}`);
  });

  it("is allowed on localhost (jsdom's default origin)", () => {
    expect(() =>
      render(
        <AuthProvider baseUrl="/process-api" mode="basic">
          <Probe />
        </AuthProvider>,
      ),
    ).not.toThrow();
  });

  it("restores a basic session after remount so a reload stays signed in", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total: 0, start: 0, size: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const first = render(
      <AuthProvider baseUrl="/process-api" mode="basic" fetchImpl={fetchImpl as never}>
        <Probe />
      </AuthProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "sign in" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("alice"));
    first.unmount();

    render(
      <AuthProvider baseUrl="/process-api" mode="basic" fetchImpl={fetchImpl as never}>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("user")).toHaveTextContent("alice");
    expect(screen.getByTestId("header")).toHaveTextContent(`Basic ${btoa("alice:secret")}`);
  });

  it("forgets the stored basic session on sign-out", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total: 0, start: 0, size: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(
      <AuthProvider baseUrl="/process-api" mode="basic" fetchImpl={fetchImpl as never}>
        <Probe />
      </AuthProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "sign in" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("alice"));

    await userEvent.click(screen.getByRole("button", { name: "sign out" }));
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(window.sessionStorage.getItem("togetherflow.basicSession")).toBeNull();
  });

  it("ignores a corrupt stored basic session rather than crashing", () => {
    window.sessionStorage.setItem("togetherflow.basicSession", "{not-json");
    render(
      <AuthProvider baseUrl="/process-api" mode="basic">
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });
});
