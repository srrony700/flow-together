/**
 * Flowable-aware properties panel.
 *
 * Purpose-built rather than using `bpmn-js-properties-panel`, which models Camunda's
 * extension namespace — the attribute names and namespace URI differ, so it would
 * write properties this engine ignores. See docs/ui/adr/0008-bpmn-dmn-modelers.md.
 */

import {
  Button,
  SelectInput,
  TextAreaInput,
  TextInput,
  useT,
  type TFunction,
} from "@togetherflow/common";
import { useEffect, useId, useRef, useState } from "react";
import type { BpmnElement } from "./useBpmnModeler";
import type { IdentityOption, Suggestions } from "./useIdentities";
import {
  EXECUTION_EVENTS,
  TASK_EVENTS,
  applyEventCondition,
  applyEventReference,
  applyTimer,
  buildCondition,
  buildDocumentation,
  buildMultiInstance,
  DATA_OBJECT_TYPES,
  ENGINE_EVENTS,
  FORM_PROPERTY_TYPES,
  eventDefinitionKindOf,
  isBoundaryEvent,
  isDataObject,
  readCondition,
  readDataObjectType,
  readDataObjectValue,
  readDefaultFlow,
  readDocumentation,
  readEventListeners,
  readEventCondition,
  readEventReference,
  DECISION_KEY_FIELD,
  readFields,
  readFormProperties,
  readNamedField,
  readListeners,
  readMapExceptions,
  readMappings,
  readMultiInstance,
  readRetryCycle,
  readScript,
  readTimer,
  supportsDefaultFlow,
  supportsExecutionListeners,
  supportsCompensation,
  supportsFields,
  supportsFormProperties,
  supportsJobSettings,
  supportsMappings,
  supportsMultiInstance,
  writeDataObjectValue,
  writeEventListeners,
  writeFields,
  writeFormProperties,
  writeListeners,
  writeMapExceptions,
  writeMappings,
  writeNamedField,
  writeRetryCycle,
  type EventDefinitionKind,
  type EventListenerRow,
  type FieldRow,
  type FormPropertyRow,
  type FieldValueKind,
  type ImplementationType,
  type ListenerKind,
  type ListenerRow,
  type MapExceptionRow,
  type MappingKind,
  type MappingRow,
  type ModdleElement,
  type ModdleFactory,
  type MultiInstanceConfig,
  type MultiInstanceMode,
  type TimerKind,
} from "./bpmnExtensions";

/**
 * How long typing pauses before the edit reaches the model.
 *
 * Without a delay every keystroke is its own `modeling.updateProperties` call, and
 * therefore its own entry on the undo stack — renaming a task to "Approve order" took
 * thirteen presses of undo to reverse. bpmn.io's own properties panel debounces for the
 * same reason.
 */
const COMMIT_DELAY_MS = 300;

/**
 * A text field that edits the model, committing on a pause rather than per keystroke.
 *
 * The draft is local while the user types and reaches the model on three occasions: after
 * the pause, on blur, and on unmount. Blur is the one that matters for safety — clicking
 * Save or another element blurs the field first, so a pending edit is always written
 * before anything reads the model.
 */
