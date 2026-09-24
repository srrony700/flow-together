/**
 * Form value handling: initial values, validation, and conversion to the typed
 * RestVariable payload the engine expects on task completion / process start.
 *
 * The renderer is Flowable-schema-native rather than an adapter over a foreign
 * schema — see docs/ui/adr/0007-flowable-native-form-renderer.md.
 */

import type {
  FormContainerField,
  FormField,
  FormModelResponse,
  OptionFormField,
  RestVariable,
} from "../api/types";
import { interpolate, type Messages, type TFunction } from "../i18n/I18nContext";
import { commonEn } from "../i18n/messages";
import { hiddenFieldIds } from "./visibility";

/**
 * Validation runs outside React — on submit, in a `useMemo`, in tests — so it takes the
 * translator as an argument rather than reaching for the hook. Callers that have one
 * (both app screens do) pass it; the rest get English from the shared catalogue, which
 * is the same copy the provider would have resolved.
 */
export const englishMessages: TFunction = (key, params) =>
  interpolate((commonEn as Messages)[key] ?? key, params);

/** Field types that carry no value — layout and display only. */
const PRESENTATIONAL: ReadonlySet<string> = new Set([
  "container",
  "spacer",
  "horizontal-line",
  "headline",
  "headline-with-line",
  "hyperlink",
]);

/** Field types the engine computes; the UI shows them but never submits them. */
const ENGINE_COMPUTED: ReadonlySet<string> = new Set(["expression"]);

export type FormValues = Record<string, unknown>;

export function isContainer(field: FormField): field is FormContainerField {
  return field.fieldType === "FormContainer" || field.type === "container";
}

export function isOptionField(field: FormField): field is OptionFormField {
  return (
    field.fieldType === "OptionFormField" ||
    field.type === "dropdown" ||
    field.type === "radio-buttons"
  );
}

export function isPresentational(field: FormField): boolean {
  return PRESENTATIONAL.has(field.type) && !isContainer(field);
}

export function isSubmittable(field: FormField): boolean {
  return (
    !isContainer(field) &&
    !PRESENTATIONAL.has(field.type) &&
    !ENGINE_COMPUTED.has(field.type)
  );
}

/** Depth-first walk that flattens container rows/columns into a field list. */
export function flattenFields(fields: FormField[] | undefined): FormField[] {
  const out: FormField[] = [];
  for (const field of fields ?? []) {
    if (isContainer(field)) {
      for (const row of field.fields ?? []) {
        out.push(...flattenFields(row));
      }
    } else {
      out.push(field);
    }
  }
  return out;
}

export function initialValues(model: FormModelResponse): FormValues {
  const values: FormValues = {};
  for (const field of flattenFields(model.fields)) {
    if (!isSubmittable(field)) continue;
    values[field.id] = normaliseInitial(field);
  }
  return values;
}

