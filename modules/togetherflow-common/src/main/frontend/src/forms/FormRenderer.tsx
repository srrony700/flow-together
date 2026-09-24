/**
 * Renders a Flowable form model (REQUIREMENTS.md §7.1 Forms).
 *
 * Native to Flowable's own SimpleFormModel schema — see
 * docs/ui/adr/0007-flowable-native-form-renderer.md for why this is not an adapter
 * over @bpmn-io/form-js.
 *
 * Three things here are deliberate and easy to undo by accident:
 *
 *   - It renders a real `<form>`. That is what makes Enter submit, what lets an action
 *     button that lives outside the form (Work's Complete button sits in the task's
 *     footer) target it with `form="..."`, and what gives assistive tech a form to
 *     announce. The element is inert without `onSubmit`, so a preview can still mount it.
 *   - A model-level read-only field renders as a *value*, not as a disabled input.
 *     Disabled controls are the least readable thing on a page, and greying out a
 *     control to say "this one was decided elsewhere" is a worse sentence than showing
 *     the answer. A form that is only *temporarily* unavailable — an unclaimed task —
 *     keeps real disabled inputs, because that state is about the moment, not the field.
 *   - Errors appear inline *and*, after a submit attempt, as a summary that takes focus.
 *     A long form whose submit button silently does nothing is the failure mode this
 *     exists to prevent.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FormField, FormModelResponse, OptionFormField } from "../api/types";
import { useI18n, useT, type TFunction } from "../i18n/I18nContext";
import { isFieldVisible } from "./visibility";
import {
  fieldConstraints,
  fieldLabel,
  isContainer,
  isOptionField,
  parseStoredUpload,
  toDateInputValue,
  type FieldConstraints,
  type FormErrors,
  type FormValues,
} from "./formModel";

export interface FormRendererProps {
  model: FormModelResponse;
  values: FormValues;
  errors?: FormErrors;
  /**
   * The whole form is unavailable right now — an unclaimed task, or a request in
   * flight. Distinct from a field the *model* marks read-only, which is permanent and
   * renders as a value instead of a control.
   */
  disabled?: boolean;
  onChange: (fieldId: string, value: unknown) => void;
  /** Called when a field loses focus, so validation can run per-field (§14.3). */
  onBlur?: (fieldId: string) => void;
  /**
   * Handles an `upload` field's file, returning what should be stored as the field's
   * value (typically an attachment id or URL).
   *
   * Only a task has somewhere to put a file — the attachment endpoint hangs off the
   * task — so a start form is rendered without this and says so rather than showing a
   * control that cannot work. Omitting it is a deliberate, supported state.
   */
  onUploadFile?: (field: FormField, file: File) => Promise<string>;
  /**
   * Download URL for a stored upload. Needed on a later task: the attachment lives
   * on the task that received the file, not on the one displaying it.
   */
  fileUrl?: (field: FormField, value: unknown) => string | undefined;
  /**
   * Resolves `people` and `functional-group` fields against the identity store
   * (FR-W.5). Absent where the deployment runs no IDM — the fields then take a typed
   * id, which is what the engine stores either way.
   */
  identityLookup?: IdentityLookup;
  /**
   * Id of the `<form>` element, so a submit button rendered outside it can point at it
   * with `form={id}`. Also namespaces field ids, which lets two forms coexist.
   */
  id?: string;
  /** Submits the form: pressing Enter in a field, or a `type="submit"` button. */
  onSubmit?: () => void;
  /**
   * Bumped by the caller on every attempt to submit. Non-zero renders the error
   * summary; a change re-focuses it, so a second failed attempt is not silent either.
   */
  submitAttempt?: number;
}

export interface IdentityChoice {
  id: string;
  label: string;
}

export interface IdentityLookup {
  users: (query: string, signal?: AbortSignal) => Promise<IdentityChoice[]>;
  groups: (query: string, signal?: AbortSignal) => Promise<IdentityChoice[]>;
}

