/**
 * Session state for TogetherFlow.
 *
 * Two modes, selected by configuration (see docs/ui/adr/0006-oidc-authentication.md):
 *
 * - `oidc`   — production. Authorization Code + PKCE against the deployment's identity
 *              provider; tokens held in memory and renewed silently.
 * - `basic`  — local development only. HTTP Basic against the engine's REST layer.
 *              The session is kept in `sessionStorage` for the life of the tab so a
 *              reload (or the error-boundary "Reload the page" button) does not bounce
 *              back to the login screen. Closing the tab still signs out. Refuses to
 *              run over plain HTTP on a non-loopback host, because Basic replays a
 *              reusable credential on every request.
 *
 * Feature code never sees this distinction: it consumes `session` / `signIn` /
 * `signOut` and the API client consumes `getAuthHeaders`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User, UserManager } from "oidc-client-ts";
import { ApiClient, ApiError } from "../api/client";
import {
  authHeaderFor,
  clearCallbackParams,
  createUserManager,
  isRedirectCallback,
  type OidcConfig,
} from "./oidc";

export interface Session {
  userId: string;
  displayName?: string;
  /** Ready-to-send Authorization header value. */
  authHeader: string;
}

export type AuthMode = "oidc" | "basic";

interface AuthContextValue {
  session: Session | null;
  mode: AuthMode;
  /** Only meaningful in `basic` mode; in `oidc` mode it starts the redirect. */
  signIn: (userId?: string, password?: string) => Promise<void>;
  signOut: () => void;
  isSigningIn: boolean;
  /** True while an OIDC redirect callback is being completed on first load. */
  isInitialising: boolean;
  getAuthHeaders: () => Record<string, string> | undefined;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  baseUrl: string;
  mode?: AuthMode;
  oidc?: OidcConfig;
  children: ReactNode;
  fetchImpl?: typeof fetch;
}

