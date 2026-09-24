/** Typed wrappers over the Flowable REST resources this app uses. */

import { ApiError, type ApiClient } from "./client";
import type {
  AttachmentLinkRequest,
  AttachmentResponse,
  CommentResponse,
  DataResponse,
  FormModelResponse,
  HistoricProcessInstanceQueryRequest,
  HistoricProcessInstanceResponse,
  HistoricTaskInstanceQueryRequest,
  HistoricTaskInstanceResponse,
  ProcessDefinitionResponse,
  ProcessInstanceCreateRequest,
  ProcessInstanceResponse,
  RestVariable,
  TaskActionRequest,
  TaskIdentityLink,
  TaskLogEntry,
  TaskQueryRequest,
  TaskResponse,
} from "./types";

/**
 * Where a task comes from. Tasks are one table shared by both engines, and most task
 * operations go through the process API whatever created the task — but completing a
 * task (with or without a form) and reading its form must go to the engine that owns
 * it: the process engine refuses to complete a case task ("should be completed via
 * the cmmn engine API"), and only the case engine resolves the task's form against
 * the case deployment it belongs to. Pass the task itself; only `scopeType` is read.
 */
export interface TaskScope {
  scopeType?: string | null;
}

export class TaskApi {
  /**
   * @param client the process API
   * @param gatewayBaseUrl base URL of `togetherflow-attachment-gateway`, set only where
   *   the deployment uses a non-`db` attachment provider (§7.6). Unset is the default
   *   `db` behaviour: bytes go straight to Flowable and no gateway exists.
   * @param cmmnClient the CMMN API, used for the scope-bound calls on case tasks (see
   *   {@link TaskScope}). Without it every call goes to the process API, and completing
   *   a case task is refused by the engine.
   */
  constructor(
    private readonly client: ApiClient,
    private readonly gatewayBaseUrl?: string,
    private readonly cmmnClient?: ApiClient,
  ) {}

  /** The engine a scope-bound call goes to, with that engine's path prefixes. */
  private engine(scope?: TaskScope): { client: ApiClient; runtime: string; history: string } {
    if (scope?.scopeType === "cmmn" && this.cmmnClient) {
      return { client: this.cmmnClient, runtime: "/cmmn-runtime", history: "/cmmn-history" };
    }
    return { client: this.client, runtime: "/runtime", history: "/history" };
  }

  /** POST /query/tasks — the filterable inbox query. */
  query(request: TaskQueryRequest, signal?: AbortSignal): Promise<DataResponse<TaskResponse>> {
    const tenantId = this.client.tenantId;
    return this.client.request("/query/tasks", {
      method: "POST",
      body: tenantId ? { ...request, tenantId } : request,
      signal,
    });
  }