export function FormRenderer({
  model,
  values,
  errors = {},
  disabled = false,
  onChange,
  onBlur,
  onUploadFile,
  fileUrl,
  identityLookup,
  id,
  onSubmit,
  submitAttempt = 0,
}: FormRendererProps) {
  const prefix = id ?? "tf-form";
  const domId = (fieldId: string) => `${prefix}-${fieldId}`;

  const shared: NodeContext = {
    values,
    errors,
    disabled,
    onChange,
    onBlur,
    onUploadFile,
    fileUrl,
    identityLookup,
    domId,
  };

  return (
    <form
      className="tf-form"
      id={id}
      // Browser-native validation would show its own bubbles in its own copy, in the
      // browser's language rather than the app's, and would stop before this form's
      // rules ever ran.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <ErrorSummary
        model={model}
        errors={errors}
        attempt={submitAttempt}
        domId={domId}
      />
      {(model.fields ?? []).map((field, index) => (
        <FieldNode key={field.id || `field-${index}`} field={field} {...shared} />
      ))}
    </form>
  );
}

interface NodeContext {
  values: FormValues;
  errors: FormErrors;
  disabled: boolean;
  onChange: (fieldId: string, value: unknown) => void;
  onBlur?: (fieldId: string) => void;
  onUploadFile?: (field: FormField, file: File) => Promise<string>;
  fileUrl?: (field: FormField, value: unknown) => string | undefined;
  identityLookup?: IdentityLookup;
  domId: (fieldId: string) => string;
}

type NodeProps = NodeContext & { field: FormField };

/* ── Error summary ─────────────────────────────────────────────────────────── */

/**
 * The problems, listed once, at the top, after a submit attempt (§14.1).
 *
 * Takes focus so a keyboard or screen-reader user is moved to the list rather than left
 * at a button that appeared to do nothing; each entry moves focus to its own field.
 */