export function AuthProvider({
  baseUrl,
  mode = "oidc",
  oidc,
  children,
  fetchImpl,
}: AuthProviderProps) {
  if (mode === "oidc" && !oidc) {
    throw new Error(
      "AuthProvider: mode 'oidc' requires an oidc config (authority and clientId).",
    );
  }
  if (mode === "basic") {
    assertBasicAuthIsSafe();
  }

  const restored = mode === "basic" ? readStoredBasicSession() : null;
  const [session, setSession] = useState<Session | null>(restored);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isInitialising, setIsInitialising] = useState(mode === "oidc");

  // Held in a ref so the API client's header callback always reads the current
  // token without every request re-subscribing to React state. Seeded from the
  // restored session so the first request after a reload is already authenticated.
  const authHeaderRef = useRef<string | null>(restored?.authHeader ?? null);

  // Lazy state initialiser rather than a ref written during render: the manager must
  // be constructed exactly once, and mutating a ref mid-render is unsafe under
  // concurrent rendering (and StrictMode's double invocation).
  const [manager] = useState<UserManager | null>(() =>
    mode === "oidc" && oidc ? createUserManager(oidc) : null,
  );

  const applyUser = useCallback((user: User | null) => {
    const header = authHeaderFor(user);
    authHeaderRef.current = header?.Authorization ?? null;
    if (!user || !header) {
      setSession(null);
      return;
    }
    const claims = user.profile ?? {};
    setSession({
      // Flowable matches its IDM users on the token's subject/preferred_username;
      // preferred_username is what lines up with the engine's user ids.
      userId: String(claims.preferred_username ?? claims.sub ?? ""),
      displayName: typeof claims.name === "string" ? claims.name : undefined,
      authHeader: header.Authorization,
    });
  }, []);

  // Complete a redirect callback, or pick up an existing session, on first load.
  useEffect(() => {
    if (mode !== "oidc") return;
    if (!manager) return;
    let cancelled = false;

    (async () => {
      try {
        if (isRedirectCallback()) {
          const user = await manager.signinRedirectCallback();
          clearCallbackParams();
          if (!cancelled) applyUser(user);
        } else {
          const user = await manager.getUser();
          if (!cancelled) applyUser(user && !user.expired ? user : null);
        }
      } catch (error) {
        // A failed callback must not strand the user on a blank screen; fall back
        // to the signed-out state so they can retry the login.
        console.error("OIDC initialisation failed", error);
        clearCallbackParams();
        if (!cancelled) applyUser(null);
      } finally {
        if (!cancelled) setIsInitialising(false);
      }
    })();

    const onUserLoaded = (user: User) => applyUser(user);
    const onUserUnloaded = () => applyUser(null);
    const onExpired = () => applyUser(null);
    manager.events.addUserLoaded(onUserLoaded);
    manager.events.addUserUnloaded(onUserUnloaded);
    manager.events.addAccessTokenExpired(onExpired);

    return () => {
      cancelled = true;
      manager.events.removeUserLoaded(onUserLoaded);
      manager.events.removeUserUnloaded(onUserUnloaded);
      manager.events.removeAccessTokenExpired(onExpired);
    };
  }, [mode, manager, applyUser]);

  const signIn = useCallback(
    async (userId?: string, password?: string) => {
      setIsSigningIn(true);
      try {
        if (mode === "oidc") {
          await manager?.signinRedirect();
          return; // Navigates away; nothing further to do.
        }

        if (!userId || !password) {
          throw new ApiError("Enter both your username and password.", 400, "local", undefined);
        }
        const authHeader = `Basic ${base64(`${userId}:${password}`)}`;
        // Verify credentials before storing them, so a bad password surfaces on the
        // login screen rather than as a failure on the first real screen.
        const probe = new ApiClient({
          baseUrl,
          fetchImpl,
          getAuthHeaders: () => ({ Authorization: authHeader }),
        });
        await probe.request("/query/tasks", {
          method: "POST",
          body: { size: 1, candidateOrAssigned: userId },
        });
        authHeaderRef.current = authHeader;
        const next = { userId, authHeader };
        storeBasicSession(next);
        setSession(next);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          throw new ApiError("Incorrect username or password.", 401, error.correlationId, error.body);
        }
        throw error;
      } finally {
        setIsSigningIn(false);
      }
    },
    [mode, manager, baseUrl, fetchImpl],
  );

  const signOut = useCallback(() => {
    authHeaderRef.current = null;
    storeBasicSession(null);
    setSession(null);
    if (mode === "oidc") {
      // End the IdP session too; otherwise the next sign-in silently reuses it and
      // "sign out" appears not to work.
      void manager?.signoutRedirect().catch((error) => {
        console.error("OIDC sign-out failed", error);
      });
    }
  }, [mode, manager]);

  const getAuthHeaders = useCallback(
    () => (authHeaderRef.current ? { Authorization: authHeaderRef.current } : undefined),
    [],
  );

  const value = useMemo(
    () => ({ session, mode, signIn, signOut, isSigningIn, isInitialising, getAuthHeaders }),
    [session, mode, signIn, signOut, isSigningIn, isInitialising, getAuthHeaders],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

/**
 * Basic auth replays a reusable credential on every request, so over plain HTTP it is
 * trivially interceptable. Loopback is allowed for local development; anything else
 * fails fast rather than shipping credentials in the clear.
 */
const BASIC_SESSION_KEY = "togetherflow.basicSession";

function readStoredBasicSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(BASIC_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { userId, authHeader, displayName } = parsed as Partial<Session>;
    if (
      typeof userId !== "string" ||
      !userId ||
      typeof authHeader !== "string" ||
      !authHeader.startsWith("Basic ")
    ) {
      return null;
    }
    return {
      userId,
      authHeader,
      displayName: typeof displayName === "string" ? displayName : undefined,
    };
  } catch {
    // Private windows and blocked site data throw; a corrupt value is the same as none.
    return null;
  }
}

function storeBasicSession(session: Session | null): void {
  try {
    if (session) {
      window.sessionStorage.setItem(BASIC_SESSION_KEY, JSON.stringify(session));
    } else {
      window.sessionStorage.removeItem(BASIC_SESSION_KEY);
    }
  } catch {
    // Remembering the session is a convenience; failing to is not worth an error.
  }
}

function assertBasicAuthIsSafe(): void {
  if (typeof window === "undefined") return;
  const { protocol, hostname } = window.location;
  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (protocol !== "https:" && !isLoopback) {
    throw new Error(
      "Basic authentication is only permitted over HTTPS or on localhost. " +
        "Configure OIDC (auth.mode = 'oidc') for this deployment — see docs/ui/adr/0006-oidc-authentication.md.",
    );
  }
}

/**
 * btoa() throws on any code point above U+00FF, so UTF-8 encode first — otherwise a
 * password containing a non-Latin-1 character fails at sign-in with an opaque error.
 */
function base64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