  get(taskId: string, signal?: AbortSignal): Promise<TaskResponse> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}`, { signal });
  }

  action(taskId: string, request: TaskActionRequest, scope?: TaskScope): Promise<void> {
    const engine = this.engine(scope);
    return engine.client.request(`${engine.runtime}/tasks/${encodeURIComponent(taskId)}`, {
      method: "POST",
      body: request,
    });
  }

  claim(taskId: string, assignee: string): Promise<void> {
    return this.action(taskId, { action: "claim", assignee });
  }

  unclaim(taskId: string): Promise<void> {
    return this.action(taskId, { action: "unclaim" });
  }

  /** Completes with plain variables. `scope` routes a case task to the CMMN API. */
  complete(taskId: string, variables?: RestVariable[], scope?: TaskScope): Promise<void> {
    return this.action(taskId, { action: "complete", variables }, scope);
  }

  /**
   * Completes through the form engine (`completeTaskWithForm`): the engine validates
   * the values against the form, converts them to typed variables, writes the outcome
   * variable and records the submission as a form instance. A refusal is a 400 whose
   * body lists every failing field — see `serverFormErrors`.
   */
  completeWithForm(
    taskId: string,
    formDefinitionId: string,
    outcome: string | undefined,
    variables: RestVariable[],
    scope?: TaskScope,
  ): Promise<void> {
    return this.action(
      taskId,
      {
        action: "complete",
        formDefinitionId,
        ...(outcome ? { outcome } : {}),
        variables,
      },
      scope,
    );
  }

  listVariables(taskId: string, signal?: AbortSignal): Promise<RestVariable[]> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/variables`, { signal });
  }

  listComments(taskId: string, signal?: AbortSignal): Promise<CommentResponse[]> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/comments`, { signal });
  }

  addComment(taskId: string, message: string): Promise<CommentResponse> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/comments`, {
      method: "POST",
      body: { message, saveProcessInstanceId: true },
    });
  }

  /**
   * GET /runtime/tasks/{taskId}/form.
   *
   * Returns null rather than throwing for the expected "no form here" cases: the
   * endpoint 400s when the task has no formKey, and fails outright when no form
   * engine is deployed. Callers fall back to the variable grid.
   */
  async getForm(taskId: string, signal?: AbortSignal, scope?: TaskScope): Promise<FormModelResponse | null> {
    try {
      const engine = this.engine(scope);
      return await engine.client.request<FormModelResponse>(
        `${engine.runtime}/tasks/${encodeURIComponent(taskId)}/form`,
        { signal },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return null;
    }
  }

  /**
   * Like {@link getForm}, but says *why* there is no form when there is none, so the
   * screen can name the form key and the status rather than a generic "could not be
   * loaded" (FR-W.9). `status` is the HTTP status of the refusal, or 0 for a network
   * failure.
   */
  async getFormResult(
    taskId: string,
    signal?: AbortSignal,
    scope?: TaskScope,
  ): Promise<{ form: FormModelResponse | null; status?: number; message?: string }> {
    try {
      const engine = this.engine(scope);
      const form = await engine.client.request<FormModelResponse>(
        `${engine.runtime}/tasks/${encodeURIComponent(taskId)}/form`,
        { signal },
      );
      return { form };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const apiError = error instanceof ApiError ? error : undefined;
      return { form: null, status: apiError?.status ?? 0, message: apiError?.message ?? String(error) };
    }
  }

  /**
   * GET /history/historic-task-instances/{taskId}/form — the recorded submission of a
   * completed task, with `submittedBy`, `submittedDate` and `selectedOutcome`. Null when
   * the task has no form or nothing was recorded for it.
   */
  async getHistoricForm(taskId: string, signal?: AbortSignal, scope?: TaskScope): Promise<FormModelResponse | null> {
    try {
      const engine = this.engine(scope);
      return await engine.client.request<FormModelResponse>(
        `${engine.history}/historic-task-instances/${encodeURIComponent(taskId)}/form`,
        { signal },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return null;
    }
  }

  /** Sub-tasks (§7.1). Returns a bare array, not a paged response. */
  listSubTasks(taskId: string, signal?: AbortSignal): Promise<TaskResponse[]> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/subtasks`, { signal });
  }

  /** Who is involved with this task, and how (assignee, candidate, participant…). */
  listIdentityLinks(taskId: string, signal?: AbortSignal): Promise<TaskIdentityLink[]> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/identitylinks`, {
      signal,
    });
  }

  addIdentityLink(
    taskId: string,
    link: { userId?: string; groupId?: string; type: string },
  ): Promise<TaskIdentityLink> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/identitylinks`, {
      method: "POST",
      body: link,
    });
  }

  removeIdentityLink(
    taskId: string,
    family: "users" | "groups",
    identityId: string,
    type: string,
  ): Promise<void> {
    return this.client.request(
      `/runtime/tasks/${encodeURIComponent(taskId)}/identitylinks/${family}/${encodeURIComponent(identityId)}/${encodeURIComponent(type)}`,
      { method: "DELETE" },
    );
  }

  /**
   * The task's audit trail.
   *
   * **Empty unless the engine opts in.** `enableHistoricTaskLogging` defaults to
   * `false` on `ProcessEngineConfiguration`, so a stock deployment records nothing —
   * confirmed against a running engine, where the whole-engine query returns 0 rows.
   * The UI therefore distinguishes "nothing happened yet" from "this engine does not
   * record task history" rather than showing a permanently empty list.
   */
  listLogEntries(taskId: string, signal?: AbortSignal): Promise<DataResponse<TaskLogEntry>> {
    return this.client.request("/history/historic-task-log-entries", {
      query: { taskId, size: 100, sort: "logNumber", order: "desc" },
      signal,
    });
  }

  /**
   * Hands the task to someone else to do on your behalf.
   *
   * Verified against a running engine: the original assignee becomes `owner`, the
   * delegate becomes `assignee`, and `delegationState` goes to `pending`. Resolving
   * hands it back to the owner — it does *not* complete the task.
   */
  delegate(taskId: string, assignee: string): Promise<void> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}`, {
      method: "POST",
      body: { action: "delegate", assignee },
    });
  }

  /** Returns a delegated task to its owner. */
  resolve(taskId: string): Promise<void> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}`, {
      method: "POST",
      body: { action: "resolve" },
    });
  }

  /** Reassignment is a task *update*, not an action — there is no "assign" action. */
  assign(taskId: string, assignee: string | null): Promise<TaskResponse> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      body: { assignee },
    });
  }

  /**
   * Creates a task that belongs to no process (W2.2, "New → Task").
   *
   * `TaskCollectionResource` has supported this all along and nothing in the UI used it —
   * which is the whole of the gap the plan records. A standalone task is how someone
   * captures work that has no model behind it yet.
   */
  create(request: TaskUpdate, signal?: AbortSignal): Promise<TaskResponse> {
    const tenantId = this.client.tenantId;
    return this.client.request("/runtime/tasks", {
      method: "POST",
      body: tenantId ? { ...request, tenantId } : request,
      signal,
    });
  }

  /**
   * Updates a task's own fields — the editable due date W2.2 asks for, and the rest.
   *
   * `dueDate: null` clears it. The engine distinguishes "not sent" from "sent as null"
   * through its `duedateSet` flag, so an explicit null is the only way to remove a due
   * date; omitting the key leaves it alone.
   */
  update(taskId: string, changes: TaskUpdate): Promise<TaskResponse> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      body: changes,
    });
  }

  /**
   * Persists form data without completing the task (W2.2).
   *
   * The plan calls this "the most-missed everyday affordance in the list", and it is not
   * an engine action — there is no "save" verb. It is a variable write against the task,
   * which is exactly what completing would do minus the completion.
   *
   * The collection resource does not accept PUT (verified against OpenAPI and
   * `TaskVariableCollectionResource`: GET/POST/DELETE only). Create is POST on the
   * collection; update is PUT on `/variables/{name}`. Posting a name that already
   * exists 409s; putting a name that does not 404s. Scope has to match: `initiator`
   * is global, and putting it as local is a miss.
   */
  async saveVariables(taskId: string, variables: RestVariable[]): Promise<RestVariable[]> {
    const byName = new Map<string, RestVariable>();
    for (const variable of variables) {
      const name = variable.name?.trim();
      if (name) byName.set(name, { ...variable, name });
    }
    const unique = [...byName.values()];
    if (unique.length === 0) return [];

    const existing = await this.listVariables(taskId);
    const existingByName = new Map(existing.map((variable) => [variable.name, variable]));

    const created: RestVariable[] = [];
    const updated: RestVariable[] = [];
    const toCreate = new Map<string, RestVariable[]>();

    for (const variable of unique) {
      const current = existingByName.get(variable.name);
      if (current) {
        const scope = current.scope ?? variable.scope ?? "local";
        updated.push(
          await this.client.request(
            `/runtime/tasks/${encodeURIComponent(taskId)}/variables/${encodeURIComponent(variable.name)}`,
            { method: "PUT", body: { ...variable, scope } },
          ),
        );
      } else {
        const scope = variable.scope ?? "local";
        const batch = toCreate.get(scope) ?? [];
        batch.push({ ...variable, scope });
        toCreate.set(scope, batch);
      }
    }

    for (const batch of toCreate.values()) {
      // The collection insists every variable in one POST shares a scope.
      const result = await this.client.request<RestVariable[] | RestVariable>(
        `/runtime/tasks/${encodeURIComponent(taskId)}/variables`,
        { method: "POST", body: batch },
      );
      created.push(...(Array.isArray(result) ? result : [result]));
    }

    return [...updated, ...created];
  }

  listAttachments(taskId: string, signal?: AbortSignal): Promise<AttachmentResponse[]> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/attachments`, {
      signal,
    });
  }

  /**
   * Uploads bytes into the engine's own storage — the default `db` attachment
   * provider (REQUIREMENTS.md §7.6). The resource takes the first file part
   * regardless of its field name, and reads name/description/type as form fields.
   */
  /**
   * Attaches a file to a task.
   *
   * Two paths, chosen by configuration alone (§7.6):
   *
   * - **No gateway (`db`, the default):** multipart straight to Flowable, whose engine
   *   stores the bytes itself. Zero extra infrastructure.
   * - **Gateway configured (`filesystem` / `sharepoint`):** the file goes to
   *   `togetherflow-attachment-gateway`, which stores it and returns a URL; that URL is
   *   registered against the task as an `externalUrl` attachment, so no bytes pass
   *   through the engine.
   *
   * Both produce the same kind of attachment as far as every screen is concerned:
   * Flowable's own model holds either a `contentId` or a `url` per row and the two
   * coexist, so switching provider never migrates what is already stored.
   */
  async uploadAttachment(
    taskId: string,
    file: File,
    meta: { name?: string; description?: string; type?: string } = {},
  ): Promise<AttachmentResponse> {
    const name = meta.name?.trim() || file.name;
    const type = meta.type || file.type || "application/octet-stream";

    if (this.gatewayBaseUrl) {
      const stored = await this.uploadThroughGateway(taskId, file);
      return this.addAttachmentLink(taskId, {
        name,
        description: meta.description,
        type,
        externalUrl: stored.url,
      });
    }

    const form = new FormData();
    form.append("name", name);
    if (meta.description) form.append("description", meta.description);
    form.append("type", type);
    form.append("file", file, file.name);

    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: "POST",
      body: form,
    });
  }

  /**
   * Sends the bytes to the gateway.
   *
   * Plain `fetch`, not the ApiClient: the gateway is a separate service on its own base
   * URL, and forwarding the engine's credentials to it would be wrong.
   */
  private async uploadThroughGateway(
    taskId: string,
    file: File,
  ): Promise<{ url: string; fileName: string }> {
    const form = new FormData();
    form.append("taskId", taskId);
    form.append("file", file, file.name);

    const response = await fetch(`${this.gatewayBaseUrl!.replace(/\/+$/, "")}/attachments`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    if (!response.ok) {
      // §13.4: Work must stay usable when the gateway is down, so the message says what
      // to do instead rather than only that something broke.
      throw new ApiError(
        response.status === 413
          ? "That file is larger than this deployment allows."
          : "Attachment storage is unavailable. Try again, or attach a link instead.",
        response.status,
        // The gateway is a separate service and issues no correlation id of its own.
        "",
        undefined,
      );
    }
    return (await response.json()) as { url: string; fileName: string };
  }

  /**
   * Registers a link instead of bytes. This is the same seam a SharePoint or
   * filesystem provider uses once the gateway exists (§7.6) — nothing about this
   * call changes when the provider does.
   */
  addAttachmentLink(
    taskId: string,
    request: AttachmentLinkRequest,
  ): Promise<AttachmentResponse> {
    return this.client.request(`/runtime/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: "POST",
      body: request,
    });
  }

  deleteAttachment(taskId: string, attachmentId: string): Promise<void> {
    return this.client.request(
      `/runtime/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    );
  }

  /** Absolute URL for downloading engine-stored content. */
  attachmentContentUrl(taskId: string, attachmentId: string): string {
    return this.client.buildUrl(
      `/runtime/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
    );
  }
}

/**
 * The fields `TaskRequest` accepts on create and update. Deliberately not the whole of
 * `TaskResponse`: most of what a task carries is engine-owned and read-only.
 */
export interface TaskUpdate {
  name?: string;
  description?: string;
  assignee?: string | null;
  owner?: string | null;
  /** ISO instant, or null to clear. See `update` for why null is meaningful. */
  dueDate?: string | null;
  priority?: number;
  category?: string;
  parentTaskId?: string;
  formKey?: string;
}

export class HistoryApi {
  constructor(private readonly client: ApiClient) {}

  queryTasks(
    request: HistoricTaskInstanceQueryRequest,
    signal?: AbortSignal,
  ): Promise<DataResponse<HistoricTaskInstanceResponse>> {
    const tenantId = this.client.tenantId;
    return this.client.request("/query/historic-task-instances", {
      method: "POST",
      body: tenantId ? { ...request, tenantId } : request,
      signal,
    });
  }

  queryProcessInstances(
    request: HistoricProcessInstanceQueryRequest,
    signal?: AbortSignal,
  ): Promise<DataResponse<HistoricProcessInstanceResponse>> {
    const tenantId = this.client.tenantId;
    return this.client.request("/query/historic-process-instances", {
      method: "POST",
      body: tenantId ? { ...request, tenantId } : request,
      signal,
    });
  }
}

export class ProcessApi {
  constructor(private readonly client: ApiClient) {}

  listDefinitions(
    params: { latest?: boolean; suspended?: boolean; size?: number; nameLike?: string } = {},
    signal?: AbortSignal,
  ): Promise<DataResponse<ProcessDefinitionResponse>> {
    return this.client.request("/repository/process-definitions", {
      query: {
        latest: params.latest ?? true,
        suspended: params.suspended ?? false,
        size: params.size ?? 100,
        nameLike: params.nameLike,
        tenantId: this.client.tenantId,
        sort: "name",
      },
      signal,
    });
  }

  /** GET /repository/process-definitions/{id}/start-form; null when none is defined. */
  async getStartForm(
    definitionId: string,
    signal?: AbortSignal,
  ): Promise<FormModelResponse | null> {
    try {
      return await this.client.request<FormModelResponse>(
        `/repository/process-definitions/${encodeURIComponent(definitionId)}/start-form`,
        { signal },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return null;
    }
  }

  start(request: ProcessInstanceCreateRequest): Promise<ProcessInstanceResponse> {
    const tenantId = this.client.tenantId;
    return this.client.request("/runtime/process-instances", {
      method: "POST",
      body: tenantId ? { ...request, tenantId } : request,
    });
  }
}

/**
 * CMMN lives behind its own servlet prefix, so it takes a separately-configured client
 * rather than reusing the process one.
 */

/*
 * The CMMN runtime API (case instances, plan items, milestones, start) lives in
 * `cases.ts`. An earlier stub here duplicated its definition-list and start calls and
 * was never wired to a screen; it was folded in rather than left to drift.
 */
