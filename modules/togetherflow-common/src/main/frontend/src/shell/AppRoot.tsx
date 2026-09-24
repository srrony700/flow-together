/**
 * One bootstrap for all four apps: language, auth, tenant, feedback and crash handling,
 * composed in the right order.
 *
 * Each app's `main.tsx` had its own copy of this provider stack, which meant a
 * cross-cutting concern — the i18n provider, the error boundary, the reporting hookup —
 * had to be added in four places and could silently be added in three. Ordering matters
 * and is easy to get subtly wrong: the boundary has to sit *inside* the i18n provider so
 * its own copy can be translated, and *inside* the toast provider so a crash screen can
 * still raise one.
 *
 * The router (W1.3, ADR 0016) is outermost of the app-level providers: auth and tenant
 * both want to read the URL — a deep link has to survive the sign-in round trip — and a
 * provider cannot read a context declared inside it.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { TenantProvider, useTenant } from "../tenant/TenantContext";
import { ToastProvider } from "../components/Toast";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { I18nProvider, mergeCatalogues, type Catalogues } from "../i18n/I18nContext";
import { ShortcutProvider } from "../shortcuts/ShortcutContext";
import { RouterProvider, useLocation } from "../routing/RouterContext";
import { WorkspaceProvider } from "../workspace/WorkspaceContext";
import { WorkspaceApi } from "../api/workspaces";
import { ApiClient } from "../api/client";
import { commonMessages } from "../i18n/messages";
import {
  configureErrorReporting,
  installGlobalErrorHandlers,
  reportVital,
} from "../observability/errorReporting";
import { observeWebVitals } from "../observability/webVitals";
import type { AppLinks, RuntimeConfig } from "../config";

export interface AppRootProps {
  app: keyof AppLinks;
  config: RuntimeConfig;
  /** The app's own catalogues; merged over the shared ones. */
  messages: Catalogues;
  children: ReactNode;
}

export function AppRoot({ app, config, messages, children }: AppRootProps) {
  const catalogues = useMemo(
    () => mergeCatalogues(commonMessages, messages),
    [messages],
  );

  useEffect(() => installGlobalErrorHandlers(), []);

  /*
   * Core Web Vitals (§13.5). Started once per page load, and only where the deployment
   * has somewhere to send them — measuring what nobody collects is pure overhead.
   */
  useEffect(() => {
    if (!config.observability.errorEndpoint) return;
    return observeWebVitals(reportVital);
  }, [config.observability.errorEndpoint]);

  return (
    <I18nProvider catalogues={catalogues} locale={config.locale}>
      <RouterProvider basePath={config.basePath}>
        <AuthProvider baseUrl={config.apiBase} mode={config.auth.mode} oidc={config.auth.oidc}>
          <TenantProvider>
            <ToastProvider>
              <WorkspaceBridge base={config.workspaceBase}>
              <ErrorReportingBridge
                app={app}
                endpoint={config.observability.errorEndpoint}
                release={config.observability.release}
              />
              {/*
                Inside the boundary's providers but outside the boundary itself: a crashed
                screen has unmounted its bindings, so the shortcut set is correct without
                the provider having to know a crash happened.
              */}
              <ShortcutProvider>
                <AppErrorBoundary app={app}>{children}</AppErrorBoundary>
              </ShortcutProvider>
              </WorkspaceBridge>
            </ToastProvider>
          </TenantProvider>
        </AuthProvider>
      </RouterProvider>
    </I18nProvider>
  );
}

/**
 * Resets the crash screen when the user signs in or navigates.
 *
 * A throw on the first authenticated paint (chunk still settling, a race on the
 * first query) used to wedge the whole tab on "This screen stopped working". The
 * boundary's Reload then remounted the app *without* a session and dumped every
 * module back on the login screen. Changing `resetKey` retries that first paint;
 * the session itself now survives a real reload (see AuthContext).
 */
function AppErrorBoundary({
  app,
  children,
}: {
  app: keyof AppLinks;
  children: ReactNode;
}) {
  const { path } = useLocation();
  const { session } = useAuth();
  return (
    <ErrorBoundary boundary={app} resetKey={`${session?.userId ?? ""}:${path}`}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * Mounts the workspace context, but only where the service is configured (ADR 0017).
 *
 * Inside `AuthProvider` because the client needs the caller's credentials, and it builds
 * its own `ApiClient` rather than taking one: three of the four apps never construct one
 * at this level, and making them would be a provider serving a feature they do not have.
 */
function WorkspaceBridge({ base, children }: { base: string; children: ReactNode }) {
  const { session, getAuthHeaders, signOut } = useAuth();
  const { tenantId } = useTenant();

  const api = useMemo(() => {
    /*
     * Not before there is a session. Built eagerly, the provider's first fetch goes out
     * while the login screen is still up, comes back 401, and the status sticks at
     * "unavailable" — so a perfectly healthy service is reported as broken for the whole
     * session. `session.userId` is in the dependencies so signing in rebuilds the client
     * and the fetch runs with credentials.
     */
    if (!base || !session) return undefined;
    return new WorkspaceApi(
      new ApiClient({
        baseUrl: base,
        getAuthHeaders,
        getTenantId: () => tenantId,
        onUnauthorized: signOut,
      }),
    );
  }, [base, session, getAuthHeaders, tenantId, signOut]);

  return <WorkspaceProvider api={api}>{children}</WorkspaceProvider>;
}

/**
 * Registers who is signed in with the reporter. It reads the contexts rather than being
 * handed values so a report always carries the *current* user and tenant — a crash after
 * a tenant switch attributed to the previous tenant is worse than no attribution.
 */
function ErrorReportingBridge({
  app,
  endpoint,
  release,
}: {
  app: keyof AppLinks;
  endpoint?: string;
  release?: string;
}) {
  const { session } = useAuth();
  const { tenantId } = useTenant();

  useEffect(() => {
    configureErrorReporting({
      app: `togetherflow-${app}`,
      endpoint,
      release,
      getUserId: () => session?.userId,
      getTenantId: () => tenantId,
    });
  }, [app, endpoint, release, session?.userId, tenantId]);

  return null;
}
