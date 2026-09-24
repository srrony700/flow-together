import { useCallback, useMemo, useState } from "react";
import {
  ApiError,
  AsyncBoundary,
  Badge,
  Button,
  Icon,
  Tabs,
  TextInput,
  UserChip,
  ConfirmDialog,
  EmptyState,
  Modal,
  FormRenderer,
  fieldIdsInOrder,
  formValuesToVariables,
  formatDateTime,
  hasRenderableFields,
  initialValues,
  parseStoredUpload,
  serialiseStoredUpload,
  priorityLabel,
  toEditable,
  toRestVariables,
  useAsync,
  useI18n,
  useRegisterShortcuts,
  useToast,
  validateForm,
  validateVariables,
  type EditableVariable,
  type FormValues,
  type Shortcut,
  type IconName,
  type IdmApi,
  type TaskApi,
  serverFormErrors,
  type IdentityLookup,
} from "@togetherflow/common";
import { Attachments } from "./Attachments";
import { VariableEditor } from "./VariableEditor";
import { TaskPeople } from "./TaskPeople";

/**
 * Ties the rendered `<form>` to the Complete button in the task's footer, which sits
 * outside it: `<button form="...">` is what lets a button submit a form it is not
 * inside, and it namespaces the field ids the error summary links to.
 */
const FORM_ID = "tf-task-form";

/** Filled on Employee (MPE); later tasks may view these, never change them. */
const EMPLOYEE_SNAPSHOT_VARIABLES = [
  "initiator",
  "employeeId",
  "employeeName",
  "resignationReason",
  "lastWorkingDay",
  "resignationLetterAttached",
  "resignationLetter",
];

/** Flowable Work's four task tabs (W2.2). */
type TaskTab = "task" | "people" | "subtasks" | "documents";

export interface TaskDetailProps {
  taskApi: TaskApi;
  /**
   * Powers the People tab's search (W2.2). Absent where the deployment runs no IDM, and
   * the picker degrades to typing an id — which is not a courtesy: an assignee is often
   * an id IDM has never heard of.
   */
  idmApi?: IdmApi | null;
  taskId: string | undefined;
  userId: string;
  onCompleted: () => void;
  onChanged: () => void;
  onClose: () => void;
}