function PropertyTextInput({
  value,
  onCommit,
  multiline = false,
  suggestions,
  onDraftChange,
  ...rest
}: {
  label: string;
  value: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  rows?: number;
  list?: string;
  multiline?: boolean;
  /** Offered through a native datalist. The field stays free text. */
  suggestions?: Suggestion[];
  /** Called on every keystroke, so a suggestion source can widen its search. */
  onDraftChange?: (draft: string) => void;
  onCommit: (value: string) => void;
}) {
  const listId = useId();
  const [draft, setDraft] = useState(value);
  /** What the model holds, so an outside change can be told apart from our own commit. */
  const committed = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Read by the unmount cleanup, which must not close over a stale render. */
  const latest = useRef({ draft, onCommit });
  // Updated in an effect rather than during render: a ref write while rendering is
  // unsafe under concurrent rendering, which this codebase has been bitten by before.
  useEffect(() => {
    latest.current = { draft, onCommit };
  });

  useEffect(() => {
    /*
     * Re-sync only when the value moved somewhere other than here — a different element
     * selected, or an undo. Resetting after our own commit would fight the typing.
     */
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  const flush = (next: string) => {
    clearTimeout(timer.current);
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
  };

  useEffect(
    () => () => {
      /*
       * Unmount means this field went away — a task type changed, say — while the element
       * it belongs to is still current. The cleanup closes over that render, so the
       * pending value lands on the right element.
       */
      clearTimeout(timer.current);
      const { draft: pending, onCommit: commit } = latest.current;
      if (pending !== committed.current) commit(pending);
    },
    [],
  );

  const handleChange = (next: string) => {
    setDraft(next);
    onDraftChange?.(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(next), COMMIT_DELAY_MS);
  };

  const Control = multiline ? TextAreaInput : TextInput;
  const hasSuggestions = !multiline && (suggestions?.length ?? 0) > 0;

  return (
    <>
      <Control
        {...rest}
        value={draft}
        list={hasSuggestions ? listId : rest.list}
        onChange={(event: { target: { value: string } }) => handleChange(event.target.value)}
        onBlur={() => flush(draft)}
      />
      {hasSuggestions ? (
        <datalist id={listId}>
          {suggestions!.map((option) => (
            /*
             * The label is the child, not the `label` attribute: browsers differ on which
             * they show, and every one of them renders the child text alongside the value.
             */
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </datalist>
      ) : null}
    </>
  );
}

/**
 * Expressions the engine resolves at runtime, offered alongside real identities.
 *
 * An assignee is very often not a person known to IDM — `${initiator}` is how you assign
 * a task back to whoever started the process — so suggesting only user ids would steer
 * people away from the idiomatic answer.
 */
const ASSIGNMENT_EXPRESSIONS = ["${initiator}"];

/**
 * Which pool a field draws from, and whether it holds a comma-separated list.
 *
 * Flowable's candidate fields are lists, which a plain `<datalist>` cannot complete —
 * picking an option would replace everything typed so far. `multi` switches on the prefix
 * handling below.
 */
const SUGGESTION_SOURCES: Record<
  string,
  { from: "users" | "groups" | "processes"; multi: boolean }
> = {
  assignee: { from: "users", multi: false },
  owner: { from: "users", multi: false },
  candidateUsers: { from: "users", multi: true },
  candidateGroups: { from: "groups", multi: true },
  candidateStarterUsers: { from: "users", multi: true },
  candidateStarterGroups: { from: "groups", multi: true },
  // A call activity's target. Getting this key wrong fails only at runtime, and only for
  // the instance that reaches it.
  calledElement: { from: "processes", multi: false },
};

/** What a datalist entry commits, and what it shows while choosing. */
export interface Suggestion {
  value: string;
  label?: string;
}

/** The identity kind a field searches, or null when it does not search at all. */
export function searchKindFor(key: string): "users" | "groups" | null {
  const source = SUGGESTION_SOURCES[key];
  return source && source.from !== "processes" ? source.from : null;
}

/** The part of a comma-separated field the user is currently typing. */
export function activeToken(value: string): string {
  return value.split(",").pop()?.trim() ?? "";
}

/**
 * Options for a field, in the form a native `<datalist>` can actually apply.
 *
 * For a single-valued field the option is the id itself. For a comma-separated one the
 * option is *everything already typed* plus the candidate, because selecting a datalist
 * entry replaces the input's whole value — offering the bare id would discard the names
 * before it. Ids already present drop out, so the list shrinks as it is used.
 *
 * The label carries the human name. What reaches the model is always the id the engine
 * needs; the name only makes the list recognisable rather than a wall of logins.
 *
 * Native `<datalist>` rather than a custom dropdown on purpose: it brings its own keyboard
 * handling, screen-reader semantics and mobile behaviour, none of which a hand-rolled
 * listbox gets for free (§13.6).
 */
export function suggestionsFor(
  key: string,
  current: string,
  identities: Suggestions | undefined,
): Suggestion[] {
  const source = SUGGESTION_SOURCES[key];
  if (!source || !identities) return [];

  const pool: IdentityOption[] = [
    ...identities[source.from],
    ...(source.from === "users" ? ASSIGNMENT_EXPRESSIONS.map((id) => ({ id })) : []),
  ];

  if (!source.multi) {
    return pool.map((option) => ({ value: option.id, label: option.label }));
  }

  const parts = current.split(",");
  const chosen = new Set(parts.slice(0, -1).map((part) => part.trim()).filter(Boolean));
  const prefix = parts.slice(0, -1).join(",");
  const separator = prefix === "" ? "" : `${prefix}, `;

  return pool
    .filter((option) => !chosen.has(option.id))
    .map((option) => ({
      value: `${separator}${option.id}`,
      // The label names the candidate being added, not the accumulated value, which is
      // already visible in the field.
      label: option.label,
    }));
}

export interface PropertiesPanelProps {
  element: BpmnElement | null;
  disabled?: boolean;
  onChange: (element: BpmnElement, properties: Record<string, unknown>) => void;
  /**
   * Needed for the properties that are nested moddle objects rather than attributes —
   * listeners, multi-instance, timers, field injections, variable mappings and
   * documentation. Without it those sections are not offered, which is honest: they
   * cannot be written.
   */
  moddle?: ModdleFactory | null;
  /** Definitions-level roots, for the error/signal/message reference selectors. */
  getRootElements?: () => ModdleElement[];
  /** Declares a new root element when an event references one that does not exist yet. */
  addRootElement?: (root: ModdleElement) => void;
  /** Outgoing flows of the selected element, for the gateway default-flow selector. */
  getOutgoingFlows?: (elementId: string) => Array<{ id: string; name: string }>;
  /** Resolves a flow id to the object `default` must reference. */
  getFlowElement?: (flowId: string) => unknown;
  /** Declares a namespace prefix used inside an attribute value (see `useBpmnModeler`). */
  ensureNamespace?: (prefix: string, uri: string) => void;
  /** Ids the reference fields suggest. Suggestions, never a constraint. */
  identities?: Suggestions;
  /** Reports what the user is typing, so the source can look past its cached page. */
  onIdentitySearch?: (kind: "users" | "groups", term: string) => void;
  /** Changes the element's BPMN type in place, keeping id, name and connections. */
  replaceElementType?: (element: BpmnElement, type: string) => void;
  /** Updates a moddle object that is not a diagram element — a pool's `bpmn:Process`. */
  updateModdleProperties?: (
    element: BpmnElement,
    moddleElement: unknown,
    properties: Record<string, unknown>,
  ) => void;
}

/**
 * Flowable's service-task subtypes (§7.2 of the engine's own model: every one of these is
 * a `bpmn:ServiceTask` distinguished only by `flowable:type`).
 *
 * bpmn-js's replace menu speaks standard BPMN only, so without this selector the entire
 * family — HTTP, mail, DMN, external worker, case, send-event — was undrawable. "" means
 * a plain service task implemented by a class or expression.
 */
const SERVICE_TASK_TYPES = [
  "",
  "http",
  "mail",
  "dmn",
  "shell",
  "camel",
  "case",
  "send-event",
  "external-worker",
] as const;

/** Subtypes configured entirely through field injections rather than attributes. */
const FIELD_CONFIGURED_TYPES = new Set(["http", "mail", "dmn", "shell", "camel"]);

/**
 * What an element can be turned into, without redrawing it.
 *
 * bpmn-js has this behind the context pad's wrench, which is discoverable only if you
 * already know it is there — and a modeller's most common early action is "this should
 * have been a user task". Offered in the panel too, where the rest of the element's
 * configuration already lives.
 *
 * Grouped by what a replacement sensibly preserves: an activity keeps its connections
 * when it becomes another activity, and a gateway another gateway. Swapping across those
 * groups is left to the canvas, where the consequences are visible.
 */
const REPLACEABLE_ACTIVITIES = [
  "bpmn:Task",
  "bpmn:UserTask",
  "bpmn:ServiceTask",
  "bpmn:SendTask",
  "bpmn:ReceiveTask",
  "bpmn:ManualTask",
  "bpmn:BusinessRuleTask",
  "bpmn:ScriptTask",
  "bpmn:CallActivity",
  "bpmn:SubProcess",
] as const;

const REPLACEABLE_GATEWAYS = [
  "bpmn:ExclusiveGateway",
  "bpmn:ParallelGateway",
  "bpmn:InclusiveGateway",
  "bpmn:EventBasedGateway",
  "bpmn:ComplexGateway",
] as const;

function replacementsFor(type: string): readonly string[] {
  if ((REPLACEABLE_ACTIVITIES as readonly string[]).includes(type)) return REPLACEABLE_ACTIVITIES;
  if ((REPLACEABLE_GATEWAYS as readonly string[]).includes(type)) return REPLACEABLE_GATEWAYS;
  return [];
}

/**
 * Which Flowable attributes make sense for which BPMN type.
 *
 * Keys are the **local** names, not `flowable:`-prefixed ones. Verified against
 * bpmn-moddle: a property declared in the extension descriptor is stored on the
 * business object under its local name and serialised back with the prefix. Using
 * the prefixed key here would read `undefined` and write into `$attrs`, producing
 * a value that round-trips to XML but never appears in the panel.
 */
interface FieldSpec {
  /** Also the message-key suffix: `properties.<key>` and `properties.<key>.hint`. */
  key: string;
  /** True where the field has explanatory copy under it. */
  hint?: boolean;
}

const USER_TASK: FieldSpec[] = [
  { key: "assignee", hint: true },
  { key: "owner", hint: true },
  { key: "candidateUsers", hint: true },
  { key: "candidateGroups", hint: true },
  { key: "formKey", hint: true },
  { key: "dueDate", hint: true },
  { key: "priority", hint: true },
  { key: "category", hint: true },
  { key: "skipExpression", hint: true },
  { key: "businessCalendarName", hint: true },
];

const SERVICE_TASK: FieldSpec[] = [
  { key: "class", hint: true },
  { key: "expression" },
  { key: "delegateExpression" },
  { key: "resultVariableName" },
];

const DATA_OBJECT: FieldSpec[] = [];

const PROCESS: FieldSpec[] = [
  { key: "candidateStarterUsers" },
  { key: "candidateStarterGroups" },
  { key: "versionTag", hint: true },
];

const CALL_ACTIVITY: FieldSpec[] = [
  { key: "calledElement", hint: true },
  { key: "businessKey" },
  { key: "processInstanceName" },
];

const BUSINESS_RULE_TASK: FieldSpec[] = [
  { key: "class", hint: true },
  { key: "ruleVariablesInput", hint: true },
  { key: "rules", hint: true },
  { key: "resultVariable" },
];

const START_EVENT: FieldSpec[] = [
  { key: "initiator", hint: true },
  { key: "formKey", hint: true },
];

const RECEIVE_TASK: FieldSpec[] = [];

/**
 * Which attribute fields the panel offers per element type.
 *
 * Exported so `moddleCoverage.test.ts` can assert that every key here is actually
 * declared — either by standard BPMN or by the Flowable moddle descriptor. An undeclared
 * attribute round-trips to XML through `$attrs` but never reads back into the panel, and
 * in some cases is dropped on save entirely. That is the single most damaging bug class
 * for a modeller, and it is invisible without a check.
 */
export const FLOWABLE_FIELDS_BY_TYPE: Record<string, FieldSpec[]> = {
  "bpmn:UserTask": USER_TASK,
  "bpmn:ServiceTask": SERVICE_TASK,
  "bpmn:SendTask": SERVICE_TASK,
  "bpmn:BusinessRuleTask": BUSINESS_RULE_TASK,
  "bpmn:CallActivity": CALL_ACTIVITY,
  "bpmn:StartEvent": START_EVENT,
  "bpmn:ReceiveTask": RECEIVE_TASK,
  "bpmn:DataObject": DATA_OBJECT,
  "bpmn:Process": PROCESS,
};

/**
 * Attributes the panel writes outside the `FieldSpec` lists — checkboxes, selects and the
 * type selector. Listed explicitly because they are set through `onChange` calls rather
 * than driven by a table, so nothing else can enumerate them.
 */
export const EXTRA_WRITTEN_ATTRIBUTES: Record<string, string[]> = {
  "bpmn:UserTask": ["formFieldValidation", "async", "exclusive", "isForCompensation"],
  "bpmn:ServiceTask": ["type", "topic", "async", "exclusive", "isForCompensation"],
  "bpmn:ScriptTask": [
    "scriptFormat",
    "script",
    "resultVariable",
    "autoStoreVariables",
    "async",
    "exclusive",
    "isForCompensation",
  ],
  "bpmn:CallActivity": [
    "calledElementType",
    "inheritVariables",
    "inheritBusinessKey",
    "sameDeployment",
    "fallbackToDefaultTenant",
    "async",
    "exclusive",
    "isForCompensation",
  ],
  "bpmn:StartEvent": ["initiator", "formKey", "formFieldValidation", "isInterrupting"],
  "bpmn:BoundaryEvent": ["cancelActivity"],
  "bpmn:ExclusiveGateway": ["default", "async", "exclusive"],
  "bpmn:InclusiveGateway": ["default", "async", "exclusive"],
  "bpmn:Process": ["isExecutable"],
  "bpmn:DataObject": ["itemSubjectRef"],
  "bpmn:MultiInstanceLoopCharacteristics": [
    "isSequential",
    "collection",
    "elementVariable",
    "elementIndexVariable",
    "loopCardinality",
    "completionCondition",
  ],
};

function fieldsFor(type: string): FieldSpec[] {
  if (type === "bpmn:ServiceTask" || type === "bpmn:SendTask") return SERVICE_TASK;
  if (isDataObject(type)) return DATA_OBJECT;
  return FLOWABLE_FIELDS_BY_TYPE[type] ?? [];
}

function isServiceTaskLike(type: string): boolean {
  return type === "bpmn:ServiceTask" || type === "bpmn:SendTask";
}

/** A pool. Its `processRef` holds everything the engine actually executes. */
function isParticipant(type: string): boolean {
  return type === "bpmn:Participant";
}

export function PropertiesPanel({
  element,
  disabled = false,
  onChange,
  moddle,
  getRootElements,
  addRootElement,
  getOutgoingFlows,
  getFlowElement,
  ensureNamespace,
  identities,
  onIdentitySearch,
  replaceElementType,
  updateModdleProperties,
}: PropertiesPanelProps) {
  const t = useT();
  if (!element) {
    return (
      <aside className="tf-properties" aria-label={t("properties.label")}>
        <p className="tf-muted tf-properties__empty">{t("properties.selectAnElement")}</p>
      </aside>
    );
  }

  const business = element.businessObject;
  const type = business.$type;
  const extras = fieldsFor(type);

  const set = (key: string, value: string) =>
    // An empty string would serialise as an empty attribute; undefined removes it.
    onChange(element, { [key]: value.trim() === "" ? undefined : value });

  return (
    <aside className="tf-properties" aria-label={t("properties.label")}>
      <header className="tf-properties__header">
        <h2 className="tf-properties__title">{labelForType(type)}</h2>
        <p className="tf-properties__type">{type}</p>
      </header>

      <PropertyTextInput
        label={t("properties.id")}
        value={String(business.id ?? "")}
        disabled={disabled}
        hint={t("properties.id.hint")}
        onCommit={(value) => set("id", value)}
      />
      <PropertyTextInput
        label={t("properties.name")}
        value={String(business.name ?? "")}
        disabled={disabled}
        onCommit={(value) => set("name", value)}
      />

      {replaceElementType && replacementsFor(type).length > 0 ? (
        <SelectInput
          label={t("properties.elementType")}
          value={type}
          disabled={disabled}
          hint={t("properties.elementType.hint")}
          onChange={(event) => replaceElementType(element, event.target.value)}
        >
          {replacementsFor(type).map((option) => (
            <option key={option} value={option}>
              {labelForType(option)}
            </option>
          ))}
        </SelectInput>
      ) : null}

      {/* §7.4.2 names documentation alongside id and name; it applies to every element. */}
      {moddle ? (
        <PropertyTextInput
          label={t("properties.documentation")}
          value={readDocumentation(business)}
          disabled={disabled}
          rows={3}
          hint={t("properties.documentation.hint")}
          onCommit={(value) =>
            onChange(element, { documentation: buildDocumentation(moddle, value) })
          }
          multiline
        />
      ) : null}

      {type === "bpmn:SequenceFlow" && moddle ? (
        <PropertyTextInput
          label={t("properties.condition")}
          value={readCondition(business)}
          disabled={disabled}
          hint={t("properties.condition.hint")}
          onCommit={(value) =>
            onChange(element, { conditionExpression: buildCondition(moddle, value) })
          }
        />
      ) : null}

      {/*
        The Flowable task subtype. Placed above the attribute fields because it decides
        which of them are meaningful — an external worker task has a topic and no class,
        an HTTP task has neither and is configured entirely through field injections.
      */}
      {isServiceTaskLike(type) ? (
        <SelectInput
          label={t("properties.taskType")}
          value={String(business.type ?? "")}
          disabled={disabled}
          hint={t("properties.taskType.hint")}
          onChange={(event) => set("type", event.target.value)}
        >
          {SERVICE_TASK_TYPES.map((value) => (
            <option key={value || "default"} value={value}>
              {t(`properties.taskType.${value || "default"}`)}
            </option>
          ))}
        </SelectInput>
      ) : null}

      {isServiceTaskLike(type) && business.type === "external-worker" ? (
        <PropertyTextInput
          label={t("properties.topic")}
          value={String(business.topic ?? "")}
          disabled={disabled}
          hint={t("properties.topic.hint")}
          onCommit={(value) => set("topic", value)}
        />
      ) : null}

      {/*
        The decision key is a field injection under a name nobody should be expected to
        remember, so it gets a labelled control. It reads and writes the same field the
        editor below lists — set it in either place and the other follows.
      */}
      {moddle && isServiceTaskLike(type) && business.type === "dmn" ? (
        <PropertyTextInput
          label={t("properties.decisionKey")}
          value={readNamedField(business, DECISION_KEY_FIELD)}
          disabled={disabled}
          hint={t("properties.decisionKey.hint")}
          onCommit={(value) =>
            onChange(element, {
              extensionElements: writeNamedField(
                moddle,
                business,
                DECISION_KEY_FIELD,
                value,
              ),
            })
          }
        />
      ) : null}

      {isServiceTaskLike(type) && FIELD_CONFIGURED_TYPES.has(String(business.type ?? "")) ? (
        <p className="tf-muted tf-properties__hint">
          {t(`properties.taskType.${String(business.type)}.configuredBy`)}
        </p>
      ) : null}

      {type === "bpmn:ScriptTask" ? (
        <ScriptSection t={t} element={element} disabled={disabled} onChange={onChange} />
      ) : null}

      {/*
        A pool is a `bpmn:Participant`, and the process it stands for is a separate moddle
        object that nothing on the canvas selects. Without this, every process-level
        property — candidate starters, executability, version tag, engine listeners — is
        unreachable in any collaboration diagram.
      */}
      {isParticipant(type) && updateModdleProperties && business.processRef ? (
        <ParticipantProcessSection
          t={t}
          element={element}
          moddle={moddle ?? null}
          disabled={disabled}
          updateModdleProperties={updateModdleProperties}
        />
      ) : null}

      {type === "bpmn:Process" ? (
        <label className="tf-checkbox tf-checkbox--block">
          <input
            type="checkbox"
            checked={business.isExecutable !== false}
            disabled={disabled}
            onChange={(event) => onChange(element, { isExecutable: event.target.checked })}
          />
          {t("properties.isExecutable")}
        </label>
      ) : null}

      {/*
        A non-interrupting start event is what makes an event sub-process observe rather
        than replace its parent, so this is the switch between two very different models.
      */}
      {type === "bpmn:StartEvent" && business.eventDefinitions ? (
        <label className="tf-checkbox tf-checkbox--block">
          <input
            type="checkbox"
            checked={business.isInterrupting !== false}
            disabled={disabled}
            onChange={(event) => onChange(element, { isInterrupting: event.target.checked })}
          />
          {t("properties.isInterrupting")}
        </label>
      ) : null}

      {type === "bpmn:StartEvent" || type === "bpmn:UserTask" ? (
        <label className="tf-checkbox tf-checkbox--block">
          <input
            type="checkbox"
            checked={business.formFieldValidation === "true"}
            disabled={disabled}
            onChange={(event) =>
              onChange(element, { formFieldValidation: event.target.checked ? "true" : undefined })
            }
          />
          {t("properties.formFieldValidation")}
        </label>
      ) : null}

      {moddle && isDataObject(type) ? (
        <DataObjectSection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
          ensureNamespace={ensureNamespace}
        />
      ) : null}

      {supportsCompensation(type) ? (
        <label className="tf-checkbox tf-checkbox--block">
          <input
            type="checkbox"
            checked={business.isForCompensation === true}
            disabled={disabled}
            onChange={(event) =>
              onChange(element, { isForCompensation: event.target.checked || undefined })
            }
          />
          {t("properties.isForCompensation")}
        </label>
      ) : null}

      {supportsDefaultFlow(type) && getOutgoingFlows && getFlowElement ? (
        <DefaultFlowSelect
          t={t}
          element={element}
          disabled={disabled}
          getOutgoingFlows={getOutgoingFlows}
          getFlowElement={getFlowElement}
          onChange={onChange}
        />
      ) : null}

      {extras.length > 0 ? (
        <section className="tf-properties__section">
          <h3 className="tf-properties__section-title">{t("properties.flowable")}</h3>
          {extras.map((field) => (
            <PropertyTextInput
              key={field.key}
              label={t(`properties.${field.key}`)}
              hint={field.hint ? t(`properties.${field.key}.hint`) : undefined}
              value={String(business[field.key] ?? "")}
              disabled={disabled}
              suggestions={suggestionsFor(field.key, String(business[field.key] ?? ""), identities)}
              onDraftChange={(draft) => {
                const kind = searchKindFor(field.key);
                if (kind) onIdentitySearch?.(kind, activeToken(draft));
              }}
              onCommit={(value) => set(field.key, value)}
            />
          ))}
        </section>
      ) : null}

      {isAsyncCapable(type) ? (
        <>
          <label className="tf-checkbox tf-checkbox--block">
            <input
              type="checkbox"
              checked={business.async === true}
              disabled={disabled}
              onChange={(event) => onChange(element, { async: event.target.checked || undefined })}
            />
            {t("properties.async")}
          </label>
          {/*
            Only meaningful once async: exclusive governs whether the *job* the engine
            creates may run alongside another job of the same instance. Flowable's default
            is exclusive, so this writes an explicit false rather than removing it.
          */}
          {business.async === true ? (
            <>
              <label className="tf-checkbox tf-checkbox--block">
                <input
                  type="checkbox"
                  checked={business.exclusive !== false}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(element, { exclusive: event.target.checked ? undefined : false })
                  }
                />
                {t("properties.exclusive")}
              </label>
              <p className="tf-muted tf-properties__hint">{t("properties.exclusive.hint")}</p>
            </>
          ) : null}
        </>
      ) : null}

      {/*
        Everything below is a nested moddle object rather than an attribute (§7.4.2).
        Without the factory they cannot be written, so they are not offered — showing
        controls that silently do nothing would be worse than showing none.
      */}
      {moddle && isBoundaryEvent(type) ? (
        <BoundarySection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {moddle && supportsMultiInstance(type) ? (
        <MultiInstanceSection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {moddle && supportsExecutionListeners(type) ? (
        <ListenerSection
          t={t}
          kind="execution"
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {moddle && type === "bpmn:UserTask" ? (
        <ListenerSection
          t={t}
          kind="task"
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {/*
        Field injections. Below the listeners because they are configuration of the
        activity itself rather than hooks around it — and for the HTTP/mail/DMN subtypes
        this section *is* the configuration.
      */}
      {moddle && supportsFormProperties(type) ? (
        <FormPropertySection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {moddle && supportsJobSettings(type) ? (
        <JobSettingsSection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {moddle && type === "bpmn:Process" ? (
        <EngineEventListenerSection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {moddle && supportsFields(type) ? (
        <FieldSection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {moddle && supportsMappings(type) ? (
        <>
          <MappingSection
            t={t}
            kind="in"
            element={element}
            moddle={moddle}
            disabled={disabled}
            onChange={onChange}
          />
          <MappingSection
            t={t}
            kind="out"
            element={element}
            moddle={moddle}
            disabled={disabled}
            onChange={onChange}
          />
        </>
      ) : null}

      {type === "bpmn:CallActivity" ? (
        <CallActivityFlags t={t} element={element} disabled={disabled} onChange={onChange} />
      ) : null}

      {moddle && getRootElements && addRootElement ? (
        <EventDefinitionSection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={onChange}
          getRootElements={getRootElements}
          addRootElement={addRootElement}
        />
      ) : null}
    </aside>
  );
}

function isAsyncCapable(type: string): boolean {
  return (
    type.endsWith("Task") ||
    type === "bpmn:CallActivity" ||
    type === "bpmn:SubProcess" ||
    type.endsWith("Gateway")
  );
}

export function labelForType(type: string): string {
  const bare = type.replace(/^bpmn:/, "");
  return bare.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/* ── Sections for the nested (non-attribute) properties, §7.4.2 ─────────────── */

interface SectionProps {
  t: TFunction;
  element: BpmnElement;
  moddle: ModdleFactory;
  disabled: boolean;
  onChange: (element: BpmnElement, properties: Record<string, unknown>) => void;
}

/**
 * Execution and task listeners.
 *
 * Edited as whole rows rather than field by field: a listener is only meaningful with
 * an event and an implementation together, and writing a half-built one to the model on
 * every keystroke would leave the diagram briefly invalid.
 */
function ListenerSection({
  t,
  kind,
  element,
  moddle,
  disabled,
  onChange,
}: SectionProps & { kind: ListenerKind }) {
  const rows = readListeners(element.businessObject, kind);
  const events = kind === "execution" ? EXECUTION_EVENTS : TASK_EVENTS;

  const commit = (next: ListenerRow[]) =>
    onChange(element, {
      extensionElements: writeListeners(moddle, element.businessObject, kind, next),
    });

  const update = (index: number, patch: Partial<ListenerRow>) =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t(`properties.listeners.${kind}`)}</h3>
      <p className="tf-muted tf-properties__hint">{t(`properties.listeners.${kind}.hint`)}</p>

      {rows.length === 0 ? (
        <p className="tf-muted">{t("properties.listeners.none")}</p>
      ) : (
        <ul className="tf-properties__rows">
          {rows.map((row, index) => (
            <li className="tf-properties__row" key={index}>
              <SelectInput
                label={t("properties.listeners.event")}
                value={row.event}
                disabled={disabled}
                onChange={(event) => update(index, { event: event.target.value })}
              >
                {events.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </SelectInput>
              <SelectInput
                label={t("properties.listeners.implementation")}
                value={row.implementationType}
                disabled={disabled}
                onChange={(event) =>
                  update(index, { implementationType: event.target.value as ImplementationType })
                }
              >
                <option value="class">{t("properties.class")}</option>
                <option value="expression">{t("properties.expression")}</option>
                <option value="delegateExpression">{t("properties.delegateExpression")}</option>
              </SelectInput>
              <PropertyTextInput
                label={t("properties.listeners.value")}
                value={row.value}
                disabled={disabled}
                onCommit={(value) => update(index, { value: value })}
              />
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={t("properties.listeners.remove", { index: index + 1 })}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() =>
          commit([...rows, { event: events[0], implementationType: "class", value: "" }])
        }
      >
        {t("properties.listeners.add")}
      </Button>
    </section>
  );
}

const MULTI_INSTANCE_MODES: MultiInstanceMode[] = ["none", "parallel", "sequential"];

function MultiInstanceSection({ t, element, moddle, disabled, onChange }: SectionProps) {
  const config = readMultiInstance(element.businessObject);

  const commit = (next: MultiInstanceConfig) =>
    onChange(element, { loopCharacteristics: buildMultiInstance(moddle, next) });

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.multiInstance")}</h3>
      <SelectInput
        label={t("properties.multiInstance.mode")}
        value={config.mode}
        disabled={disabled}
        hint={t("properties.multiInstance.hint")}
        onChange={(event) => commit({ ...config, mode: event.target.value as MultiInstanceMode })}
      >
        {MULTI_INSTANCE_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`properties.multiInstance.${mode}`)}
          </option>
        ))}
      </SelectInput>

      {/* The rest is meaningless without a loop, so it appears only once there is one. */}
      {config.mode !== "none" ? (
        <>
          <PropertyTextInput
            label={t("properties.multiInstance.collection")}
            value={config.collection}
            disabled={disabled}
            hint={t("properties.multiInstance.collection.hint")}
            onCommit={(value) => commit({ ...config, collection: value })}
          />
          <PropertyTextInput
            label={t("properties.multiInstance.elementVariable")}
            value={config.elementVariable}
            disabled={disabled}
            hint={t("properties.multiInstance.elementVariable.hint")}
            onCommit={(value) => commit({ ...config, elementVariable: value })}
          />
          <PropertyTextInput
            label={t("properties.multiInstance.elementIndexVariable")}
            value={config.elementIndexVariable}
            disabled={disabled}
            hint={t("properties.multiInstance.elementIndexVariable.hint")}
            onCommit={(value) => commit({ ...config, elementIndexVariable: value })}
          />
          <PropertyTextInput
            label={t("properties.multiInstance.cardinality")}
            value={config.cardinality}
            disabled={disabled}
            hint={t("properties.multiInstance.cardinality.hint")}
            onCommit={(value) => commit({ ...config, cardinality: value })}
          />
          <PropertyTextInput
            label={t("properties.multiInstance.completionCondition")}
            value={config.completionCondition}
            disabled={disabled}
            hint={t("properties.multiInstance.completionCondition.hint")}
            onCommit={(value) => commit({ ...config, completionCondition: value })}
          />

          {/*
            Aggregation lives inside the loop characteristics rather than on the activity,
            so it is configured here rather than as a section of its own.
          */}
          <PropertyTextInput
            label={t("properties.aggregation.target")}
            value={config.aggregation.target}
            disabled={disabled}
            hint={t("properties.aggregation.target.hint")}
            onCommit={(value) =>
              commit({
                ...config,
                aggregation: { ...config.aggregation, target: value },
              })
            }
          />
          {config.aggregation.target.trim() !== "" ? (
            <>
              <PropertyTextInput
                label={t("properties.aggregation.variables")}
                value={config.aggregation.variables.map((variable) => variable.source).join(", ")}
                disabled={disabled}
                hint={t("properties.aggregation.variables.hint")}
                onCommit={(value) =>
                  commit({
                    ...config,
                    aggregation: {
                      ...config.aggregation,
                      variables: value
                        .split(",")
                        .map((name) => name.trim())
                        .filter((name) => name !== "")
                        .map((name) => ({ source: name, target: name })),
                    },
                  })
                }
              />
              <label className="tf-checkbox tf-checkbox--block">
                <input
                  type="checkbox"
                  checked={config.aggregation.createOverviewVariable}
                  disabled={disabled}
                  onChange={(event) =>
                    commit({
                      ...config,
                      aggregation: {
                        ...config.aggregation,
                        createOverviewVariable: event.target.checked,
                      },
                    })
                  }
                />
                {t("properties.aggregation.overview")}
              </label>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const TIMER_KINDS: TimerKind[] = ["duration", "date", "cycle"];

/**
 * Boundary event configuration: whether it interrupts, and — for a timer — when it fires.
 *
 * Only timers get an expression editor. The other boundary types (error, signal, message)
 * reference a definition declared at the process level, which is a different piece of
 * scope; offering an empty box for them would suggest otherwise.
 */
function BoundarySection({ t, element, moddle, disabled, onChange }: SectionProps) {
  const business = element.businessObject;
  const timer = readTimer(business);
  // BPMN's default is interrupting, and the attribute is absent rather than true.
  const interrupting = business.cancelActivity !== false;
  /*
   * An error boundary event is the one kind whose interrupting flag the engine does not
   * honour: BoundaryEventXMLConverter overwrites `cancelActivity` to false on parse,
   * whatever the XML said. Verified by deploying a model with `cancelActivity="true"` and
   * reading the parsed definition back. Offering the toggle here would be offering a
   * control that silently does nothing.
   */
  const forcedByEngine = eventDefinitionKindOf(business) === "error";

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.boundary")}</h3>

      {forcedByEngine ? (
        <p className="tf-muted tf-properties__hint">{t("properties.boundary.errorForced")}</p>
      ) : (
        <>
          <label className="tf-checkbox tf-checkbox--block">
            <input
              type="checkbox"
              checked={interrupting}
              disabled={disabled}
              onChange={(event) =>
                // Written as an explicit false rather than removed: the absent attribute
                // means interrupting, so clearing it would flip the meaning back.
                onChange(element, { cancelActivity: event.target.checked ? undefined : false })
              }
            />
            {t("properties.boundary.interrupting")}
          </label>
          <p className="tf-muted tf-properties__hint">{t("properties.boundary.interrupting.hint")}</p>
        </>
      )}

      {timer ? (
        <>
          <SelectInput
            label={t("properties.timer.kind")}
            value={timer.kind}
            disabled={disabled}
            onChange={(event) =>
              onChange(element, {
                eventDefinitions: applyTimer(moddle, business, {
                  kind: event.target.value as TimerKind,
                  value: timer.value,
                }),
              })
            }
          >
            {TIMER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`properties.timer.${kind}`)}
              </option>
            ))}
          </SelectInput>
          <PropertyTextInput
            label={t("properties.timer.value")}
            value={timer.value}
            disabled={disabled}
            hint={t(`properties.timer.${timer.kind}.hint`)}
            onCommit={(value) =>
              onChange(element, {
                eventDefinitions: applyTimer(moddle, business, {
                  kind: timer.kind,
                  value: value,
                }),
              })
            }
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * A script task's body.
 *
 * `script` is a child element rather than an attribute, but bpmn-moddle models it as a
 * plain String property, so a normal property update reaches it — the reason script tasks
 * were previously unconfigurable was simply that nothing rendered a control for it.
 */
function ScriptSection({
  t,
  element,
  disabled,
  onChange,
}: {
  t: TFunction;
  element: BpmnElement;
  disabled: boolean;
  onChange: (element: BpmnElement, properties: Record<string, unknown>) => void;
}) {
  const business = element.businessObject;
  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.script")}</h3>
      <PropertyTextInput
        label={t("properties.scriptFormat")}
        value={String(business.scriptFormat ?? "")}
        disabled={disabled}
        hint={t("properties.scriptFormat.hint")}
        onCommit={(value) =>
          onChange(element, {
            scriptFormat: value.trim() === "" ? undefined : value,
          })
        }
      />
      <PropertyTextInput
        label={t("properties.script.body")}
        value={readScript(business)}
        disabled={disabled}
        rows={8}
        hint={t("properties.script.body.hint")}
        // Not trimmed: indentation is part of a script.
        onCommit={(value) =>
          onChange(element, { script: value === "" ? undefined : value })
        }
          multiline
        />
      <PropertyTextInput
        label={t("properties.resultVariable")}
        value={String(business.resultVariable ?? "")}
        disabled={disabled}
        hint={t("properties.resultVariable.hint")}
        onCommit={(value) =>
          onChange(element, {
            resultVariable: value.trim() === "" ? undefined : value.trim(),
          })
        }
      />
      <label className="tf-checkbox tf-checkbox--block">
        <input
          type="checkbox"
          checked={business.autoStoreVariables === true}
          disabled={disabled}
          onChange={(event) =>
            onChange(element, { autoStoreVariables: event.target.checked || undefined })
          }
        />
        {t("properties.autoStoreVariables")}
      </label>
      <p className="tf-muted tf-properties__hint">{t("properties.autoStoreVariables.hint")}</p>
    </section>
  );
}

/**
 * Field injections — the configuration mechanism for the whole service-task family.
 *
 * Edited as whole rows for the same reason as listeners: a field is only meaningful with
 * a name and a value together.
 */
const FIELD_VALUE_KINDS: FieldValueKind[] = ["stringValue", "expression", "string"];

function FieldSection({ t, element, moddle, disabled, onChange }: SectionProps) {
  const rows = readFields(element.businessObject);

  const commit = (next: FieldRow[]) =>
    onChange(element, { extensionElements: writeFields(moddle, element.businessObject, next) });

  const update = (index: number, patch: Partial<FieldRow>) =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.fields")}</h3>
      <p className="tf-muted tf-properties__hint">{t("properties.fields.hint")}</p>

      {rows.length === 0 ? (
        <p className="tf-muted">{t("properties.fields.none")}</p>
      ) : (
        <ul className="tf-properties__rows">
          {rows.map((row, index) => (
            <li className="tf-properties__row" key={index}>
              <PropertyTextInput
                label={t("properties.fields.name")}
                value={row.name}
                disabled={disabled}
                onCommit={(value) => update(index, { name: value })}
              />
              <SelectInput
                label={t("properties.fields.kind")}
                value={row.valueKind}
                disabled={disabled}
                onChange={(event) =>
                  update(index, { valueKind: event.target.value as FieldValueKind })
                }
              >
                {FIELD_VALUE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`properties.fields.kind.${kind}`)}
                  </option>
                ))}
              </SelectInput>
              {/* A `string` field is the multi-line form, so it gets a multi-line control. */}
              {row.valueKind === "string" ? (
                <PropertyTextInput
                  label={t("properties.fields.value")}
                  value={row.value}
                  disabled={disabled}
                  rows={4}
                  onCommit={(value) => update(index, { value: value })}
          multiline
        />
              ) : (
                <PropertyTextInput
                  label={t("properties.fields.value")}
                  value={row.value}
                  disabled={disabled}
                  onCommit={(value) => update(index, { value: value })}
                />
              )}
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={t("properties.fields.remove", { index: index + 1 })}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() => commit([...rows, { name: "", valueKind: "stringValue", value: "" }])}
      >
        {t("properties.fields.add")}
      </Button>
    </section>
  );
}

/** Variable mapping into and out of a called process or case. */
function MappingSection({
  t,
  kind,
  element,
  moddle,
  disabled,
  onChange,
}: SectionProps & { kind: MappingKind }) {
  const rows = readMappings(element.businessObject, kind);

  const commit = (next: MappingRow[]) =>
    onChange(element, {
      extensionElements: writeMappings(moddle, element.businessObject, kind, next),
    });

  const update = (index: number, patch: Partial<MappingRow>) =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t(`properties.mapping.${kind}`)}</h3>
      <p className="tf-muted tf-properties__hint">{t(`properties.mapping.${kind}.hint`)}</p>

      {rows.length === 0 ? (
        <p className="tf-muted">{t("properties.mapping.none")}</p>
      ) : (
        <ul className="tf-properties__rows">
          {rows.map((row, index) => (
            <li className="tf-properties__row" key={index}>
              <PropertyTextInput
                label={t("properties.mapping.source")}
                value={row.source}
                disabled={disabled}
                onCommit={(value) => update(index, { source: value })}
              />
              <label className="tf-checkbox">
                <input
                  type="checkbox"
                  checked={row.sourceIsExpression}
                  disabled={disabled}
                  onChange={(event) => update(index, { sourceIsExpression: event.target.checked })}
                />
                {t("properties.mapping.sourceIsExpression")}
              </label>
              <PropertyTextInput
                label={t("properties.mapping.target")}
                value={row.target}
                disabled={disabled}
                onCommit={(value) => update(index, { target: value })}
              />
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={t("properties.mapping.remove", { index: index + 1 })}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() => commit([...rows, { source: "", sourceIsExpression: false, target: "" }])}
      >
        {t("properties.mapping.add")}
      </Button>
    </section>
  );
}

/** The boolean call-activity settings, which are all `flowable:` attributes. */
function CallActivityFlags({
  t,
  element,
  disabled,
  onChange,
}: {
  t: TFunction;
  element: BpmnElement;
  disabled: boolean;
  onChange: (element: BpmnElement, properties: Record<string, unknown>) => void;
}) {
  const business = element.businessObject;
  const flag = (key: string) => business[key] === true;
  const toggle = (key: string) => (event: { target: { checked: boolean } }) =>
    onChange(element, { [key]: event.target.checked || undefined });

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.callActivity")}</h3>
      <SelectInput
        label={t("properties.calledElementType")}
        value={String(business.calledElementType ?? "")}
        disabled={disabled}
        hint={t("properties.calledElementType.hint")}
        onChange={(event) =>
          onChange(element, {
            calledElementType: event.target.value === "" ? undefined : event.target.value,
          })
        }
      >
        <option value="">{t("properties.calledElementType.key")}</option>
        <option value="id">{t("properties.calledElementType.id")}</option>
      </SelectInput>

      {(
        [
          "inheritVariables",
          "inheritBusinessKey",
          "sameDeployment",
          "fallbackToDefaultTenant",
        ] as const
      ).map((key) => (
        <label className="tf-checkbox tf-checkbox--block" key={key}>
          <input type="checkbox" checked={flag(key)} disabled={disabled} onChange={toggle(key)} />
          {t(`properties.${key}`)}
        </label>
      ))}
      <p className="tf-muted tf-properties__hint">{t("properties.inheritVariables.hint")}</p>
    </section>
  );
}

/**
 * Which outgoing flow a gateway takes when no condition matches.
 *
 * Offered as a list of the gateway's actual outgoing flows rather than a free-text id:
 * `default` is a reference, so a typed id would produce a dangling one that serialises
 * and then fails at deployment. The validator already warns when this is unset — before
 * this control existed, that warning named a problem with no remedy.
 */
function DefaultFlowSelect({
  t,
  element,
  disabled,
  getOutgoingFlows,
  getFlowElement,
  onChange,
}: {
  t: TFunction;
  element: BpmnElement;
  disabled: boolean;
  getOutgoingFlows: (elementId: string) => Array<{ id: string; name: string }>;
  getFlowElement: (flowId: string) => unknown;
  onChange: (element: BpmnElement, properties: Record<string, unknown>) => void;
}) {
  const flows = getOutgoingFlows(element.id);
  const current = readDefaultFlow(element.businessObject);

  return (
    <SelectInput
      label={t("properties.defaultFlow")}
      value={current}
      disabled={disabled || flows.length === 0}
      hint={t("properties.defaultFlow.hint")}
      onChange={(event) =>
        onChange(element, {
          default: event.target.value === "" ? undefined : getFlowElement(event.target.value),
        })
      }
    >
      <option value="">{t("properties.defaultFlow.none")}</option>
      {flows.map((flow) => (
        <option key={flow.id} value={flow.id}>
          {flow.name || flow.id}
        </option>
      ))}
    </SelectInput>
  );
}

const REFERENCE_KINDS: EventDefinitionKind[] = ["error", "signal", "message", "escalation"];

/**
 * Error, signal, message, escalation and conditional event configuration.
 *
 * The first four reference a definitions-level declaration rather than carrying their
 * configuration inline, and nothing in this editor could previously create one — so those
 * events could be drawn and never wired up. Typing a name that does not exist declares it,
 * which is the behaviour every other BPMN tool has and the one that makes the reference
 * usable without a second screen.
 */
function EventDefinitionSection({
  t,
  element,
  moddle,
  disabled,
  onChange,
  getRootElements,
  addRootElement,
}: SectionProps & {
  getRootElements: () => ModdleElement[];
  addRootElement: (root: ModdleElement) => void;
}) {
  const business = element.businessObject;
  const kind = eventDefinitionKindOf(business);
  // Timers have their own section; a plain event has nothing to configure here.
  if (!kind) return null;

  if (kind === "conditional") {
    return (
      <section className="tf-properties__section">
        <h3 className="tf-properties__section-title">{t("properties.event.conditional")}</h3>
        <PropertyTextInput
          label={t("properties.event.condition")}
          value={readEventCondition(business)}
          disabled={disabled}
          hint={t("properties.event.condition.hint")}
          onCommit={(value) =>
            onChange(element, {
              eventDefinitions: applyEventCondition(moddle, business, value),
            })
          }
        />
      </section>
    );
  }

  if (!REFERENCE_KINDS.includes(kind)) return null;

  const current = readEventReference(business, kind);
  const existing = getRootElements();

  const commit = (value: string) => {
    const { eventDefinitions, created } = applyEventReference(
      moddle,
      business,
      kind,
      value,
      existing,
    );
    // The declaration has to exist before the reference to it is committed, or the
    // serialiser writes a reference to nothing.
    if (created) addRootElement(created);
    onChange(element, { eventDefinitions });
  };

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t(`properties.event.${kind}`)}</h3>
      <PropertyTextInput
        label={t(`properties.event.${kind}.ref`)}
        value={current}
        disabled={disabled}
        hint={t(`properties.event.${kind}.hint`)}
        list={`tf-event-refs-${kind}`}
        onCommit={(value) => commit(value)}
      />
      {/* Existing declarations offered as completions, so the common case is a pick. */}
      <datalist id={`tf-event-refs-${kind}`}>
        {existing
          .filter((root) => root.$type === EVENT_ROOT_TYPE_BY_KIND[kind])
          .map((root) => (
            <option key={String(root.id)} value={String(root.id)} />
          ))}
      </datalist>
    </section>
  );
}

const EVENT_ROOT_TYPE_BY_KIND: Record<string, string> = {
  error: "bpmn:Error",
  signal: "bpmn:Signal",
  message: "bpmn:Message",
  escalation: "bpmn:Escalation",
};

/**
 * The engine's own form model (§7.4.2).
 *
 * Work renders these natively when a task has no external form key, so this is the path
 * to a working form without a separate form definition. `enum` properties additionally
 * carry their options, which is why the row expands rather than staying one line.
 */
function FormPropertySection({ t, element, moddle, disabled, onChange }: SectionProps) {
  const rows = readFormProperties(element.businessObject);

  const commit = (next: FormPropertyRow[]) =>
    onChange(element, {
      extensionElements: writeFormProperties(moddle, element.businessObject, next),
    });

  const update = (index: number, patch: Partial<FormPropertyRow>) =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.formProperties")}</h3>
      <p className="tf-muted tf-properties__hint">{t("properties.formProperties.hint")}</p>

      {rows.length === 0 ? (
        <p className="tf-muted">{t("properties.formProperties.none")}</p>
      ) : (
        <ul className="tf-properties__rows">
          {rows.map((row, index) => (
            <li className="tf-properties__row" key={index}>
              <PropertyTextInput
                label={t("properties.formProperties.id")}
                value={row.id}
                disabled={disabled}
                hint={t("properties.formProperties.id.hint")}
                onCommit={(value) => update(index, { id: value })}
              />
              <PropertyTextInput
                label={t("properties.formProperties.name")}
                value={row.name}
                disabled={disabled}
                onCommit={(value) => update(index, { name: value })}
              />
              <SelectInput
                label={t("properties.formProperties.type")}
                value={row.type}
                disabled={disabled}
                onChange={(event) => update(index, { type: event.target.value })}
              >
                {FORM_PROPERTY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`properties.formProperties.type.${type}`)}
                  </option>
                ))}
              </SelectInput>
              <PropertyTextInput
                label={t("properties.formProperties.variable")}
                value={row.variable}
                disabled={disabled}
                hint={t("properties.formProperties.variable.hint")}
                onCommit={(value) => update(index, { variable: value })}
              />
              {row.type === "date" ? (
                <PropertyTextInput
                  label={t("properties.formProperties.datePattern")}
                  value={row.datePattern}
                  disabled={disabled}
                  onCommit={(value) => update(index, { datePattern: value })}
                />
              ) : null}
              {/* Options as a comma-separated list: an enum's values are short by nature. */}
              {row.type === "enum" ? (
                <PropertyTextInput
                  label={t("properties.formProperties.values")}
                  value={row.values.map((option) => option.id).join(", ")}
                  disabled={disabled}
                  hint={t("properties.formProperties.values.hint")}
                  onCommit={(value) =>
                    update(index, {
                      values: value
                        .split(",")
                        .map((option) => option.trim())
                        .filter((option) => option !== "")
                        .map((option) => ({ id: option, name: option })),
                    })
                  }
                />
              ) : null}
              <label className="tf-checkbox">
                <input
                  type="checkbox"
                  checked={row.required}
                  disabled={disabled}
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
                {t("properties.formProperties.required")}
              </label>
              <label className="tf-checkbox">
                <input
                  type="checkbox"
                  checked={row.writable}
                  disabled={disabled}
                  onChange={(event) => update(index, { writable: event.target.checked })}
                />
                {t("properties.formProperties.writable")}
              </label>
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={t("properties.formProperties.remove", { index: index + 1 })}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() =>
          commit([
            ...rows,
            {
              id: "",
              name: "",
              type: "string",
              variable: "",
              expression: "",
              defaultValue: "",
              datePattern: "",
              required: false,
              readable: true,
              writable: true,
              values: [],
            },
          ])
        }
      >
        {t("properties.formProperties.add")}
      </Button>
    </section>
  );
}

/**
 * What happens when the activity's job fails: how often it is retried, and which Java
 * exceptions become catchable BPMN errors.
 *
 * Both only bite on an async activity, since both are properties of the job the engine
 * creates — the section says so rather than hiding, because the reader needs to know the
 * setting exists before deciding to make the activity async.
 */
function JobSettingsSection({ t, element, moddle, disabled, onChange }: SectionProps) {
  const business = element.businessObject;
  const cycle = readRetryCycle(business);
  const rows = readMapExceptions(business);

  const commitExceptions = (next: MapExceptionRow[]) =>
    onChange(element, { extensionElements: writeMapExceptions(moddle, business, next) });

  const update = (index: number, patch: Partial<MapExceptionRow>) =>
    commitExceptions(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.jobs")}</h3>

      <PropertyTextInput
        label={t("properties.retryCycle")}
        value={cycle}
        disabled={disabled}
        hint={t("properties.retryCycle.hint")}
        onCommit={(value) =>
          onChange(element, {
            extensionElements: writeRetryCycle(moddle, business, value),
          })
        }
      />

      <h4 className="tf-properties__section-title">{t("properties.mapException")}</h4>
      <p className="tf-muted tf-properties__hint">{t("properties.mapException.hint")}</p>

      {rows.length === 0 ? (
        <p className="tf-muted">{t("properties.mapException.none")}</p>
      ) : (
        <ul className="tf-properties__rows">
          {rows.map((row, index) => (
            <li className="tf-properties__row" key={index}>
              <PropertyTextInput
                label={t("properties.mapException.class")}
                value={row.exceptionClass}
                disabled={disabled}
                hint={t("properties.mapException.class.hint")}
                onCommit={(value) => update(index, { exceptionClass: value })}
              />
              <PropertyTextInput
                label={t("properties.mapException.errorCode")}
                value={row.errorCode}
                disabled={disabled}
                required
                hint={t("properties.mapException.errorCode.hint")}
                onCommit={(value) => update(index, { errorCode: value })}
              />
              <label className="tf-checkbox">
                <input
                  type="checkbox"
                  checked={row.includeChildExceptions}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, { includeChildExceptions: event.target.checked })
                  }
                />
                {t("properties.mapException.includeChildren")}
              </label>
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={t("properties.mapException.remove", { index: index + 1 })}
                onClick={() => commitExceptions(rows.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() =>
          commitExceptions([
            ...rows,
            { exceptionClass: "", errorCode: "", includeChildExceptions: false, rootCause: "" },
          ])
        }
      >
        {t("properties.mapException.add")}
      </Button>
    </section>
  );
}

/**
 * Process-level engine event listeners.
 *
 * A different vocabulary from the execution listeners above: these fire on engine events
 * — a job failing, an entity being created — rather than on this element's lifecycle.
 */
function EngineEventListenerSection({
  t,
  element,
  moddle,
  disabled,
  onChange,
  businessObject,
}: SectionProps & {
  /**
   * The object the listeners hang off, when that is not the selected element's own — a
   * pool's referenced `bpmn:Process` rather than the participant.
   */
  businessObject?: BpmnElement["businessObject"];
}) {
  const target = businessObject ?? element.businessObject;
  const rows = readEventListeners(target);

  const commit = (next: EventListenerRow[]) =>
    onChange(element, { extensionElements: writeEventListeners(moddle, target, next) });

  const update = (index: number, patch: Partial<EventListenerRow>) =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.engineListeners")}</h3>
      <p className="tf-muted tf-properties__hint">{t("properties.engineListeners.hint")}</p>

      {rows.length === 0 ? (
        <p className="tf-muted">{t("properties.engineListeners.none")}</p>
      ) : (
        <ul className="tf-properties__rows">
          {rows.map((row, index) => (
            <li className="tf-properties__row" key={index}>
              <PropertyTextInput
                label={t("properties.engineListeners.events")}
                value={row.events}
                disabled={disabled}
                list="tf-engine-events"
                hint={t("properties.engineListeners.events.hint")}
                onCommit={(value) => update(index, { events: value })}
              />
              <SelectInput
                label={t("properties.listeners.implementation")}
                value={row.implementationType}
                disabled={disabled}
                onChange={(event) =>
                  update(index, {
                    implementationType: event.target.value as "class" | "delegateExpression",
                  })
                }
              >
                <option value="class">{t("properties.class")}</option>
                <option value="delegateExpression">{t("properties.delegateExpression")}</option>
              </SelectInput>
              <PropertyTextInput
                label={t("properties.listeners.value")}
                value={row.value}
                disabled={disabled}
                onCommit={(value) => update(index, { value: value })}
              />
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={t("properties.engineListeners.remove", { index: index + 1 })}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Offered as completions rather than a closed list: the engine accepts more event
          names than are worth enumerating, and a comma-separated list is valid. */}
      <datalist id="tf-engine-events">
        {ENGINE_EVENTS.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() =>
          commit([...rows, { events: "", implementationType: "class", value: "", entityType: "" }])
        }
      >
        {t("properties.engineListeners.add")}
      </Button>
    </section>
  );
}

/**
 * A data object's type and default value.
 *
 * The type is encoded in `itemSubjectRef` as an `xsd:`-prefixed name and the default is a
 * `<flowable:value>` child, so neither is reachable through the generic id/name fields.
 */
function DataObjectSection({
  t,
  element,
  moddle,
  disabled,
  onChange,
  ensureNamespace,
}: SectionProps & { ensureNamespace?: (prefix: string, uri: string) => void }) {
  const business = element.businessObject;
  const currentType = readDataObjectType(business);

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.dataObject")}</h3>
      <SelectInput
        label={t("properties.dataObject.type")}
        value={currentType}
        disabled={disabled}
        hint={t("properties.dataObject.type.hint")}
        onChange={(event) => {
          // The prefix has to be declared on `bpmn:Definitions` or the engine refuses the
          // whole model with "Undeclared prefix" — it appears only inside an attribute
          // value, which bpmn-moddle does not scan when deciding what to declare.
          ensureNamespace?.("xsd", "http://www.w3.org/2001/XMLSchema");
          onChange(element, {
            itemSubjectRef: moddle.create("bpmn:ItemDefinition", {
              structureRef: `xsd:${event.target.value}`,
            }),
          });
        }}
      >
        {DATA_OBJECT_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </SelectInput>
      <PropertyTextInput
        label={t("properties.dataObject.value")}
        value={readDataObjectValue(business)}
        disabled={disabled}
        hint={t("properties.dataObject.value.hint")}
        onCommit={(value) =>
          onChange(element, {
            extensionElements: writeDataObjectValue(moddle, business, value),
          })
        }
      />
    </section>
  );
}

/**
 * The process behind a pool.
 *
 * In a collaboration the executable definition lives on a `bpmn:Process` that the
 * `bpmn:Participant` merely references. bpmn-js selects the participant, so without this
 * section a pool-based model has no way to reach its own candidate starters, version tag
 * or executable flag — the properties that decide whether it can be started at all.
 *
 * Writes go through `updateModdleProperties` rather than `updateProperties`: the target is
 * not a diagram element, and updating it through the participant would set the attribute
 * on the wrong object.
 */
function ParticipantProcessSection({
  t,
  element,
  moddle,
  disabled,
  updateModdleProperties,
}: {
  t: TFunction;
  element: BpmnElement;
  moddle: ModdleFactory | null;
  disabled: boolean;
  updateModdleProperties: (
    element: BpmnElement,
    moddleElement: unknown,
    properties: Record<string, unknown>,
  ) => void;
}) {
  const process = element.businessObject.processRef as BpmnElement["businessObject"];

  const set = (key: string, value: unknown) => updateModdleProperties(element, process, { [key]: value });
  const setText = (key: string, value: string) =>
    set(key, value.trim() === "" ? undefined : value.trim());

  return (
    <section className="tf-properties__section">
      <h3 className="tf-properties__section-title">{t("properties.participantProcess")}</h3>
      <p className="tf-muted tf-properties__hint">{t("properties.participantProcess.hint")}</p>

      <PropertyTextInput
        label={t("properties.participantProcess.id")}
        value={String(process.id ?? "")}
        disabled={disabled}
        hint={t("properties.participantProcess.id.hint")}
        onCommit={(value) => setText("id", value)}
      />
      {PROCESS.map((field) => (
        <PropertyTextInput
          key={field.key}
          label={t(`properties.${field.key}`)}
          hint={field.hint ? t(`properties.${field.key}.hint`) : undefined}
          value={String(process[field.key] ?? "")}
          disabled={disabled}
          onCommit={(value) => setText(field.key, value)}
        />
      ))}
      <label className="tf-checkbox tf-checkbox--block">
        <input
          type="checkbox"
          checked={process.isExecutable !== false}
          disabled={disabled}
          onChange={(event) => set("isExecutable", event.target.checked)}
        />
        {t("properties.isExecutable")}
      </label>

      {/* Engine listeners live on the process too, not on the participant. */}
      {moddle ? (
        <EngineEventListenerSection
          t={t}
          element={element}
          moddle={moddle}
          disabled={disabled}
          onChange={(_target, properties) =>
            updateModdleProperties(element, process, properties)
          }
          businessObject={process}
        />
      ) : null}
    </section>
  );
}