function normaliseInitial(field: FormField): unknown {
  const value = field.value;
  if (field.type === "boolean") return value === true || value === "true";
  if (value === null || value === undefined) return "";
  if (field.type === "date") return toDateInputValue(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * `<input type="date">` only accepts yyyy-MM-dd.
 *
 * A string that already opens with a calendar date is trusted as written rather than
 * re-derived through `Date`. Converting via UTC shifts the day for anyone whose offset
 * crosses midnight — `2026-03-05T01:00:00+03:00` is 4 March in UTC — so a date the user
 * picked would come back a day earlier, and a second later, and so on. Taking the
 * literal keeps the round trip with `formValuesToVariables` (which writes UTC midnight)
 * exact in every timezone.
 */
export function toDateInputValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  if (typeof value === "string") {
    const literal = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(value);
    if (literal) return literal[1];
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  return date.toISOString().slice(0, 10);
}

/**
 * Optional per-field constraints, carried in the engine's free-form `params` map.
 *
 * Flowable's `FormField` has no schema for these — `params` is the documented place for
 * anything the engine does not model itself, which is also where the conditional
 * visibility rule lives (see visibility.ts). Every one is optional and a form that sets
 * none behaves exactly as before.
 */
export interface FieldConstraints {
  /** Help text shown under the label, for the guidance a placeholder cannot carry. */
  hint?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  /** What the pattern means, in words — a regex is not an error message. */
  patternMessage?: string;
  /** ISO dates (yyyy-MM-dd) bounding a `date` field, inclusive. */
  minDate?: string;
  maxDate?: string;
  /** `accept` for an upload field, e.g. ".pdf,image/*". */
  accept?: string;
  /** Largest accepted upload, in bytes. Checked before the file is sent. */
  maxFileSize?: number;
}

function numberParam(params: Record<string, unknown> | undefined, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = params?.[name];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringParam(params: Record<string, unknown> | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const raw = params?.[name];
    if (typeof raw === "string" && raw !== "") return raw;
  }
  return undefined;
}

/**
 * Per-model translations (ENTERPRISE_PARITY_PLAN.md W3.3).
 *
 * ADR 0013's i18n layer translates the *UI*; nothing translated model content, so a form
 * authored in English stayed English for every reader whatever their locale. Labels live
 * in the same free-form `params` map as the visibility rule (ADR 0012) and the field
 * constraints above — a convention this fork owns, which the engine neither reads nor
 * rejects.
 *
 * The field's own `name` stays the source text and the fallback: a translation that is
 * missing shows the original rather than a key or a blank.
 */
export const LABELS_PARAM = "tfLabels";

export function fieldLabel(field: FormField, locale: string): string {
  const source = field.name || field.id;
  const labels = field.params?.[LABELS_PARAM];
  if (!labels || typeof labels !== "object") {
    return source;
  }
  const table = labels as Record<string, unknown>;
  // `de-AT` falls back through `de` before the source, the same chain the UI layer walks.
  for (const candidate of [locale, locale.split("-")[0]]) {
    const translated = table[candidate];
    if (typeof translated === "string" && translated.trim() !== "") {
      return translated;
    }
  }
  return source;
}

/** The locales a field carries a translation for. */
export function fieldLocales(field: FormField): string[] {
  const labels = field.params?.[LABELS_PARAM];
  if (!labels || typeof labels !== "object") return [];
  return Object.keys(labels as Record<string, unknown>).sort();
}

/** Sets or clears one locale's label, leaving the source text alone. */
export function withFieldLabel(field: FormField, locale: string, label: string): FormField {
  const existing = (field.params?.[LABELS_PARAM] ?? {}) as Record<string, string>;
  const labels: Record<string, string> = { ...existing };
  if (label.trim() === "") delete labels[locale];
  else labels[locale] = label;

  const params = { ...(field.params ?? {}) };
  if (Object.keys(labels).length === 0) delete params[LABELS_PARAM];
  else params[LABELS_PARAM] = labels;

  return { ...field, params: Object.keys(params).length > 0 ? params : undefined } as FormField;
}

export function fieldConstraints(field: FormField): FieldConstraints {
  const params = field.params;
  return {
    hint: stringParam(params, "description", "hint"),
    minLength: numberParam(params, "minLength"),
    maxLength: numberParam(params, "maxLength"),
    min: numberParam(params, "min", "minValue"),
    max: numberParam(params, "max", "maxValue"),
    pattern: stringParam(params, "pattern"),
    patternMessage: stringParam(params, "patternMessage"),
    minDate: stringParam(params, "minDate"),
    maxDate: stringParam(params, "maxDate"),
    accept: stringParam(params, "accept"),
    maxFileSize: numberParam(params, "maxFileSize"),
  };
}

export type FormErrors = Record<string, string>;

export function validateForm(
  model: FormModelResponse,
  values: FormValues,
  t: TFunction = englishMessages,
): FormErrors {
  const errors: FormErrors = {};
  // A field the user cannot see must not block submission — requiring an answer to a
  // hidden question is unanswerable.
  const hidden = hiddenFieldIds(model, values);
  for (const field of flattenFields(model.fields)) {
    if (!isSubmittable(field) || field.readOnly || hidden.has(field.id)) continue;
    const error = validateField(field, values[field.id], t);
    if (error) errors[field.id] = error;
  }
  return errors;
}

export function validateField(
  field: FormField,
  value: unknown,
  t: TFunction = englishMessages,
): string | undefined {
  const isBlank =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "");

  if (field.required && field.type !== "boolean" && isBlank) {
    return t("form.validation.required", { field: field.name || field.id });
  }
  if (isBlank) return undefined;

  const raw = String(value).trim();
  const limits = fieldConstraints(field);

  if (field.type === "integer") {
    if (!/^-?\d+$/.test(raw)) return t("form.validation.integer");
    return rangeError(Number(raw), limits, t);
  }
  if (field.type === "decimal" || field.type === "amount") {
    if (!Number.isFinite(Number(raw))) return t("form.validation.number");
    return rangeError(Number(raw), limits, t);
  }
  if (field.type === "date") {
    if (Number.isNaN(Date.parse(raw))) return t("form.validation.date");
    // Compared as ISO strings: yyyy-MM-dd sorts as it dates, and the input already
    // hands the value over in that shape.
    const day = raw.slice(0, 10);
    if (limits.minDate && day < limits.minDate) {
      return t("form.validation.minDate", { date: limits.minDate });
    }
    if (limits.maxDate && day > limits.maxDate) {
      return t("form.validation.maxDate", { date: limits.maxDate });
    }
    return undefined;
  }

  // Text-shaped fields: length first, then shape — a value that is the wrong length is
  // more usefully reported as such than as failing a pattern it never had a chance at.
  if (limits.minLength !== undefined && raw.length < limits.minLength) {
    return t("form.validation.minLength", { min: limits.minLength });
  }
  if (limits.maxLength !== undefined && raw.length > limits.maxLength) {
    return t("form.validation.maxLength", { max: limits.maxLength });
  }
  if (limits.pattern) {
    // An unparseable pattern is the form author's bug, not the filler's: let the value
    // through rather than blocking a form nobody can submit.
    // Anchored, because the engine matches the whole value (Java's `matches()`); a
    // browser check that passes on a substring would only move the refusal server-side.
    let expression: RegExp | undefined;
    try {
      expression = new RegExp(`^(?:${limits.pattern})$`);
    } catch {
      expression = undefined;
    }
    if (expression && !expression.test(raw)) {
      return limits.patternMessage ?? t("form.validation.pattern");
    }
  }
  return undefined;
}

function rangeError(
  value: number,
  limits: FieldConstraints,
  t: TFunction,
): string | undefined {
  if (limits.min !== undefined && value < limits.min) {
    return t("form.validation.min", { min: limits.min });
  }
  if (limits.max !== undefined && value > limits.max) {
    return t("form.validation.max", { max: limits.max });
  }
  return undefined;
}

/**
 * Every field id in the order the form presents them — container-aware, so a field
 * inside a row comes back in reading order.
 *
 * Used when a submit attempt has to reveal problems the user has not seen yet: the
 * errors are ordered like the form rather than by object-key order, and every field
 * counts as visited whether it was or not.
 */
export function fieldIdsInOrder(model: FormModelResponse): string[] {
  return flattenFields(model.fields).map((field) => field.id);
}

/**
 * Maps form values onto RestVariables. The engine rejects a variable whose value
 * does not match its declared type, so the form field's type decides the variable
 * type rather than guessing from the JavaScript value.
 */
export function formValuesToVariables(
  model: FormModelResponse,
  values: FormValues,
): RestVariable[] {
  const variables: RestVariable[] = [];

  for (const field of flattenFields(model.fields)) {
    if (!isSubmittable(field) || field.readOnly) continue;
    const raw = values[field.id];

    if (field.type === "boolean") {
      variables.push({ name: field.id, type: "boolean", value: raw === true || raw === "true" });
      continue;
    }

    const text = raw === undefined || raw === null ? "" : String(raw).trim();
    if (text === "") {
      // Send an explicit null so clearing an optional field actually clears the
      // variable, rather than silently leaving the previous value in place.
      variables.push({ name: field.id, type: variableTypeFor(field.type), value: null });
      continue;
    }

    switch (field.type) {
      case "integer":
        variables.push({ name: field.id, type: "integer", value: Number.parseInt(text, 10) });
        break;
      case "decimal":
      case "amount":
        variables.push({ name: field.id, type: "double", value: Number(text) });
        break;
      case "date":
        variables.push({ name: field.id, type: "date", value: new Date(text).toISOString() });
        break;
      default:
        variables.push({ name: field.id, type: "string", value: text });
    }
  }

  return variables;
}

/**
 * What an `upload` field stores: the attachment id plus the task that owns the
 * bytes (content URLs are task-scoped) and the original file name for display.
 */
export interface StoredUpload {
  id: string;
  taskId: string;
  name: string;
}

export function parseStoredUpload(value: unknown): StoredUpload | null {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value !== null && "id" in value && "taskId" in value) {
    const record = value as { id?: unknown; taskId?: unknown; name?: unknown };
    if (typeof record.id === "string" && typeof record.taskId === "string") {
      return {
        id: record.id,
        taskId: record.taskId,
        name: typeof record.name === "string" && record.name ? record.name : record.id,
      };
    }
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return parseStoredUpload(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

export function serialiseStoredUpload(upload: StoredUpload): string {
  return JSON.stringify(upload);
}

function variableTypeFor(fieldType: string): string {
  switch (fieldType) {
    case "integer":
      return "integer";
    case "decimal":
    case "amount":
      return "double";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/**
 * True when the model has renderable content. A form can come back with metadata
 * but no fields (e.g. an interceptor returned a different shape), in which case the
 * caller should fall back to the variable grid rather than render an empty form.
 */
export function hasRenderableFields(model: FormModelResponse | undefined): boolean {
  if (!model) return false;
  return flattenFields(model.fields).length > 0;
}

/**
 * The same model with every field read-only, for showing a recorded submission: the
 * renderer then paints values rather than controls, exactly as it does for a field the
 * model itself marks read-only.
 */
export function asReadOnlyModel(model: FormModelResponse): FormModelResponse {
  const readOnly = (field: FormField): FormField =>
    isContainer(field)
      ? { ...field, fields: (field.fields ?? []).map((row) => row.map(readOnly)) }
      : { ...field, readOnly: true };
  return { ...model, fields: (model.fields ?? []).map(readOnly) };
}