export function TaskDetail({
  taskApi,
  idmApi,
  taskId,
  userId,
  onCompleted,
  onChanged,
  onClose,
}: TaskDetailProps) {
  const { t, locale } = useI18n();
  const { push } = useToast();
  /**
   * Edits are tagged with the task they belong to and derived during render rather
   * than synced from an effect. That removes a cascading render and, more usefully,
   * makes it impossible for one task's unsaved edits to appear on another.
   */
  const [edits, setEdits] = useState<{ taskId: string; variables: EditableVariable[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /**
   * Which outcome is pending confirmation. `null` means no dialog; an empty string is a
   * plain completion with no named outcome — the two are genuinely different states.
   */
  const [confirmComplete, setConfirmComplete] = useState<string | null>(null);
  /** W2.2: Task / People / Subtasks / Documents, matching Flowable Work's own tabs. */
  const [tab, setTab] = useState<TaskTab>("task");
  const [savingDraft, setSavingDraft] = useState(false);
  const [editingDue, setEditingDue] = useState(false);
  const [comment, setComment] = useState("");
  const [delegating, setDelegating] = useState(false);
  const [delegateTo, setDelegateTo] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const detail = useAsync(
    async (signal) => {
      if (!taskId) return undefined;
      const [task, taskVariables, comments, attachments, subTasks, people, log] =
        await Promise.all([
          taskApi.get(taskId, signal),
          taskApi.listVariables(taskId, signal).catch(() => []),
          taskApi.listComments(taskId, signal).catch(() => []),
          taskApi.listAttachments(taskId, signal).catch(() => []),
          taskApi.listSubTasks(taskId, signal).catch(() => []),
          taskApi.listIdentityLinks(taskId, signal).catch(() => []),
          // Empty on any engine that has not enabled historic task logging, which is
          // the default — so a failure here must not take the whole panel down.
          taskApi.listLogEntries(taskId, signal).catch(() => undefined),
        ]);
      // Only ask for a form when the task declares one: the endpoint 400s otherwise,
      // and a needless failed request on every task selection is wasteful noise.
      const formResult = task.formKey
        ? await taskApi.getFormResult(taskId, signal, task)
        : { form: null as null };
      return {
        task,
        variables: taskVariables,
        comments,
        attachments,
        form: formResult.form,
        formFailure: formResult.form ? undefined : { status: formResult.status, message: formResult.message },
        subTasks,
        people,
        log,
      };
    },
    [taskApi, taskId, reloadToken],
  );

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const loadedVariables = detail.data?.variables;
  const variables = useMemo<EditableVariable[]>(
    () =>
      edits && edits.taskId === taskId
        ? edits.variables
        : (loadedVariables ?? []).map(toEditable),
    [edits, taskId, loadedVariables],
  );

  const setVariables = useCallback(
    (next: EditableVariable[]) => {
      if (taskId) setEdits({ taskId, variables: next });
    },
    [taskId],
  );

  const form = detail.data?.form ?? undefined;
  const usingForm = hasRenderableFields(form);
  const outcomes = usingForm ? (form?.outcomes ?? []) : [];

  const [formEdits, setFormEdits] = useState<{ taskId: string; values: FormValues } | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  /** Bumped per rejected submit, so a second attempt re-announces rather than going quiet. */
  const [submitAttempt, setSubmitAttempt] = useState(0);

  const formValues = useMemo<FormValues>(
    () =>
      formEdits && formEdits.taskId === taskId
        ? formEdits.values
        : form
          ? initialValues(form)
          : {},
    [formEdits, taskId, form],
  );

  const formErrors = useMemo(
    () => (form ? validateForm(form, formValues, t) : {}),
    [form, formValues, t],
  );

  /**
   * What the engine refused on the last submit (FR-W.4). Kept apart from the browser's
   * own checks: a server error is cleared per field as soon as that field changes, and
   * wholesale on the next attempt, rather than recomputed from the values.
   */
  const [serverErrors, setServerErrors] = useState<{
    taskId: string;
    fields: Record<string, string>;
    general: string[];
  } | null>(null);
  const activeServerErrors = serverErrors && serverErrors.taskId === taskId ? serverErrors : null;
  /** The variable grid alongside a form — operators need the raw values too (FR-W.7). */
  const [showVariables, setShowVariables] = useState(false);

  // Only surface an error once the user has left the field, so a required field
  // is not flagged before it has been filled in for the first time (§14.3).
  const visibleFormErrors = useMemo(() => {
    const visible: Record<string, string> = {};
    for (const [id, message] of Object.entries(formErrors)) {
      if (touched[id]) visible[id] = message;
    }
    // The engine's verdict outranks the browser's guess for the same field.
    for (const [id, message] of Object.entries(activeServerErrors?.fields ?? {})) {
      visible[id] = message;
    }
    return visible;
  }, [formErrors, touched, activeServerErrors]);

  const setFormValue = useCallback(
    (fieldId: string, value: unknown) => {
      if (!taskId) return;
      setServerErrors((previous) => {
        if (!previous || previous.taskId !== taskId || !(fieldId in previous.fields)) return previous;
        const { [fieldId]: _cleared, ...rest } = previous.fields;
        return { ...previous, fields: rest };
      });
      setFormEdits((previous) => ({
        taskId,
        values: {
          ...(previous && previous.taskId === taskId ? previous.values : (form ? initialValues(form) : {})),
          [fieldId]: value,
        },
      }));
    },
    [taskId, form],
  );

  const gridErrors = useMemo(() => validateVariables(variables), [variables]);
  const canSubmit = usingForm
    ? Object.keys(formErrors).length === 0
    : gridErrors.length === 0;

  /**
   * Attempts to complete (§14.1, §14.3).
   *
   * The submit button is never disabled on account of validation. A disabled button
   * explains nothing: on a form where the errors are only revealed once a field has
   * been visited, a user who never touched the required field sees a form with no
   * visible problems and a button that will not respond. Instead the attempt is always
   * accepted, and an invalid form answers by revealing every problem at once and
   * listing them in a summary that takes focus, with a link per problem.
   */
  const attemptComplete = useCallback(
    (outcome: string) => {
      if (usingForm && form && Object.keys(formErrors).length > 0) {
        setTouched(Object.fromEntries(fieldIdsInOrder(form).map((id) => [id, true])));
        setSubmitAttempt((attempt) => attempt + 1);
        return;
      }
      setConfirmComplete(outcome);
    },
    [usingForm, form, formErrors],
  );

  const identityLookup = useMemo<IdentityLookup | undefined>(
    () =>
      idmApi
        ? {
            users: async (query, signal) =>
              (await idmApi.listUsers({ displayNameLike: `%${query}%`, size: 8 }, signal)).data.map((user) => ({
                id: user.id,
                label: user.displayName || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.id,
              })),
            groups: async (query, signal) =>
              (await idmApi.listGroups({ nameLike: `%${query}%`, size: 8 }, signal)).data.map((group) => ({
                id: group.id,
                label: group.name || group.id,
              })),
          }
        : undefined,
    [idmApi],
  );

  const task = detail.data?.task;
  const isAssignedToMe = task?.assignee === userId;
  const isUnassigned = !task?.assignee;
  const lockEmployeeSnapshot = task?.taskDefinitionKey !== "employeeSubmit";
  const lockedVariableNames = lockEmployeeSnapshot ? EMPLOYEE_SNAPSHOT_VARIABLES : [];

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>, then?: () => void) => {
      setBusy(true);
      try {
        await action();
        push({ tone: "success", message: label });
        then?.();
      } catch (cause) {
        const apiError = cause instanceof ApiError ? cause : undefined;
        push({
          tone: "error",
          message: apiError?.message ?? t("task.action.failed"),
          reference: apiError?.correlationId,
        });
        // A conflict usually means someone else acted first — refresh rather than
        // leaving the user looking at state the server has already moved past.
        if (apiError?.isConflict || apiError?.isNotFound) {
          // Someone else moved this task on; show server truth rather than our buffer.
          setEdits(null);
          setFormEdits(null);
          reload();
          onChanged();
        }
      } finally {
        setBusy(false);
      }
    },
    [push, reload, onChanged, t],
  );

  /*
   * Claim and complete without the mouse (§14.4). Registered here rather than at the app
   * root because this is where the actions and the task are — and because "complete this
   * task" should not be a live shortcut when no task is open.
   *
   * Complete opens the confirmation rather than bypassing it: §14.3 requires a
   * consequential action to be confirmed, and a keystroke is not an exemption. Where a
   * form declares named outcomes there is no single "complete", so the shortcut steps
   * aside rather than picking one arbitrarily.
   */
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        key: "c",
        description: t("shortcuts.claim"),
        when: Boolean(task) && isUnassigned && !busy,
        run: () => {
          if (!task) return;
          void runAction(t("task.action.claimed"), async () => {
            await taskApi.claim(task.id, userId);
            reload();
            onChanged();
          });
        },
      },
      {
        key: "d",
        description: t("shortcuts.complete"),
        when: Boolean(task) && isAssignedToMe && canSubmit && outcomes.length === 0 && !busy,
        run: () => setConfirmComplete(""),
      },
    ],
    [
      t,
      task,
      isUnassigned,
      isAssignedToMe,
      canSubmit,
      outcomes.length,
      busy,
      runAction,
      taskApi,
      userId,
      reload,
      onChanged,
    ],
  );
  useRegisterShortcuts(shortcuts);

  if (!taskId) {
    return (
      <aside className="tf-detail tf-detail--empty">
        <EmptyState
          title={t("task.detail.none.title")}
          description={t("task.detail.none.description")}
        />
      </aside>
    );
  }

  return (
    <aside className="tf-detail" aria-label={t("task.detail.label")}>
      <AsyncBoundary
        loading={detail.loading}
        error={detail.error}
        data={detail.data}
        onRetry={reload}
        skeletonRows={8}
      >
        {(loaded) => {
          if (!loaded) return null;
          const { task: current, comments, attachments } = loaded;
          return (
            <>
              <header className="tf-detail__header">
                <div>
                  <h2 className="tf-detail__title">{current.name ?? t("inbox.untitled")}</h2>
                  <p className="tf-detail__meta">
                    {current.assignee ? (
                      // D1: the raw id, on the screen whose subject is who is doing what.
                      <UserChip userId={current.assignee} compact />
                    ) : (
                      <span className="tf-muted">{t("inbox.unassigned")}</span>
                    )}
                    {" · "}
                    {t("task.detail.priorityLine", {
                      priority: priorityLabel(current.priority, t),
                    })}
                    {current.scopeType === "cmmn" ? (
                      <>
                        {" · "}
                        <Badge tone="info">
                          {t("task.detail.caseBadge")}
                        </Badge>
                      </>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  className="tf-detail__close"
                  onClick={onClose}
                  aria-label={t("task.detail.close")}
                >
                  ×
                </button>
              </header>

              {/*
                W2.2's status ribbon. Flowable Work bands a task by urgency across the
                whole detail, not just its due-date cell: grey for assigned-and-not-due,
                yellow for unassigned or due later, red for overdue. Colour is never the
                only signal — the ribbon carries the sentence too (WCAG 1.4.1).
              */}
              {(() => {
                const status = taskStatus(current, userId);
                return (
                  <p className={`tf-ribbon tf-ribbon--${status.tone}`} role="status">
                    <Icon name={status.icon} size={16} />
                    {t(status.key, status.params)}
                  </p>
                );
              })()}

              {current.description ? (
                <p className="tf-detail__description">{current.description}</p>
              ) : null}

              <dl className="tf-detail__facts">
                <Fact
                  label={t("task.fact.created")}
                  value={formatDateTime(current.createTime, locale)}
                />
                {/* W2.2: read-only in the facts list before; a task's due date is the
                    single most-adjusted field on it. */}
                <div className="tf-detail__fact">
                  <dt>{t("task.fact.due")}</dt>
                  <dd>
                    {editingDue ? (
                      <div className="tf-due-editor">
                        <TextInput
                          label={t("task.fact.due")}
                          hideLabel
                          type="date"
                          defaultValue={toDateInput(current.dueDate)}
                          disabled={busy}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setEditingDue(false);
                          }}
                          onBlur={(event) => {
                            const next = event.target.value;
                            setEditingDue(false);
                            if (next === toDateInput(current.dueDate)) return;
                            void runAction(t("task.due.updated"), async () => {
                              // Null clears it — the engine distinguishes "not sent" from
                              // "sent as null" through its own duedateSet flag.
                              await taskApi.update(current.id, {
                                dueDate: next ? new Date(`${next}T12:00:00`).toISOString() : null,
                              });
                              reload();
                              onChanged();
                            });
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="tf-link-button"
                        disabled={busy}
                        onClick={() => setEditingDue(true)}
                      >
                        {current.dueDate
                          ? formatDateTime(current.dueDate, locale)
                          : t("format.noDueDate")}
                      </button>
                    )}
                  </dd>
                </div>
                {current.owner ? (
                  <Fact label={t("task.fact.owner")} value={current.owner} />
                ) : null}
                {current.category ? (
                  <Fact label={t("task.fact.category")} value={current.category} />
                ) : null}
              </dl>

              {/*
                W2.2: Flowable Work's task detail is four tabs — Task, People, Subtasks,
                Documents — and ours stacked every section vertically, so the form a user
                came to fill in sat above five things they did not. Comments and history
                stay on the Task tab: they are the conversation *about* this task, not a
                separate subject.
              */}
              <Tabs
                label={t("task.tabs.label")}
                active={tab}
                onChange={setTab}
                tabs={[
                  { id: "task", label: t("task.tabs.task") },
                  {
                    id: "people",
                    label: t("task.tabs.people"),
                    count: Array.isArray(detail.data?.people) ? detail.data.people.length : 0,
                  },
                  {
                    id: "subtasks",
                    label: t("task.tabs.subtasks"),
                    count: Array.isArray(detail.data?.subTasks) ? detail.data.subTasks.length : 0,
                  },
                  { id: "documents", label: t("task.tabs.documents"), count: attachments.length },
                ]}
              >
                {tab === "task" ? (
                  <>
                  <section className="tf-detail__section">
                    <h3 className="tf-detail__section-title">
                      {usingForm ? form?.name || t("task.section.form") : t("task.section.variables")}
                    </h3>
                    {usingForm && form && activeServerErrors?.general.length ? (
                      <p className="tf-detail__note tf-detail__note--error" role="alert">
                        {t("form.server.rejected")} {activeServerErrors.general.join(" ")}
                      </p>
                    ) : null}
                    {usingForm && form ? (
                      <FormRenderer
                        id={FORM_ID}
                        model={form}
                        values={formValues}
                        errors={visibleFormErrors}
                        submitAttempt={submitAttempt}
                        identityLookup={identityLookup}
                        disabled={busy || !isAssignedToMe}
                        // Enter in a field completes the task, the same as the footer button.
                        onSubmit={() => attemptComplete(outcomes[0]?.name ?? "")}
                        onChange={setFormValue}
                        onBlur={(fieldId) => setTouched((previous) => ({ ...previous, [fieldId]: true }))}
                        /*
                         * An upload field stores the attachment's id. The file itself goes
                         * through the task's own attachment endpoint, so it lands in
                         * whichever store the deployment has configured (§7.6) rather than
                         * needing a content engine this distribution does not ship.
                         */
                        fileUrl={(_field, value) => {
                          const stored = parseStoredUpload(value);
                          return stored
                            ? taskApi.attachmentContentUrl(stored.taskId, stored.id)
                            : undefined;
                        }}
                        onUploadFile={async (field, file) => {
                          const attachment = await taskApi.uploadAttachment(current.id, file, {
                            name: file.name,
                            description: t("task.form.uploadedFor", {
                              field: field.name ?? field.id,
                            }),
                          });
                          reload();
                          return serialiseStoredUpload({
                            id: attachment.id,
                            taskId: current.id,
                            name: file.name,
                          });
                        }}
                      />
                    ) : (
                      <>
                        {current.formKey ? (
                          <p className="tf-detail__note">
                            <code>{current.formKey}</code> —{" "}
                            {detail.data?.formFailure?.status
                              ? t("task.form.unloadableStatus", {
                                  status: detail.data.formFailure.status,
                                  message: detail.data.formFailure.message ?? "",
                                })
                              : t("task.form.unloadable")}
                          </p>
                        ) : null}
                        <VariableEditor
                          variables={variables}
                          onChange={setVariables}
                          disabled={busy || !isAssignedToMe}
                          lockedNames={lockedVariableNames}
                        />
                      </>
                    )}
                    {usingForm && form ? (
                      <div className="tf-detail__variables-toggle">
                        <button
                          type="button"
                          className="tf-link-button"
                          aria-expanded={showVariables}
                          onClick={() => setShowVariables((open) => !open)}
                        >
                          {showVariables ? t("task.form.hideVariables") : t("task.form.showVariables")}
                        </button>
                        {showVariables ? (
                          <VariableEditor
                            variables={variables}
                            onChange={setVariables}
                            disabled={busy || !isAssignedToMe}
                            lockedNames={lockedVariableNames}
                          />
                        ) : null}
                      </div>
                    ) : null}
                    {!isAssignedToMe ? (
                      <p className="tf-detail__note">{t("task.form.claimFirst")}</p>
                    ) : null}
                  </section>

                  <section className="tf-detail__section">
                    <h3 className="tf-detail__section-title">
                      {comments.length
                        ? t("task.section.commentsCount", { count: comments.length })
                        : t("task.section.comments")}
                    </h3>
                    {comments.length === 0 ? (
                      <p className="tf-muted">{t("task.comments.none")}</p>
                    ) : (
                      <ul className="tf-comments">
                        {comments.map((entry) => (
                          <li key={entry.id} className="tf-comments__item">
                            <p className="tf-comments__meta">
                              <strong>
                            {entry.author ? (
                              <UserChip userId={entry.author} />
                            ) : (
                              t("task.comments.unknownAuthor")
                            )}
                          </strong>{" "}
                          ·{" "}
                              {formatDateTime(entry.time, locale)}
                            </p>
                            <p className="tf-comments__message">{entry.message}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="tf-comments__compose">
                      <label className="tf-visually-hidden" htmlFor="tf-new-comment">
                        {t("task.comments.add")}
                      </label>
                      <textarea
                        id="tf-new-comment"
                        className="tf-input tf-textarea"
                        rows={2}
                        placeholder={t("task.comments.placeholder")}
                        value={comment}
                        disabled={busy}
                        onChange={(event) => setComment(event.target.value)}
                      />
                      <Button
                        variant="secondary"
                        disabled={busy || comment.trim() === ""}
                        onClick={() =>
                          runAction(t("task.comments.added"), async () => {
                            await taskApi.addComment(current.id, comment.trim());
                            setComment("");
                            reload();
                          })
                        }
                      >
                        {t("task.comments.submit")}
                      </Button>
                    </div>
                  </section>
                  <section className="tf-detail__section">
                    <h3 className="tf-detail__section-title">{t("task.section.history")}</h3>
                    {/*
                      The shape is checked, not assumed. An endpoint that answers with
                      something unexpected must not take the whole panel down with it —
                      which is exactly what reading `.data.length` off a non-page did.
                    */}
                    {!Array.isArray(detail.data?.log?.data) ? (
                      <p className="tf-muted">{t("task.history.unreadable")}</p>
                    ) : detail.data.log.data.length === 0 ? (
                      <p className="tf-muted">{t("task.history.none")}</p>
                    ) : (
                      <ol className="tf-tasklog">
                        {detail.data.log.data.map((entry) => (
                          <li className="tf-tasklog__item" key={entry.logNumber}>
                            <span className="tf-tasklog__type">
                              {entry.type ?? t("task.history.event")}
                            </span>
                            <span className="tf-tasklog__when">
                              {formatDateTime(entry.timeStamp, locale)}
                            </span>
                            {entry.userId ? (
                              <span className="tf-tasklog__who">
                                {t("task.history.by", { userId: entry.userId })}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                  </>
                ) : null}

                {tab === "people" ? (
                <section className="tf-detail__section">
                  <h3 className="tf-detail__section-title">{t("task.section.people")}</h3>
                  <TaskPeople
                    taskApi={taskApi}
                    idmApi={idmApi}
                    taskId={current.id}
                    links={Array.isArray(detail.data?.people) ? detail.data.people : []}
                    disabled={busy}
                    onChanged={reload}
                  />
                </section>
                ) : null}

                {tab === "subtasks" ? (
                <section className="tf-detail__section">
                  <h3 className="tf-detail__section-title">
                    {t("task.section.subTasks", {
                      count: Array.isArray(detail.data?.subTasks) ? detail.data.subTasks.length : 0,
                    })}
                  </h3>
                  {!Array.isArray(detail.data?.subTasks) || detail.data.subTasks.length === 0 ? (
                    <p className="tf-muted">{t("task.subTasks.none")}</p>
                  ) : (
                    <ul className="tf-people">
                      {detail.data.subTasks.map((sub) => (
                        <li className="tf-people__item" key={sub.id}>
                          <span className="tf-people__who">
                            <UserChip userId={sub.assignee ?? ""} name={sub.name ?? sub.id} />
                          </span>
                          <span className="tf-people__how">
                            {sub.assignee
                              ? t("task.subTasks.assignedTo", { assignee: sub.assignee })
                              : t("task.subTasks.unassigned")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                ) : null}

                {tab === "documents" ? (
                <section className="tf-detail__section">
                  <h3 className="tf-detail__section-title">
                    {attachments.length
                      ? t("task.section.attachmentsCount", { count: attachments.length })
                      : t("task.section.attachments")}
                  </h3>
                  <Attachments
                    taskApi={taskApi}
                    taskId={current.id}
                    attachments={attachments}
                    disabled={busy}
                    onChanged={reload}
                  />
                </section>

                ) : null}
              </Tabs>

              {/*
                The action bar is pinned to the bottom of the pane (see
                `.tf-detail__actions` in work.css), and split so that finishing the task
                cannot be crowded out.

                Before: one flex row of up to four buttons, Complete last. In a 420px pane
                it wrapped onto a second line, and that line sat below Variables, Comments
                and History — measured at y=932 in a 900px-tall viewport, so the one thing
                a task inbox exists for was off screen behind three sections that were
                usually empty.

                Now: secondary actions group left, the completing action sits right and
                alone. When the pane is too narrow the secondary group wraps within
                itself; the primary never moves.
              */}
              <footer className="tf-detail__actions">
                <div className="tf-detail__actions-secondary">
                  {isAssignedToMe ? (
                    <>
                      <Button
                        variant="secondary"
                        loading={busy}
                        onClick={() =>
                          runAction(t("task.action.unclaimed"), async () => {
                            await taskApi.unclaim(current.id);
                            reload();
                            onChanged();
                          })
                        }
                      >
                        {t("task.action.unclaim")}
                      </Button>
                      <Button variant="secondary" loading={busy} onClick={() => setDelegating(true)}>
                        {t("task.action.delegate")}
                      </Button>
                    {/*
                      W2.2: Save, beside Complete — "the most-missed everyday affordance
                      in the list". Flowable Work's default outcomes are Complete *and*
                      Save; without it a half-finished form is lost on navigation.
                      It is not an engine action — there is no "save" verb — but a
                      variable write, which is what completing does minus the completion.
                    */}
                      <Button
                        variant="secondary"
                        loading={savingDraft}
                        disabled={busy}
                        onClick={() => {
                          setSavingDraft(true);
                          const values = usingForm && form
                            ? formValuesToVariables(form, formValues)
                            : toRestVariables(variables);
                          void taskApi
                            .saveVariables(current.id, values)
                            .then(() => {
                              push({ tone: "success", message: t("task.action.saved") });
                              onChanged();
                            })
                            .catch((cause) => {
                              const apiError = cause instanceof ApiError ? cause : undefined;
                              push({
                                tone: "error",
                                message: apiError?.message ?? t("task.action.saveFailed"),
                                reference: apiError?.correlationId,
                              });
                            })
                            .finally(() => setSavingDraft(false));
                        }}
                      >
                        <Icon name="save" size={16} />
                        {t("task.action.save")}
                      </Button>
                    </>
                  ) : null}
                </div>

                <div className="tf-detail__actions-primary">
                  {isUnassigned ? (
                    <Button
                      loading={busy}
                      onClick={() =>
                        runAction(t("task.action.claimed"), async () => {
                          await taskApi.claim(current.id, userId);
                          reload();
                          onChanged();
                        })
                      }
                    >
                      {t("task.action.claim")}
                    </Button>
                  ) : null}

                  {/*
                    A form may name its own outcomes ("Approve", "Reject"). Each is a
                    distinct submit that records which was chosen, so they replace the
                    generic Complete rather than sitting beside it.
                  */}
                  {isAssignedToMe ? (
                    outcomes.length > 0 ? (
                      outcomes.map((outcome) => (
                        <Button
                          key={outcome.id ?? outcome.name}
                          loading={busy}
                          disabled={!usingForm && !canSubmit}
                          onClick={() => attemptComplete(outcome.name)}
                        >
                          {outcome.name}
                        </Button>
                      ))
                    ) : (
                      <Button
                        loading={busy}
                        disabled={!usingForm && !canSubmit}
                        onClick={() => attemptComplete("")}
                      >
                        {t("task.action.complete")}
                      </Button>
                    )
                  ) : null}

                  {/*
                    A delegated task sits with the delegate until they hand it back.
                    Resolving returns it to the owner — it does not complete it.
                  */}
                  {current.delegationState === "pending" && current.assignee === userId ? (
                    <Button
                      loading={busy}
                      onClick={() =>
                        runAction(
                          t("task.action.handedBack", {
                            owner: current.owner ?? t("task.action.owner"),
                          }),
                          async () => {
                            await taskApi.resolve(current.id);
                            reload();
                            onChanged();
                          },
                        )
                      }
                    >
                      {t("task.action.handBack", { owner: current.owner ?? t("task.action.owner") })}
                    </Button>
                  ) : null}
                </div>
              </footer>

              {delegating ? (
                <Modal
                  open
                  title={t("task.delegate.title")}
                  description={t("task.delegate.description")}
                  size="sm"
                  // Typed input: a stray backdrop click must not discard it.
                  dismissOnBackdrop={false}
                  onClose={() => setDelegating(false)}
                  actions={
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setDelegating(false)}
                      >
                        {t("dialog.cancel")}
                      </Button>
                      <Button
                        loading={busy}
                        disabled={!delegateTo.trim()}
                        onClick={() => {
                          const to = delegateTo.trim();
                          setDelegating(false);
                          setDelegateTo("");
                          void runAction(t("task.delegate.done", { to }), async () => {
                            await taskApi.delegate(current.id, to);
                            reload();
                            onChanged();
                          });
                        }}
                      >
                        {t("task.action.delegate")}
                      </Button>
                    </>
                  }
                >
                  <TextInput
                    label={t("task.delegate.to")}
                    value={delegateTo}
                    hint={t("task.delegate.hint")}
                    onChange={(event) => setDelegateTo(event.target.value)}
                  />
                </Modal>
              ) : null}

              {/*
                Only the variable grid needs a note here. A form answers for itself: the
                renderer lists every problem in a summary above the fields once a submit
                has been attempted, which is both more specific and where the user is
                already looking.
              */}
              {!usingForm && !canSubmit ? (
                <p className="tf-detail__note tf-detail__note--error" role="alert">
                  {t("task.validation.variables")}
                </p>
              ) : null}

              <ConfirmDialog
                open={confirmComplete !== null}
                title={
                  confirmComplete
                    ? t("task.confirm.outcome.title", { outcome: confirmComplete })
                    : t("task.confirm.complete.title")
                }
                description={
                  confirmComplete
                    ? t("task.confirm.outcome.description", {
                        name: current.name ?? t("task.confirm.thisTask"),
                        outcome: confirmComplete,
                      })
                    : t("task.confirm.complete.description", {
                        name: current.name ?? t("task.confirm.thisTask"),
                      })
                }
                confirmLabel={confirmComplete || t("task.action.complete")}
                busy={busy}
                onCancel={() => setConfirmComplete(null)}
                onConfirm={() => {
                  const outcome = confirmComplete;
                  setConfirmComplete(null);
                  void runAction(t("task.action.completed"), async () => {
                    if (usingForm && form?.id) {
                      // Through the form engine: it validates against the form, converts
                      // to typed variables, writes the outcome variable and records the
                      // submission (FR-S.1). A refusal names every failing field.
                      try {
                        await taskApi.completeWithForm(
                          current.id,
                          form.id,
                          outcome || undefined,
                          formValuesToVariables(form, formValues),
                          current,
                        );
                      } catch (cause) {
                        const refused = serverFormErrors(cause, form, t);
                        if (refused) {
                          setServerErrors({ taskId: current.id, ...refused });
                          setTouched(Object.fromEntries(fieldIdsInOrder(form).map((id) => [id, true])));
                          setSubmitAttempt((attempt) => attempt + 1);
                        }
                        throw cause;
                      }
                      onCompleted();
                      return;
                    }
                    const submitted = toRestVariables(variables);
                    // A form without an id is one the engine could not serve as a
                    // definition; the outcome then travels as a plain variable, named
                    // by the form or by the engine's default of "form_<key>_outcome".
                    if (outcome && form) {
                      submitted.push({
                        name: form.outcomeVariableName || `form_${form.key ?? "form"}_outcome`,
                        type: "string",
                        value: outcome,
                      });
                    }
                    await taskApi.complete(current.id, submitted, current);
                    onCompleted();
                  });
                }}
              />
            </>
          );
        }}
      </AsyncBoundary>
    </aside>
  );
}

/**
 * W2.2's status bands, matching Flowable Work's: grey for assigned with no urgency,
 * yellow for unassigned or due later, red for overdue.
 *
 * Overdue outranks unassigned — an overdue task nobody owns is an overdue task, and
 * telling the user the less urgent of two true things is the wrong choice.
 */
export function taskStatus(
  task: { assignee?: string; dueDate?: string | null },
  userId: string,
): { tone: "neutral" | "warning" | "danger"; icon: IconName; key: string; params?: Record<string, string | number> } {
  const due = task.dueDate ? new Date(task.dueDate) : null;
  const overdue = due !== null && !Number.isNaN(due.getTime()) && due.getTime() < Date.now();

  if (overdue) return { tone: "danger", icon: "warning", key: "task.status.overdue" };
  if (!task.assignee) return { tone: "warning", icon: "user", key: "task.status.unassigned" };
  if (due) return { tone: "warning", icon: "clock", key: "task.status.dueLater" };
  return {
    tone: "neutral",
    icon: "check",
    key: task.assignee === userId ? "task.status.yours" : "task.status.assigned",
    params: { assignee: task.assignee },
  };
}

/** `<input type="date">` wants `yyyy-mm-dd`; the engine speaks ISO instants. */
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="tf-detail__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