function ErrorSummary({
  model,
  errors,
  attempt,
  domId,
}: {
  model: FormModelResponse;
  errors: FormErrors;
  attempt: number;
  domId: (fieldId: string) => string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const problems = orderedProblems(model, errors);
  const show = attempt > 0 && problems.length > 0;

  useEffect(() => {
    // Deliberately keyed on the attempt alone: re-focusing whenever the error list
    // changes would yank focus out of the field the user is in the middle of fixing.
    if (attempt > 0) ref.current?.focus();
  }, [attempt]);

  if (!show) return null;

  return (
    <div
      className="tf-form__summary"
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-labelledby={`${domId("errors")}-title`}
    >
      <h3 className="tf-form__summary-title" id={`${domId("errors")}-title`}>
        {t("form.errors.title", { count: problems.length })}
      </h3>
      <ul className="tf-form__summary-list">
        {problems.map((problem) => (
          <li key={problem.fieldId}>
            <a
              className="tf-form__summary-link"
              href={`#${domId(problem.fieldId)}`}
              onClick={(event) => {
                // Anchoring to a control focuses it in most browsers but not all, and
                // not for a radio group whose target is its first option.
                const target = document.getElementById(domId(problem.fieldId));
                if (!target) return;
                event.preventDefault();
                target.focus();
                // Not in every environment (jsdom has no layout), and scrolling is the
                // nicety here — focus is the part that matters.
                target.scrollIntoView?.({ block: "center", behavior: "smooth" });
              }}
            >
              {problem.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Problem {
  fieldId: string;
  message: string;
}

/** Errors in the order the form presents their fields, not in object-key order. */
function orderedProblems(model: FormModelResponse, errors: FormErrors): Problem[] {
  const problems: Problem[] = [];
  const walk = (fields: FormField[] | undefined) => {
    for (const field of fields ?? []) {
      if (isContainer(field)) {
        for (const row of field.fields ?? []) walk(row);
      } else if (errors[field.id]) {
        problems.push({ fieldId: field.id, message: errors[field.id] });
      }
    }
  };
  walk(model.fields);
  return problems;
}

/* ── Field dispatch ────────────────────────────────────────────────────────── */

function FieldNode({ field, ...rest }: NodeProps) {
  // Presentation-only: a hidden field is simply not rendered. Its value, if any was
  // entered before the condition turned, is still submitted — hiding is not clearing.
  if (!isFieldVisible(field, rest.values)) return null;

  if (isContainer(field)) {
    return (
      <div className="tf-form__container">
        {(field.fields ?? []).map((row, rowIndex) => (
          <div className="tf-form__grid" key={rowIndex}>
            {row.map((child, colIndex) => (
              <div
                className="tf-form__col"
                key={child.id || `${rowIndex}-${colIndex}`}
                // A 12-column grid means a colspan in the model is the colspan on screen;
                // without one, the row's columns share the width evenly.
                style={{ "--tf-col-span": columnSpan(child, row.length) } as React.CSSProperties}
              >
                <FieldNode field={child} {...rest} />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  switch (field.type) {
    case "headline":
    case "headline-with-line":
      return (
        <h3
          className={[
            "tf-form__headline",
            field.type === "headline-with-line" ? "tf-form__headline--ruled" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {field.name}
        </h3>
      );
    case "horizontal-line":
      return <hr className="tf-form__rule" />;
    case "spacer":
      return <div className="tf-form__spacer" aria-hidden="true" />;
    case "hyperlink":
      return <HyperlinkField field={field} />;
    default:
      return <InputField field={field} {...rest} />;
  }
}

/** Columns per child: the model's colspan, else an even share of the 12-column grid. */
function columnSpan(field: FormField, columnsInRow: number): number {
  const declared = field.layout?.colspan;
  if (typeof declared === "number" && declared > 0) return Math.min(12, declared);
  return Math.max(1, Math.floor(12 / Math.max(1, columnsInRow)));
}

function HyperlinkField({ field }: { field: FormField }) {
  const href = String(field.params?.hyperlinkUrl ?? field.value ?? "");
  const safe = /^https?:\/\//i.test(href);
  if (!safe) {
    // Never render a non-http(s) href: javascript:/data: URLs would execute on click.
    return <p className="tf-form__static">{field.name}</p>;
  }
  return (
    <p className="tf-form__static">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {field.name || href}
      </a>
    </p>
  );
}

/* ── Inputs ────────────────────────────────────────────────────────────────── */

function InputField({
  field,
  values,
  errors,
  disabled,
  onChange,
  onBlur,
  onUploadFile,
  fileUrl,
  identityLookup,
  domId,
}: NodeProps) {
  const { t, locale } = useI18n();
  // Per-model translation (W3.3): the field's own name is the source and the fallback,
  // so an untranslated field reads as it was written rather than as a blank.
  const label = fieldLabel(field, locale);
  const inputId = domId(field.id);
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const error = errors[field.id];
  const value = values[field.id];
  const limits = fieldConstraints(field);
  /*
   * A checkbox has nowhere to put a placeholder, so its placeholder is guidance and
   * shows as the hint. Resolved before `describedBy` is built — a hint that renders but
   * is not referenced is one the screen reader never reads out.
   */
  const hint = field.type === "boolean" ? limits.hint ?? field.placeholder : limits.hint;
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;

  // Engine-computed and model-read-only fields are shown as values, not as controls.
  const isExpression = field.type === "expression";
  const isReadOnlyValue = isExpression || field.readOnly === true;

  const commonProps = {
    id: inputId,
    className: "tf-input",
    disabled,
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
    onBlur: onBlur ? () => onBlur(field.id) : undefined,
  };

  let control: ReactNode;

  if (isExpression) {
    // Expression fields are engine-computed, so they are not seeded into the values
    // map; their value comes straight off the model.
    control = <ReadOnlyValue id={inputId} value={value ?? field.value} computed />;
  } else if (isReadOnlyValue) {
    control =
      field.type === "upload" ? (
        <ReadOnlyUpload id={inputId} value={value} href={fileUrl?.(field, value)} />
      ) : (
        <ReadOnlyValue id={inputId} value={displayValue(field, value, t)} />
      );
  } else if (field.type === "boolean") {
    // The question is the checkbox's own label, so there is exactly one label and
    // clicking the words toggles the box.
    return (
      <div className={fieldClass(error)}>
        <label className="tf-check" htmlFor={inputId}>
          <input
            {...commonProps}
            className="tf-check__input"
            type="checkbox"
            checked={value === true || value === "true"}
            onChange={(event) => onChange(field.id, event.target.checked)}
          />
          <span className="tf-check__label">
            {label}
            <RequiredMark required={field.required} t={t} />
          </span>
        </label>
        <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} />
      </div>
    );
  } else if (isOptionField(field) && field.type === "radio-buttons" && hasOptions(field)) {
    // A radio group is a question with answers, which is a fieldset with a legend —
    // a floating <label> cannot name a group, and pointed at nothing at all before.
    return (
      <fieldset
        className={[
          "tf-field",
          "tf-radio-group",
          error ? "tf-field--invalid tf-radio-group--invalid" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-describedby={describedBy}
        aria-required={field.required || undefined}
        aria-invalid={error ? true : undefined}
      >
        <legend className="tf-radio-group__legend">
          {label}
          <RequiredMark required={field.required} t={t} />
        </legend>
        <div className="tf-radio-group__options">
          {(field.options ?? []).map((option, index) => {
            // The group's first option answers to the field's own id, so the error
            // summary and any other jump link land on the group.
            const optionId = index === 0 ? inputId : `${inputId}-${index}`;
            const stored = optionStoredValue(option);
            return (
              <label className="tf-check" htmlFor={optionId} key={stored}>
                <input
                  type="radio"
                  id={optionId}
                  name={inputId}
                  value={stored}
                  disabled={disabled}
                  checked={optionSelected(option, value)}
                  onChange={() => onChange(field.id, stored)}
                  onBlur={onBlur ? () => onBlur(field.id) : undefined}
                />
                <span className="tf-check__label">{option.name}</span>
              </label>
            );
          })}
        </div>
        <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} />
      </fieldset>
    );
  } else if (isOptionField(field)) {
    control = renderOptions(field, {
      value,
      inputId,
      disabled,
      error: Boolean(error),
      describedBy,
      onChange,
      onBlur,
      t,
    });
  } else if (field.type === "multi-line-text") {
    control = (
      <textarea
        {...commonProps}
        className="tf-input tf-textarea"
        rows={4}
        placeholder={field.placeholder}
        value={String(value ?? "")}
        onChange={(event) => onChange(field.id, event.target.value)}
      />
    );
  } else if (field.type === "upload") {
    // A file needs somewhere to go. On a task that is the attachment endpoint; on a
    // start form there is no instance yet, so the field explains itself instead of
    // rendering a control that would silently drop the file.
    control = onUploadFile ? (
      <UploadField
        field={field}
        inputId={inputId}
        limits={limits}
        value={value}
        disabled={disabled}
        describedBy={describedBy}
        onChange={onChange}
        onUploadFile={onUploadFile}
      />
    ) : (
      <p className="tf-form__static tf-muted">{t("form.upload.beforeStart")}</p>
    );
  } else if (field.type === "people" || field.type === "functional-group") {
    control = (
      <IdentityField
        field={field}
        inputId={inputId}
        commonProps={commonProps}
        value={value}
        lookup={identityLookup}
        onChange={onChange}
        t={t}
      />
    );
  } else {
    const numeric = isNumeric(field.type);
    control = (
      <input
        {...commonProps}
        type={inputTypeFor(field.type)}
        inputMode={numeric ? (field.type === "integer" ? "numeric" : "decimal") : undefined}
        step={field.type === "decimal" || field.type === "amount" ? "any" : undefined}
        min={numeric ? limits.min : field.type === "date" ? limits.minDate : undefined}
        max={numeric ? limits.max : field.type === "date" ? limits.maxDate : undefined}
        /*
         * A number input answers the scroll wheel, so scrolling a long form past a
         * focused amount silently edits it. Dropping focus on wheel is the cheapest
         * fix that keeps the spinners and the keyboard behaviour intact.
         */
        onWheel={
          numeric
            ? (event) => {
                if (document.activeElement === event.currentTarget) event.currentTarget.blur();
              }
            : undefined
        }
        placeholder={field.placeholder}
        value={field.type === "date" ? toDateInputValue(value) : String(value ?? "")}
        onChange={(event) => onChange(field.id, event.target.value)}
      />
    );
  }

  return (
    <div className={fieldClass(error)}>
      <div className="tf-field__label-row">
        <label className="tf-field__label" htmlFor={inputId}>
          {label}
          <RequiredMark required={field.required && !isReadOnlyValue} t={t} />
        </label>
        {limits.maxLength !== undefined && !isReadOnlyValue ? (
          <CharacterCounter length={String(value ?? "").length} max={limits.maxLength} t={t} />
        ) : null}
      </div>
      {control}
      <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </div>
  );
}

function fieldClass(error: string | undefined): string {
  return ["tf-field", error ? "tf-field--invalid" : ""].filter(Boolean).join(" ");
}

/** The asterisk, plus the word itself for anyone who cannot see the asterisk. */
function RequiredMark({ required, t }: { required?: boolean; t: TFunction }) {
  if (!required) return null;
  return (
    <>
      <span className="tf-field__required" aria-hidden="true">
        {" "}
        *
      </span>
      <span className="tf-visually-hidden"> ({t("form.requiredHint")})</span>
    </>
  );
}

function FieldMessages({
  hint,
  hintId,
  error,
  errorId,
}: {
  hint?: string;
  hintId: string;
  error?: string;
  errorId: string;
}) {
  return (
    <>
      {hint ? (
        <p className="tf-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {/*
        No role="alert" here. Inline validation runs on every keystroke, and an alert per
        field would make a screen reader talk over the typing it is describing. The
        message is wired in through aria-describedby, and the submit-time summary is the
        one thing that speaks up on its own.
      */}
      {error ? (
        <p className="tf-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </>
  );
}

function CharacterCounter({
  length,
  max,
  t,
}: {
  length: number;
  max: number;
  t: TFunction;
}) {
  const remaining = max - length;
  const over = remaining < 0;
  const tone = over ? "over" : remaining <= Math.max(5, Math.round(max * 0.1)) ? "near" : "";
  return (
    <span
      className={["tf-field__counter", tone ? `tf-field__counter--${tone}` : ""]
        .filter(Boolean)
        .join(" ")}
      // Announced when the user pauses, rather than on every character.
      aria-live="polite"
    >
      {over
        ? t("form.charactersOver", { count: -remaining })
        : t("form.charactersLeft", { count: remaining })}
    </span>
  );
}

/** A stored file that this task may look at but not replace. */
function ReadOnlyUpload({
  id,
  value,
  href,
}: {
  id: string;
  value: unknown;
  href: string | undefined;
}) {
  const t = useT();
  const stored = parseStoredUpload(value);
  const empty = !stored && (value === undefined || value === null || value === "");
  const label = stored?.name ?? (empty ? "" : String(value));
  if (empty) {
    return <ReadOnlyValue id={id} value="" />;
  }
  if (!href) {
    return <ReadOnlyValue id={id} value={t("form.upload.attached", { name: label })} />;
  }
  return (
    <output className="tf-form__readonly tf-form__readonly--file" id={id} tabIndex={-1}>
      <a className="tf-form__download" href={href} target="_blank" rel="noopener noreferrer">
        {t("form.upload.download", { name: label })}
      </a>
    </output>
  );
}

/** A value the user cannot change: shown as text, never as a disabled control. */
function ReadOnlyValue({
  id,
  value,
  computed = false,
}: {
  id: string;
  value: unknown;
  computed?: boolean;
}) {
  const t = useT();
  const empty = value === undefined || value === null || value === "";
  const className = [
    computed ? "tf-form__expression" : "tf-form__readonly",
    empty ? "tf-form__readonly--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    // `tabIndex` so an error summary link or an in-page anchor can still reach it, and
    // `output` so assistive tech treats a computed value as one.
    <output className={className} id={id} tabIndex={-1}>
      {empty ? t("form.notAnswered") : String(value)}
    </output>
  );
}

/** What a read-only field should show: the answer, in words rather than as a raw value. */
function displayValue(field: FormField, value: unknown, t: TFunction): unknown {
  if (field.type === "boolean") {
    return value === true || value === "true" ? t("form.yes") : t("form.no");
  }
  if (field.type === "date") return toDateInputValue(value ?? field.value);
  if (isOptionField(field) && value != null && value !== "") {
    const match = (field.options ?? []).find((option) => optionSelected(option, value));
    if (match) return match.name;
  }
  return value ?? field.value;
}

/** The value written to the process variable: id when the author set one, else the label. */
function optionStoredValue(option: { id?: string; name: string }): string {
  return option.id || option.name;
}

function optionSelected(option: { id?: string; name: string }, value: unknown): boolean {
  const stored = String(value ?? "");
  return stored === optionStoredValue(option) || stored === option.name;
}

function hasOptions(field: OptionFormField): boolean {
  return (field.options ?? []).length > 0;
}

interface OptionRenderContext {
  value: unknown;
  inputId: string;
  disabled: boolean;
  error: boolean;
  describedBy: string | undefined;
  onChange: (fieldId: string, value: unknown) => void;
  onBlur?: (fieldId: string) => void;
  /** Passed down rather than hooked: renderOptions is a helper, not a component. */
  t: TFunction;
}

function renderOptions(field: OptionFormField, ctx: OptionRenderContext): ReactNode {
  const options = field.options ?? [];

  // An options list driven by a server-side expression arrives unresolved; a free-text
  // input is honest about that rather than showing an empty dropdown.
  if (options.length === 0 && field.optionsExpression) {
    return (
      <input
        id={ctx.inputId}
        className="tf-input"
        type="text"
        disabled={ctx.disabled}
        aria-invalid={ctx.error || undefined}
        aria-describedby={ctx.describedBy}
        value={String(ctx.value ?? "")}
        onChange={(event) => ctx.onChange(field.id, event.target.value)}
        onBlur={ctx.onBlur ? () => ctx.onBlur?.(field.id) : undefined}
      />
    );
  }

  return (
    <select
      id={ctx.inputId}
      className="tf-input tf-select"
      disabled={ctx.disabled}
      aria-invalid={ctx.error || undefined}
      aria-describedby={ctx.describedBy}
      value={String(ctx.value ?? "")}
      onChange={(event) => ctx.onChange(field.id, event.target.value)}
      onBlur={ctx.onBlur ? () => ctx.onBlur?.(field.id) : undefined}
    >
      <option value="">{field.placeholder || ctx.t("form.choose")}</option>
      {options.map((option) => {
        const stored = optionStoredValue(option);
        return (
          <option key={stored} value={stored}>
            {option.name}
          </option>
        );
      })}
    </select>
  );
}

function isNumeric(fieldType: string): boolean {
  return fieldType === "integer" || fieldType === "decimal" || fieldType === "amount";
}

function inputTypeFor(fieldType: string): string {
  switch (fieldType) {
    case "integer":
    case "decimal":
    case "amount":
      return "number";
    case "date":
      return "date";
    default:
      return "text";
  }
}

/* ── People and groups ─────────────────────────────────────────────────────── */

/**
 * A `people` or `functional-group` field: a text input the engine reads as an id, with a
 * typeahead over the identity store when one is configured. The stored value is always
 * the id — the label is for the person choosing, not for the engine.
 *
 * A `<datalist>` rather than a custom listbox: it is keyboard- and screen-reader-native,
 * costs no focus management, and a form field is not the place for a bespoke widget.
 */
function IdentityField({
  field,
  inputId,
  commonProps,
  value,
  lookup,
  onChange,
  t,
}: {
  field: FormField;
  inputId: string;
  commonProps: Record<string, unknown>;
  value: unknown;
  lookup?: IdentityLookup;
  onChange: (fieldId: string, value: unknown) => void;
  t: TFunction;
}) {
  const isUser = field.type === "people";
  const text = String(value ?? "");
  const query = text.trim();
  const active = Boolean(lookup) && query.length >= 2;
  /** The last answer from the store, tagged with the query it answers — stale answers are simply not shown. */
  const [result, setResult] = useState<{ query: string; choices: IdentityChoice[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const listId = `${inputId}-choices`;

  useEffect(() => {
    if (!active || !lookup) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      const search = isUser ? lookup.users : lookup.groups;
      search(query, controller.signal)
        .then((found) => {
          if (!controller.signal.aborted) setResult({ query, choices: found });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ query, choices: [] });
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [lookup, active, query, isUser]);

  const choices = active && result?.query === query ? result.choices : [];
  const missed = active && !searching && result?.query === query && result.choices.length === 0 ? query : null;
  const exact = choices.find((choice) => choice.id === text);
  const placeholder =
    field.placeholder ||
    (lookup
      ? isUser
        ? t("form.identity.userHint")
        : t("form.identity.groupHint")
      : isUser
        ? t("form.userId")
        : t("form.groupId"));

  return (
    <>
      <input
        {...commonProps}
        type="text"
        list={lookup ? listId : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        onChange={(event) => onChange(field.id, event.target.value)}
      />
      {lookup ? (
        <datalist id={listId}>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </datalist>
      ) : null}
      {lookup && (searching || exact || missed) ? (
        <p className="tf-field__hint tf-form__identity-status" aria-live="polite">
          {searching
            ? t("form.identity.searching")
            : exact
              ? exact.label
              : t("form.identity.noMatch", { query: missed ?? "" })}
        </p>
      ) : null}
    </>
  );
}

/* ── Upload ────────────────────────────────────────────────────────────────── */

/**
 * An `upload` field.
 *
 * Uploading is a side effect with four outcomes the user must be able to tell apart:
 * idle, in flight, attached, and failed. A bare file input shows none of them, and
 * rejects nothing until the server does.
 */
function UploadField({
  field,
  inputId,
  limits,
  value,
  disabled,
  describedBy,
  onChange,
  onUploadFile,
}: {
  field: FormField;
  inputId: string;
  limits: FieldConstraints;
  value: unknown;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (fieldId: string, value: unknown) => void;
  onUploadFile: (field: FormField, file: File) => Promise<string>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ name: string; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasValue = value !== undefined && value !== null && value !== "";

  const accept = (file: File): string | null => {
    if (limits.maxFileSize !== undefined && file.size > limits.maxFileSize) {
      return t("form.upload.tooLarge", {
        size: formatFileSize(file.size),
        limit: formatFileSize(limits.maxFileSize),
      });
    }
    if (limits.accept && !matchesAccept(file, limits.accept)) {
      return t("form.upload.wrongType", { accept: limits.accept });
    }
    return null;
  };

  const take = (file: File | undefined) => {
    if (!file) return;
    const rejection = accept(file);
    if (rejection) {
      setFailed(rejection);
      // Nothing was sent, so nothing should look attached.
      onChange(field.id, undefined);
      setAttached(null);
      return;
    }
    setBusy(true);
    setFailed(null);
    onUploadFile(field, file)
      .then((stored) => {
        onChange(field.id, stored);
        setAttached({ name: file.name, size: file.size });
      })
      .catch((cause: unknown) => {
        setFailed(cause instanceof Error ? cause.message : t("form.upload.failed"));
        // Leave the field empty rather than pretending a value was stored.
        onChange(field.id, undefined);
        setAttached(null);
      })
      .finally(() => setBusy(false));
  };

  const clear = () => {
    onChange(field.id, undefined);
    setAttached(null);
    setFailed(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="tf-upload">
      <div
        className={[
          "tf-upload__zone",
          dragging ? "tf-upload__zone--dragging" : "",
          disabled || busy ? "tf-upload__zone--disabled" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onDragOver={(event) => {
          if (disabled || busy) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (disabled || busy) return;
          event.preventDefault();
          setDragging(false);
          take(event.dataTransfer.files?.[0]);
        }}
      >
        <input
          ref={inputRef}
          id={inputId}
          name={field.id}
          type="file"
          className="tf-upload__input"
          accept={limits.accept}
          disabled={disabled || busy}
          aria-describedby={describedBy}
          aria-required={field.required || undefined}
          onChange={(event) => take(event.target.files?.[0])}
        />
        <span className="tf-upload__prompt" aria-hidden="true">
          {hasValue ? t("form.upload.replacePrompt") : t("form.upload.prompt")}
        </span>
        {limits.accept ? (
          <span className="tf-upload__constraint">
            {t("form.upload.accepts", { accept: limits.accept })}
          </span>
        ) : null}
        {limits.maxFileSize !== undefined ? (
          <span className="tf-upload__constraint">
            {t("form.upload.maxSize", { size: formatFileSize(limits.maxFileSize) })}
          </span>
        ) : null}
      </div>

      {busy ? (
        <span className="tf-upload__status" role="status">
          <span className="tf-upload__spinner" aria-hidden="true" />
          {t("form.upload.busy")}
        </span>
      ) : failed ? (
        <span className="tf-upload__status tf-upload__status--error" role="alert">
          {failed}
        </span>
      ) : hasValue ? (
        <div className="tf-upload__file">
          <span className="tf-upload__file-name">
            {/*
              After a remount the file's name is gone but the stored value is not — the
              engine holds an attachment id, not a filename. Saying "attached" against
              the id we do have beats showing an empty control over a real attachment.
            */}
            {attached ? attached.name : t("form.upload.attached", { name: String(value) })}
          </span>
          {attached ? (
            <span className="tf-upload__file-size">{formatFileSize(attached.size)}</span>
          ) : null}
          <button
            type="button"
            className="tf-upload__remove"
            disabled={disabled}
            aria-label={t("form.upload.remove", {
              name: attached ? attached.name : String(value),
            })}
            onClick={clear}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Mirrors the browser's own `accept` matching: extensions, mime types and `type/*`. */
function matchesAccept(file: File, accept: string): boolean {
  const patterns = accept
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;

  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) return name.endsWith(pattern);
    if (pattern.endsWith("/*")) return mime.startsWith(pattern.slice(0, -1));
    return mime === pattern;
  });
}

/** Bytes as something a person reads, in the units file managers use. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || Number.isInteger(size) ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
