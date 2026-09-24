/**
 * Reading and writing the parts of a Flowable BPMN model that are not plain attributes
 * (REQUIREMENTS.md §7.4.2: "execution/service listeners, extension elements the engine
 * already supports").
 *
 * Listeners, multi-instance configuration and timer definitions are nested moddle
 * objects, not `flowable:` attributes, so `modeling.updateProperties` cannot set them
 * from a string. They have to be constructed through the moddle factory and handed over
 * as whole objects.
 *
 * Kept here as pure functions over a minimal factory interface so the shape of what gets
 * written is unit-testable without standing up bpmn-js — the previous properties panel
 * covered only attributes precisely because this layer did not exist.
 */

/** The slice of moddle this module needs; bpmn-js's `moddle` satisfies it. */
export interface ModdleFactory {
  create: (type: string, properties?: Record<string, unknown>) => ModdleElement;
}

export interface ModdleElement {
  $type: string;
  [key: string]: unknown;
}

interface BusinessObject {
  $type: string;
  extensionElements?: { values?: ModdleElement[] } | null;
  loopCharacteristics?: ModdleElement | null;
  eventDefinitions?: ModdleElement[] | null;
  [key: string]: unknown;
}

/* ── Listeners ─────────────────────────────────────────────────────────────── */

export type ListenerKind = "execution" | "task";

/** How the listener names its code. Flowable accepts exactly one of the three. */
export type ImplementationType = "class" | "expression" | "delegateExpression";

export interface ListenerRow {
  /** `start`/`end` for execution listeners; `create`/`assignment`/`complete`/`delete` for task. */
  event: string;
  implementationType: ImplementationType;
  value: string;
}

export const EXECUTION_EVENTS = ["start", "end", "take"] as const;
export const TASK_EVENTS = ["create", "assignment", "complete", "delete"] as const;

const LISTENER_TYPE: Record<ListenerKind, string> = {
  execution: "flowable:ExecutionListener",
  task: "flowable:TaskListener",
};

const IMPLEMENTATION_TYPES: ImplementationType[] = ["class", "expression", "delegateExpression"];

export function readListeners(businessObject: BusinessObject, kind: ListenerKind): ListenerRow[] {
  const values = businessObject.extensionElements?.values ?? [];
  return values
    .filter((value) => value.$type === LISTENER_TYPE[kind])
    .map((listener) => {
      // A listener declares exactly one implementation; the first present one wins, and
      // a malformed listener with none still round-trips as an empty value rather than
      // being silently dropped.
      const implementationType =
        IMPLEMENTATION_TYPES.find((candidate) => typeof listener[candidate] === "string") ?? "class";
      return {
        event: String(listener.event ?? ""),
        implementationType,
        value: String(listener[implementationType] ?? ""),
      };
    });
}

/**
 * Rebuilds `extensionElements` with `kind`'s listeners replaced by `rows`.
 *
 * Everything else under `extensionElements` is carried across untouched — form
 * properties, the other listener kind, anything a model brought with it that this editor
 * does not understand. Dropping those would quietly delete parts of a model on save,
 * which is the failure the moddle descriptor exists to prevent in the first place.
 *
 * Returns `undefined` when nothing is left, so the element is written without an empty
 * `<extensionElements/>`.
 */
export function writeListeners(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  kind: ListenerKind,
  rows: ListenerRow[],
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((value) => value.$type !== LISTENER_TYPE[kind]);

  const listeners = rows
    // A listener with no implementation is not something the engine can run.
    .filter((row) => row.value.trim() !== "")
    .map((row) =>
      factory.create(LISTENER_TYPE[kind], {
        event: row.event,
        [row.implementationType]: row.value.trim(),
      }),
    );

  const values = [...others, ...listeners];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

/* ── Multi-instance ────────────────────────────────────────────────────────── */

export type MultiInstanceMode = "none" | "parallel" | "sequential";

export interface MultiInstanceConfig {
  mode: MultiInstanceMode;
  /** Expression naming the collection to iterate, e.g. `${approvers}`. */
  collection: string;
  /** Variable each element is bound to inside the loop. */
  elementVariable: string;
  /** Variable holding the zero-based iteration index. */
  elementIndexVariable: string;
  /** Fixed instance count, as an alternative to a collection. */
  cardinality: string;
  /** Expression that ends the loop early, e.g. `${nrOfCompletedInstances >= 2}`. */
  completionCondition: string;
  /** Collects a variable from each iteration into one result. */
  aggregation: AggregationConfig;
}

export const NO_MULTI_INSTANCE: MultiInstanceConfig = {
  mode: "none",
  collection: "",
  elementVariable: "",
  elementIndexVariable: "",
  cardinality: "",
  completionCondition: "",
  // Spelled out rather than referencing NO_AGGREGATION, which is declared further down
  // with the rest of the aggregation code.
  aggregation: { target: "", createOverviewVariable: false, storeAsTransientVariable: false, variables: [] },
};

function expressionBody(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return String((value as { body?: unknown }).body ?? "");
}

export function readMultiInstance(businessObject: BusinessObject): MultiInstanceConfig {
  const loop = businessObject.loopCharacteristics;
  if (!loop || loop.$type !== "bpmn:MultiInstanceLoopCharacteristics") return NO_MULTI_INSTANCE;

  return {
    // BPMN models this as a boolean; the UI offers it as a mode because "parallel" and
    // "sequential" are what a modeller is actually choosing between.
    mode: loop.isSequential === true ? "sequential" : "parallel",
    collection: String(loop.collection ?? ""),
    elementVariable: String(loop.elementVariable ?? ""),
    elementIndexVariable: String(loop.elementIndexVariable ?? ""),
    cardinality: expressionBody(loop.loopCardinality),
    completionCondition: expressionBody(loop.completionCondition),
    aggregation: readAggregation(loop),
  };
}

/** Returns `undefined` for mode `none`, which clears the loop characteristics. */
export function buildMultiInstance(
  factory: ModdleFactory,
  config: MultiInstanceConfig,
): ModdleElement | undefined {
  if (config.mode === "none") return undefined;

  const properties: Record<string, unknown> = { isSequential: config.mode === "sequential" };
  if (config.collection.trim()) properties.collection = config.collection.trim();
  if (config.elementVariable.trim()) properties.elementVariable = config.elementVariable.trim();
  if (config.elementIndexVariable.trim()) {
    properties.elementIndexVariable = config.elementIndexVariable.trim();
  }
  if (config.cardinality.trim()) {
    properties.loopCardinality = factory.create("bpmn:FormalExpression", {
      body: config.cardinality.trim(),
    });
  }
  if (config.completionCondition.trim()) {
    properties.completionCondition = factory.create("bpmn:FormalExpression", {
      body: config.completionCondition.trim(),
    });
  }
  const aggregation = buildAggregation(factory, config.aggregation);
  if (aggregation) properties.extensionElements = aggregation;

  return factory.create("bpmn:MultiInstanceLoopCharacteristics", properties);
}

/** Multi-instance applies to activities, not to events or gateways. */
export function supportsMultiInstance(type: string): boolean {
  return (
    type.endsWith("Task") ||
    type === "bpmn:SubProcess" ||
    type === "bpmn:CallActivity" ||
    type === "bpmn:Transaction"
  );
}

/* ── Timer event definitions ───────────────────────────────────────────────── */

export type TimerKind = "duration" | "date" | "cycle";

const TIMER_PROPERTY: Record<TimerKind, string> = {
  duration: "timeDuration",
  date: "timeDate",
  cycle: "timeCycle",
};

export interface TimerConfig {
  kind: TimerKind;
  /** ISO-8601 duration/date/repeating interval, or an expression producing one. */
  value: string;
}

export function readTimer(businessObject: BusinessObject): TimerConfig | null {
  const definition = (businessObject.eventDefinitions ?? []).find(
    (candidate) => candidate.$type === "bpmn:TimerEventDefinition",
  );
  if (!definition) return null;

  for (const kind of Object.keys(TIMER_PROPERTY) as TimerKind[]) {
    const value = definition[TIMER_PROPERTY[kind]];
    if (value) return { kind, value: expressionBody(value) };
  }
  // A timer with no expression yet — the element exists but is unconfigured.
  return { kind: "duration", value: "" };
}

/**
 * Rebuilds `eventDefinitions` with the timer's expression replaced.
 *
 * Only the chosen kind is written: a timer carrying both a duration and a cycle is
 * ambiguous, and the engine's behaviour on one is not worth guessing at.
 */
export function applyTimer(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  config: TimerConfig,
): ModdleElement[] {
  const definitions = businessObject.eventDefinitions ?? [];
  return definitions.map((definition) => {
    if (definition.$type !== "bpmn:TimerEventDefinition") return definition;

    const rebuilt: Record<string, unknown> = {};
    if (config.value.trim()) {
      rebuilt[TIMER_PROPERTY[config.kind]] = factory.create("bpmn:FormalExpression", {
        body: config.value.trim(),
      });
    }
    return factory.create("bpmn:TimerEventDefinition", rebuilt);
  });
}

/** True for a boundary event that can be made interrupting or not. */
export function isBoundaryEvent(type: string): boolean {
  return type === "bpmn:BoundaryEvent";
}

/** Elements that can carry execution listeners: flow nodes, sequence flows and the process. */
export function supportsExecutionListeners(type: string): boolean {
  if (type === "bpmn:Process" || type === "bpmn:SequenceFlow") return true;
  return (
    type.endsWith("Task") ||
    type.endsWith("Event") ||
    type.endsWith("Gateway") ||
    type === "bpmn:SubProcess" ||
    type === "bpmn:CallActivity" ||
    type === "bpmn:Transaction"
  );
}

/* ── Field injections ──────────────────────────────────────────────────────── */

/**
 * `<flowable:field>` entries inside `<extensionElements>`.
 *
 * This is the single most load-bearing extension in Flowable's BPMN: the entire service
 * task family is configured through it. An HTTP task's `requestUrl` and `requestMethod`,
 * a mail task's `to`/`subject`/`html`, a DMN task's `decisionTableReferenceKey` are all
 * fields — none of them are attributes. Without an editor for these, those task types can
 * be drawn and never made to do anything.
 */
export type FieldValueKind = "stringValue" | "expression" | "string";

export interface FieldRow {
  name: string;
  /**
   * `stringValue` and `expression` are attributes; `string` is a child element, which is
   * what Flowable's own tooling uses for multi-line bodies such as a mail task's HTML.
   */
  valueKind: FieldValueKind;
  value: string;
}

const FIELD_TYPE = "flowable:Field";
const FIELD_VALUE_KINDS: FieldValueKind[] = ["stringValue", "expression", "string"];

export function readFields(businessObject: BusinessObject): FieldRow[] {
  const values = businessObject.extensionElements?.values ?? [];
  return values
    .filter((value) => value.$type === FIELD_TYPE)
    .map((field) => {
      const valueKind =
        FIELD_VALUE_KINDS.find((candidate) => typeof field[candidate] === "string") ?? "stringValue";
      return {
        name: String(field.name ?? ""),
        valueKind,
        value: String(field[valueKind] ?? ""),
      };
    });
}

/**
 * Rebuilds `extensionElements` with the field list replaced, carrying every other
 * extension across untouched.
 *
 * A field with no name is dropped: the engine matches fields to delegate setters by name,
 * so an unnamed one is not merely useless but unresolvable.
 */
export function writeFields(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  rows: FieldRow[],
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((value) => value.$type !== FIELD_TYPE);

  const fields = rows
    .filter((row) => row.name.trim() !== "")
    .map((row) =>
      factory.create(FIELD_TYPE, {
        name: row.name.trim(),
        // Written verbatim, not trimmed: a mail body's leading whitespace is content.
        [row.valueKind]: row.value,
      }),
    );

  const values = [...others, ...fields];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

/** Field injection applies to the delegate-backed activities, not to events or gateways. */
export function supportsFields(type: string): boolean {
  return (
    type === "bpmn:ServiceTask" ||
    type === "bpmn:SendTask" ||
    type === "bpmn:BusinessRuleTask" ||
    type === "bpmn:ScriptTask"
  );
}

/* ── In/out variable mapping ───────────────────────────────────────────────── */

export type MappingKind = "in" | "out";

export interface MappingRow {
  /** A variable name, or an expression when `sourceIsExpression`. */
  source: string;
  sourceIsExpression: boolean;
  target: string;
}

const MAPPING_TYPE: Record<MappingKind, string> = {
  in: "flowable:In",
  out: "flowable:Out",
};

export function readMappings(businessObject: BusinessObject, kind: MappingKind): MappingRow[] {
  const values = businessObject.extensionElements?.values ?? [];
  return values
    .filter((value) => value.$type === MAPPING_TYPE[kind])
    .map((mapping) => {
      const sourceIsExpression = typeof mapping.sourceExpression === "string";
      return {
        source: String((sourceIsExpression ? mapping.sourceExpression : mapping.source) ?? ""),
        sourceIsExpression,
        target: String(mapping.target ?? ""),
      };
    });
}

/**
 * Rebuilds `extensionElements` with one direction's mappings replaced.
 *
 * Both a source and a target are required: a mapping missing either has nowhere to read
 * from or nowhere to write to, and the engine treats it as a configuration error rather
 * than ignoring it.
 */
export function writeMappings(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  kind: MappingKind,
  rows: MappingRow[],
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((value) => value.$type !== MAPPING_TYPE[kind]);

  const mappings = rows
    .filter((row) => row.source.trim() !== "" && row.target.trim() !== "")
    .map((row) =>
      factory.create(MAPPING_TYPE[kind], {
        [row.sourceIsExpression ? "sourceExpression" : "source"]: row.source.trim(),
        target: row.target.trim(),
      }),
    );

  const values = [...others, ...mappings];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

/** The activities that start something else and so can map variables across the boundary. */
export function supportsMappings(type: string): boolean {
  return type === "bpmn:CallActivity" || type === "bpmn:ServiceTask";
}

/* ── Documentation ─────────────────────────────────────────────────────────── */

/**
 * `<bpmn:documentation>` — standard BPMN, on every element, and named explicitly by
 * §7.4.2. Stored as a collection because the spec allows several; this reads and writes
 * the first, which is what every BPMN tool in practice does.
 */
export function readDocumentation(businessObject: BusinessObject): string {
  const entries = (businessObject.documentation as ModdleElement[] | undefined) ?? [];
  return String(entries[0]?.text ?? "");
}

/** Returns `undefined` for empty text, so no empty `<documentation/>` is written. */
export function buildDocumentation(
  factory: ModdleFactory,
  text: string,
): ModdleElement[] | undefined {
  if (text.trim() === "") return undefined;
  // Not trimmed: documentation is prose and its internal formatting is the author's.
  return [factory.create("bpmn:Documentation", { text })];
}

/**
 * A sequence-flow condition must be a real moddle FormalExpression.
 *
 * A plain `{ $type, body }` object has no `$descriptor`, and `saveXML` then throws
 * "Cannot read properties of undefined (reading 'isGeneric')" — which is how setting
 * an exclusive-gateway condition made Save fail.
 */
export function buildCondition(factory: ModdleFactory, value: string): ModdleElement | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return factory.create("bpmn:FormalExpression", { body: trimmed });
}

export function readCondition(businessObject: BusinessObject): string {
  const condition = businessObject.conditionExpression;
  if (!condition || typeof condition !== "object") return "";
  return String((condition as { body?: unknown }).body ?? "");
}

/* ── Script tasks ──────────────────────────────────────────────────────────── */

/**
 * A script task's body is a child element, not an attribute, so it cannot be set through
 * a plain property update — which is why script tasks could be drawn but never given a
 * script.
 */
export function readScript(businessObject: BusinessObject): string {
  return String(businessObject.script ?? "");
}

/* ── Non-timer event definitions ───────────────────────────────────────────── */

/**
 * The event definitions that reference a definitions-level declaration.
 *
 * Error, signal, message and escalation events all point at a root element rather than
 * carrying their configuration inline. Conditional events are the exception: they hold an
 * expression directly, like a timer.
 */
export type EventDefinitionKind = "error" | "signal" | "message" | "escalation" | "conditional";

const EVENT_DEFINITION_TYPE: Record<EventDefinitionKind, string> = {
  error: "bpmn:ErrorEventDefinition",
  signal: "bpmn:SignalEventDefinition",
  message: "bpmn:MessageEventDefinition",
  escalation: "bpmn:EscalationEventDefinition",
  conditional: "bpmn:ConditionalEventDefinition",
};

/** The `*Ref` property each definition uses to point at its root element. */
const EVENT_DEFINITION_REF: Record<EventDefinitionKind, string> = {
  error: "errorRef",
  signal: "signalRef",
  message: "messageRef",
  escalation: "escalationRef",
  conditional: "",
};

/** The root element type each reference points at, and the plural for `definitions`. */
export const EVENT_ROOT_TYPE: Record<string, string> = {
  error: "bpmn:Error",
  signal: "bpmn:Signal",
  message: "bpmn:Message",
  escalation: "bpmn:Escalation",
};

export function eventDefinitionKindOf(businessObject: BusinessObject): EventDefinitionKind | null {
  const definitions = businessObject.eventDefinitions ?? [];
  for (const kind of Object.keys(EVENT_DEFINITION_TYPE) as EventDefinitionKind[]) {
    if (definitions.some((definition) => definition.$type === EVENT_DEFINITION_TYPE[kind])) {
      return kind;
    }
  }
  return null;
}

/**
 * The id of the root element this event references, or "" when it references nothing yet.
 *
 * bpmn-moddle resolves `errorRef` and friends to the referenced object, not to its id, so
 * this reads through the object rather than expecting a string.
 */
export function readEventReference(
  businessObject: BusinessObject,
  kind: EventDefinitionKind,
): string {
  const definition = (businessObject.eventDefinitions ?? []).find(
    (candidate) => candidate.$type === EVENT_DEFINITION_TYPE[kind],
  );
  if (!definition) return "";
  const reference = definition[EVENT_DEFINITION_REF[kind]];
  if (!reference || typeof reference !== "object") return "";
  return String((reference as { id?: unknown }).id ?? "");
}

/** For a conditional event, the expression that makes it fire. */
export function readEventCondition(businessObject: BusinessObject): string {
  const definition = (businessObject.eventDefinitions ?? []).find(
    (candidate) => candidate.$type === EVENT_DEFINITION_TYPE.conditional,
  );
  return definition ? expressionBody(definition.condition) : "";
}

/**
 * Points an event definition at a root element, creating that root element when the id is
 * one the process does not declare yet.
 *
 * This is what makes error and signal events usable at all: they are meaningless without
 * a `<bpmn:error>` or `<bpmn:signal>` at definitions level, and nothing in the editor
 * could previously declare one. Returns both the rewritten definitions and any new root
 * element, which the caller adds to `bpmn:Definitions`.
 */
export function applyEventReference(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  kind: EventDefinitionKind,
  reference: string,
  existingRoots: ModdleElement[],
): { eventDefinitions: ModdleElement[]; created?: ModdleElement } {
  const trimmed = reference.trim();
  const rootType = EVENT_ROOT_TYPE[kind];
  let target: ModdleElement | undefined;
  let created: ModdleElement | undefined;

  if (trimmed !== "") {
    target = existingRoots.find(
      (root) => root.$type === rootType && String(root.id ?? "") === trimmed,
    );
    if (!target) {
      /*
       * Seeded from the id rather than left blank. For an error this matters beyond
       * convenience: the engine matches a thrown error to a catching boundary event on
       * `errorCode`, not on the element id, so an error root without one is declared but
       * uncatchable.
       */
      const properties: Record<string, unknown> = { id: trimmed, name: trimmed };
      if (kind === "error") properties.errorCode = trimmed;
      created = factory.create(rootType, properties);
      target = created;
    }
  }

  const eventDefinitions = (businessObject.eventDefinitions ?? []).map((definition) => {
    if (definition.$type !== EVENT_DEFINITION_TYPE[kind]) return definition;
    definition[EVENT_DEFINITION_REF[kind]] = target;
    return definition;
  });

  return { eventDefinitions, created };
}

/** Sets a conditional event's expression in place. */
export function applyEventCondition(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  expression: string,
): ModdleElement[] {
  return (businessObject.eventDefinitions ?? []).map((definition) => {
    if (definition.$type !== EVENT_DEFINITION_TYPE.conditional) return definition;
    definition.condition =
      expression.trim() === ""
        ? undefined
        : factory.create("bpmn:FormalExpression", { body: expression.trim() });
    return definition;
  });
}

/* ── Gateway default flow ──────────────────────────────────────────────────── */

/** Gateways that can nominate a default outgoing flow. Parallel gateways cannot. */
export function supportsDefaultFlow(type: string): boolean {
  return (
    type === "bpmn:ExclusiveGateway" ||
    type === "bpmn:InclusiveGateway" ||
    type === "bpmn:ComplexGateway"
  );
}

/** The id of the nominated default flow, or "" for none. */
export function readDefaultFlow(businessObject: BusinessObject): string {
  const flow = businessObject.default;
  if (!flow || typeof flow !== "object") return "";
  return String((flow as { id?: unknown }).id ?? "");
}

/* ── Form properties ───────────────────────────────────────────────────────── */

/**
 * `<flowable:formProperty>` — the engine's own form model, rendered by Work when a task
 * has no external form key.
 *
 * Declared in the moddle since the first version of this editor and never editable, so a
 * model carrying form properties kept them but nothing could author one.
 */
export const FORM_PROPERTY_TYPES = [
  "string",
  "long",
  "double",
  "boolean",
  "date",
  "enum",
] as const;

export interface FormPropertyRow {
  id: string;
  name: string;
  type: string;
  variable: string;
  expression: string;
  defaultValue: string;
  datePattern: string;
  required: boolean;
  readable: boolean;
  writable: boolean;
  /** Options, for `enum` properties only. */
  values: Array<{ id: string; name: string }>;
}

const FORM_PROPERTY_TYPE = "flowable:FormProperty";

export function readFormProperties(businessObject: BusinessObject): FormPropertyRow[] {
  const values = businessObject.extensionElements?.values ?? [];
  return values
    .filter((value) => value.$type === FORM_PROPERTY_TYPE)
    .map((property) => ({
      id: String(property.id ?? ""),
      name: String(property.name ?? ""),
      type: String(property.type ?? "string"),
      variable: String(property.variable ?? ""),
      expression: String(property.expression ?? ""),
      defaultValue: String(property.default ?? ""),
      datePattern: String(property.datePattern ?? ""),
      // Flowable's defaults: readable and writable unless said otherwise.
      required: property.required === true || property.required === "true",
      readable: property.readable !== false && property.readable !== "false",
      writable: property.writable !== false && property.writable !== "false",
      values: ((property.values as ModdleElement[] | undefined) ?? []).map((option) => ({
        id: String(option.id ?? ""),
        name: String(option.name ?? ""),
      })),
    }));
}

export function writeFormProperties(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  rows: FormPropertyRow[],
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((value) => value.$type !== FORM_PROPERTY_TYPE);

  const properties = rows
    // The id is what the variable is submitted under; without it there is nothing to bind.
    .filter((row) => row.id.trim() !== "")
    .map((row) => {
      const attributes: Record<string, unknown> = { id: row.id.trim(), type: row.type };
      if (row.name.trim()) attributes.name = row.name.trim();
      if (row.variable.trim()) attributes.variable = row.variable.trim();
      if (row.expression.trim()) attributes.expression = row.expression.trim();
      if (row.defaultValue.trim()) attributes.default = row.defaultValue.trim();
      if (row.datePattern.trim()) attributes.datePattern = row.datePattern.trim();
      if (row.required) attributes.required = true;
      // Only written when they differ from the engine's default, to keep the XML quiet.
      if (!row.readable) attributes.readable = false;
      if (!row.writable) attributes.writable = false;
      if (row.type === "enum" && row.values.length > 0) {
        attributes.values = row.values
          .filter((option) => option.id.trim() !== "")
          .map((option) =>
            factory.create("flowable:Value", {
              id: option.id.trim(),
              name: option.name.trim() || option.id.trim(),
            }),
          );
      }
      return factory.create(FORM_PROPERTY_TYPE, attributes);
    });

  const values = [...others, ...properties];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

/** Form properties belong to the things a person fills in: user tasks and start events. */
export function supportsFormProperties(type: string): boolean {
  return type === "bpmn:UserTask" || type === "bpmn:StartEvent";
}

/* ── Failed job retry cycle ────────────────────────────────────────────────── */

const RETRY_TYPE = "flowable:FailedJobRetryTimeCycle";

export function readRetryCycle(businessObject: BusinessObject): string {
  const values = businessObject.extensionElements?.values ?? [];
  const entry = values.find((value) => value.$type === RETRY_TYPE);
  return entry ? String(entry.value ?? "") : "";
}

/**
 * Sets the retry cycle, or removes it when cleared.
 *
 * Only meaningful on an async activity: the retry cycle governs the job the engine
 * creates, and a synchronous activity creates none.
 */
export function writeRetryCycle(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  cycle: string,
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((value) => value.$type !== RETRY_TYPE);
  const values =
    cycle.trim() === ""
      ? others
      : [...others, factory.create(RETRY_TYPE, { value: cycle.trim() })];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

/* ── Exception mapping ─────────────────────────────────────────────────────── */

export interface MapExceptionRow {
  /** Fully-qualified Java exception class. Empty means "any exception". */
  exceptionClass: string;
  /** The BPMN error code a boundary error event can then catch. Mandatory. */
  errorCode: string;
  includeChildExceptions: boolean;
  rootCause: string;
}

const MAP_EXCEPTION_TYPE = "flowable:MapException";

export function readMapExceptions(businessObject: BusinessObject): MapExceptionRow[] {
  const values = businessObject.extensionElements?.values ?? [];
  return values
    .filter((value) => value.$type === MAP_EXCEPTION_TYPE)
    .map((entry) => ({
      exceptionClass: String(entry.value ?? ""),
      errorCode: String(entry.errorCode ?? ""),
      includeChildExceptions:
        entry.includeChildExceptions === true || entry.includeChildExceptions === "true",
      rootCause: String(entry.rootCause ?? ""),
    }));
}

/**
 * Rebuilds the exception mappings.
 *
 * A row without an `errorCode` is dropped rather than written: the engine's parser
 * *throws* on a mapException missing one, which would make the entire model unreadable
 * rather than merely leaving one activity misconfigured.
 */
export function writeMapExceptions(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  rows: MapExceptionRow[],
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((value) => value.$type !== MAP_EXCEPTION_TYPE);

  const mappings = rows
    .filter((row) => row.errorCode.trim() !== "")
    .map((row) => {
      const attributes: Record<string, unknown> = { errorCode: row.errorCode.trim() };
      if (row.exceptionClass.trim()) attributes.value = row.exceptionClass.trim();
      if (row.includeChildExceptions) attributes.includeChildExceptions = true;
      if (row.rootCause.trim()) attributes.rootCause = row.rootCause.trim();
      return factory.create(MAP_EXCEPTION_TYPE, attributes);
    });

  const values = [...others, ...mappings];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

/** Exception mapping and retry cycles apply to activities, which are what create jobs. */
export function supportsJobSettings(type: string): boolean {
  return (
    type.endsWith("Task") ||
    type === "bpmn:SubProcess" ||
    type === "bpmn:CallActivity" ||
    type === "bpmn:Transaction"
  );
}

/* ── Process-level event listeners ─────────────────────────────────────────── */

/** The engine events a process can listen for. Not the same vocabulary as a listener on an element. */
export const ENGINE_EVENTS = [
  "JOB_EXECUTION_FAILURE",
  "JOB_EXECUTION_SUCCESS",
  "JOB_RETRIES_DECREMENTED",
  "TASK_CREATED",
  "TASK_COMPLETED",
  "TASK_ASSIGNED",
  "PROCESS_STARTED",
  "PROCESS_COMPLETED",
  "PROCESS_CANCELLED",
  "ENTITY_CREATED",
  "ENTITY_DELETED",
  "VARIABLE_CREATED",
  "VARIABLE_UPDATED",
] as const;

export interface EventListenerRow {
  /** Comma-separated engine event names; empty means every event. */
  events: string;
  implementationType: Exclude<ImplementationType, "expression">;
  value: string;
  /** Narrows ENTITY_* events to one entity, e.g. `job` or `task`. */
  entityType: string;
}

const EVENT_LISTENER_TYPE = "flowable:EventListener";

export function readEventListeners(businessObject: BusinessObject): EventListenerRow[] {
  const values = businessObject.extensionElements?.values ?? [];
  return values
    .filter((value) => value.$type === EVENT_LISTENER_TYPE)
    .map((listener) => ({
      events: String(listener.events ?? ""),
      implementationType: typeof listener.delegateExpression === "string" ? "delegateExpression" : "class",
      value: String(listener.delegateExpression ?? listener.class ?? ""),
      entityType: String(listener.entityType ?? ""),
    }));
}

export function writeEventListeners(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  rows: EventListenerRow[],
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((value) => value.$type !== EVENT_LISTENER_TYPE);

  const listeners = rows
    .filter((row) => row.value.trim() !== "")
    .map((row) => {
      const attributes: Record<string, unknown> = {
        [row.implementationType]: row.value.trim(),
      };
      // An empty `events` means "all events", which is expressed by omitting it.
      if (row.events.trim()) attributes.events = row.events.trim();
      if (row.entityType.trim()) attributes.entityType = row.entityType.trim();
      return factory.create(EVENT_LISTENER_TYPE, attributes);
    });

  const values = [...others, ...listeners];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

/* ── Data objects ──────────────────────────────────────────────────────────── */

/**
 * Process variables declared on the model itself (§7.4.2).
 *
 * The type lives in `itemSubjectRef` as an `xsd:`-prefixed name, and the default value is
 * a `<flowable:value>` inside the data object's extension elements — neither of which the
 * generic id/name fields could reach.
 */
export const DATA_OBJECT_TYPES = [
  "string",
  "int",
  "long",
  "double",
  "boolean",
  "datetime",
  "json",
] as const;

export function readDataObjectType(businessObject: BusinessObject): string {
  const reference = businessObject.itemSubjectRef;
  const raw =
    typeof reference === "object" && reference !== null
      ? String((reference as { structureRef?: unknown }).structureRef ?? "")
      : String(reference ?? "");
  const type = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : "";
  // The engine falls back to string for an absent or unrecognised type.
  return (DATA_OBJECT_TYPES as readonly string[]).includes(type) ? type : "string";
}

export function readDataObjectValue(businessObject: BusinessObject): string {
  const values = businessObject.extensionElements?.values ?? [];
  const entry = values.find((value) => value.$type === "flowable:Value");
  return entry ? String(entry.value ?? "") : "";
}

export function writeDataObjectValue(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  value: string,
): ModdleElement | undefined {
  const existing = businessObject.extensionElements?.values ?? [];
  const others = existing.filter((entry) => entry.$type !== "flowable:Value");
  const values =
    value.trim() === "" ? others : [...others, factory.create("flowable:Value", { value })];
  if (values.length === 0) return undefined;
  return factory.create("bpmn:ExtensionElements", { values });
}

export function isDataObject(type: string): boolean {
  return type === "bpmn:DataObject" || type === "bpmn:DataObjectReference";
}

/* ── Variable aggregation ──────────────────────────────────────────────────── */

export interface AggregationConfig {
  /** Variable the collected results are stored in. */
  target: string;
  createOverviewVariable: boolean;
  storeAsTransientVariable: boolean;
  /** Which variable to take from each iteration. Empty collects the whole scope. */
  variables: Array<{ source: string; target: string }>;
}

export const NO_AGGREGATION: AggregationConfig = {
  target: "",
  createOverviewVariable: false,
  storeAsTransientVariable: false,
  variables: [],
};

export function readAggregation(loop: ModdleElement | null | undefined): AggregationConfig {
  const entries = (loop?.extensionElements as { values?: ModdleElement[] } | undefined)?.values ?? [];
  const aggregation = entries.find((entry) => entry.$type === "flowable:VariableAggregation");
  if (!aggregation) return NO_AGGREGATION;
  return {
    target: String(aggregation.target ?? ""),
    createOverviewVariable: aggregation.createOverviewVariable === true,
    storeAsTransientVariable: aggregation.storeAsTransientVariable === true,
    variables: ((aggregation.definitions as ModdleElement[] | undefined) ?? []).map((variable) => ({
      source: String(variable.source ?? ""),
      target: String(variable.target ?? ""),
    })),
  };
}

/**
 * Builds the aggregation's extension elements.
 *
 * Sits inside the loop characteristics rather than on the activity, which is why it is
 * built as part of the multi-instance configuration rather than as its own section.
 */
export function buildAggregation(
  factory: ModdleFactory,
  config: AggregationConfig,
): ModdleElement | undefined {
  if (config.target.trim() === "") return undefined;

  const attributes: Record<string, unknown> = { target: config.target.trim() };
  if (config.createOverviewVariable) attributes.createOverviewVariable = true;
  if (config.storeAsTransientVariable) attributes.storeAsTransientVariable = true;

  const definitions = config.variables
    .filter((variable) => variable.source.trim() !== "")
    .map((variable) =>
      factory.create("flowable:Variable", {
        source: variable.source.trim(),
        target: variable.target.trim() || variable.source.trim(),
      }),
    );
  if (definitions.length > 0) attributes.definitions = definitions;

  return factory.create("bpmn:ExtensionElements", {
    values: [factory.create("flowable:VariableAggregation", attributes)],
  });
}

/** Compensation applies to activities that can be undone. */
export function supportsCompensation(type: string): boolean {
  return (
    type.endsWith("Task") ||
    type === "bpmn:SubProcess" ||
    type === "bpmn:CallActivity" ||
    type === "bpmn:Transaction"
  );
}

/* ── Named single fields ───────────────────────────────────────────────────── */

/**
 * The field a DMN decision task carries its decision key in.
 *
 * A decision task is a `bpmn:ServiceTask` with `flowable:type="dmn"`, and the decision it
 * evaluates is a field injection under this exact name. Knowing that is not reasonable to
 * expect of someone modelling, so the panel offers it as a labelled control — and this
 * constant is why the control and the generic field editor stay in agreement.
 */
export const DECISION_KEY_FIELD = "decisionTableReferenceKey";

/** Reads one named field injection, or "" when it is absent. */
export function readNamedField(businessObject: BusinessObject, name: string): string {
  const field = readFields(businessObject).find((entry) => entry.name === name);
  return field?.value ?? "";
}

/**
 * Sets one named field injection, leaving every other field alone.
 *
 * Built on `readFields`/`writeFields` rather than touching extension elements directly, so
 * a value set here is the same object the field editor below shows — edit it in either
 * place and the other reflects it.
 */
export function writeNamedField(
  factory: ModdleFactory,
  businessObject: BusinessObject,
  name: string,
  value: string,
): ModdleElement | undefined {
  const rows = readFields(businessObject).filter((entry) => entry.name !== name);
  const next =
    value.trim() === ""
      ? rows
      : [...rows, { name, valueKind: "stringValue" as FieldValueKind, value: value.trim() }];
  return writeFields(factory, businessObject, next);
}
