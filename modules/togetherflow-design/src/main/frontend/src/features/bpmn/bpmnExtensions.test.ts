/**
 * The nested parts of a Flowable BPMN model (REQUIREMENTS.md §7.4.2).
 *
 * The failure worth guarding hardest against is silent loss: a model that round-trips
 * through this editor must come back carrying everything it arrived with, including the
 * extension elements this panel does not itself understand. That is the same class of
 * bug the moddle descriptor exists to prevent, one level further in.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DECISION_KEY_FIELD,
  NO_AGGREGATION,
  NO_MULTI_INSTANCE,
  applyEventCondition,
  applyEventReference,
  applyTimer,
  buildCondition,
  buildDocumentation,
  buildMultiInstance,
  eventDefinitionKindOf,
  isBoundaryEvent,
  readCondition,
  readDataObjectType,
  readDataObjectValue,
  readDefaultFlow,
  readDocumentation,
  readEventCondition,
  readEventListeners,
  readEventReference,
  readFields,
  readFormProperties,
  readListeners,
  readMapExceptions,
  readMappings,
  readMultiInstance,
  readNamedField,
  readRetryCycle,
  readScript,
  readTimer,
  supportsDefaultFlow,
  supportsExecutionListeners,
  supportsFields,
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
  type ModdleElement,
  type ModdleFactory,
} from "./bpmnExtensions";

/** Stands in for bpmn-js's moddle: records the type and returns a plain object. */
function fakeFactory(): ModdleFactory & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(
    (type: string, properties: Record<string, unknown> = {}): ModdleElement => ({
      $type: type,
      ...properties,
    }),
  );
  return { create };
}

function listener(type: string, props: Record<string, unknown>): ModdleElement {
  return { $type: type, ...props };
}

describe("listeners", () => {
  it("reads execution listeners and the implementation each one uses", () => {
    const bo = {
      $type: "bpmn:UserTask",
      extensionElements: {
        values: [
          listener("flowable:ExecutionListener", { event: "start", class: "com.acme.OnStart" }),
          listener("flowable:ExecutionListener", {
            event: "end",
            delegateExpression: "${auditor}",
          }),
        ],
      },
    };
    expect(readListeners(bo, "execution")).toEqual([
      { event: "start", implementationType: "class", value: "com.acme.OnStart" },
      { event: "end", implementationType: "delegateExpression", value: "${auditor}" },
    ]);
  });

  it("keeps the two listener kinds apart", () => {
    const bo = {
      $type: "bpmn:UserTask",
      extensionElements: {
        values: [
          listener("flowable:ExecutionListener", { event: "start", class: "A" }),
          listener("flowable:TaskListener", { event: "create", class: "B" }),
        ],
      },
    };
    expect(readListeners(bo, "execution")).toHaveLength(1);
    expect(readListeners(bo, "task")).toEqual([
      { event: "create", implementationType: "class", value: "B" },
    ]);
  });

  it("reads a listener with no implementation without dropping it", () => {
    const bo = {
      $type: "bpmn:UserTask",
      extensionElements: { values: [listener("flowable:ExecutionListener", { event: "start" })] },
    };
    expect(readListeners(bo, "execution")).toEqual([
      { event: "start", implementationType: "class", value: "" },
    ]);
  });

  it("returns nothing for an element with no extension elements", () => {
    expect(readListeners({ $type: "bpmn:Task" }, "execution")).toEqual([]);
  });

  it("preserves extension elements it does not understand", () => {
    const factory = fakeFactory();
    const formProperty = listener("flowable:FormProperty", { id: "amount" });
    const bo = {
      $type: "bpmn:UserTask",
      extensionElements: {
        values: [formProperty, listener("flowable:ExecutionListener", { event: "start", class: "A" })],
      },
    };

    const result = writeListeners(factory, bo, "execution", [
      { event: "end", implementationType: "expression", value: "${done}" },
    ]);

    const values = result?.values as ModdleElement[];
    // The form property survives; only the execution listener was replaced.
    expect(values[0]).toBe(formProperty);
    expect(values[1]).toMatchObject({
      $type: "flowable:ExecutionListener",
      event: "end",
      expression: "${done}",
    });
  });

  it("preserves the other listener kind when rewriting one of them", () => {
    const factory = fakeFactory();
    const taskListener = listener("flowable:TaskListener", { event: "create", class: "B" });
    const bo = { $type: "bpmn:UserTask", extensionElements: { values: [taskListener] } };

    const result = writeListeners(factory, bo, "execution", [
      { event: "start", implementationType: "class", value: "A" },
    ]);

    expect((result?.values as ModdleElement[])).toContain(taskListener);
  });

  it("drops a row with no implementation — the engine cannot run it", () => {
    const factory = fakeFactory();
    const result = writeListeners(factory, { $type: "bpmn:Task" }, "execution", [
      { event: "start", implementationType: "class", value: "   " },
    ]);
    expect(result).toBeUndefined();
  });

  it("returns undefined rather than an empty extensionElements element", () => {
    const factory = fakeFactory();
    expect(writeListeners(factory, { $type: "bpmn:Task" }, "execution", [])).toBeUndefined();
  });
});

describe("multi-instance", () => {
  it("reports none for an element with no loop characteristics", () => {
    expect(readMultiInstance({ $type: "bpmn:UserTask" }).mode).toBe("none");
  });

  it("reads a parallel loop with its collection and element variable", () => {
    const bo = {
      $type: "bpmn:UserTask",
      loopCharacteristics: {
        $type: "bpmn:MultiInstanceLoopCharacteristics",
        isSequential: false,
        collection: "${approvers}",
        elementVariable: "approver",
        completionCondition: { $type: "bpmn:FormalExpression", body: "${nrOfCompletedInstances >= 2}" },
      },
    };
    expect(readMultiInstance(bo)).toEqual({
      mode: "parallel",
      elementIndexVariable: "",
      aggregation: NO_AGGREGATION,
      collection: "${approvers}",
      elementVariable: "approver",
      cardinality: "",
      completionCondition: "${nrOfCompletedInstances >= 2}",
    });
  });

  it("reads a sequential loop", () => {
    const bo = {
      $type: "bpmn:UserTask",
      loopCharacteristics: {
        $type: "bpmn:MultiInstanceLoopCharacteristics",
        isSequential: true,
      },
    };
    expect(readMultiInstance(bo).mode).toBe("sequential");
  });

  it("ignores a standard loop, which is not multi-instance", () => {
    const bo = {
      $type: "bpmn:UserTask",
      loopCharacteristics: { $type: "bpmn:StandardLoopCharacteristics" },
    };
    expect(readMultiInstance(bo).mode).toBe("none");
  });

  it("builds a sequential loop with an expression cardinality", () => {
    const factory = fakeFactory();
    const built = buildMultiInstance(factory, {
      mode: "sequential",
      elementIndexVariable: "",
      aggregation: NO_AGGREGATION,
      collection: "",
      elementVariable: "",
      cardinality: "3",
      completionCondition: "",
    });
    expect(built).toMatchObject({
      $type: "bpmn:MultiInstanceLoopCharacteristics",
      isSequential: true,
      loopCardinality: { $type: "bpmn:FormalExpression", body: "3" },
    });
  });

  it("omits blank fields rather than writing empty attributes", () => {
    const factory = fakeFactory();
    const built = buildMultiInstance(factory, {
      mode: "parallel",
      elementIndexVariable: "",
      aggregation: NO_AGGREGATION,
      collection: "  ",
      elementVariable: "",
      cardinality: "",
      completionCondition: "",
    });
    expect(built).toEqual({ $type: "bpmn:MultiInstanceLoopCharacteristics", isSequential: false });
  });

  it("clears the loop when the mode is none", () => {
    const factory = fakeFactory();
    expect(
      buildMultiInstance(factory, {
        mode: "none",
      elementIndexVariable: "",
      aggregation: NO_AGGREGATION,
        collection: "${x}",
        elementVariable: "y",
        cardinality: "",
        completionCondition: "",
      }),
    ).toBeUndefined();
  });

  it("applies to activities but not to events or gateways", () => {
    expect(supportsMultiInstance("bpmn:UserTask")).toBe(true);
    expect(supportsMultiInstance("bpmn:SubProcess")).toBe(true);
    expect(supportsMultiInstance("bpmn:CallActivity")).toBe(true);
    expect(supportsMultiInstance("bpmn:StartEvent")).toBe(false);
    expect(supportsMultiInstance("bpmn:ExclusiveGateway")).toBe(false);
  });
});

describe("timer event definitions", () => {
  it("reads whichever timer expression is set", () => {
    const bo = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [
        {
          $type: "bpmn:TimerEventDefinition",
          timeCycle: { $type: "bpmn:FormalExpression", body: "R3/PT10M" },
        },
      ],
    };
    expect(readTimer(bo)).toEqual({ kind: "cycle", value: "R3/PT10M" });
  });

  it("reports an unconfigured timer rather than nothing", () => {
    const bo = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [{ $type: "bpmn:TimerEventDefinition" }],
    };
    expect(readTimer(bo)).toEqual({ kind: "duration", value: "" });
  });

  it("returns null for an event that is not a timer", () => {
    const bo = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [{ $type: "bpmn:ErrorEventDefinition" }],
    };
    expect(readTimer(bo)).toBeNull();
  });

  it("writes only the chosen kind, so a timer is never ambiguous", () => {
    const factory = fakeFactory();
    const bo = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [
        {
          $type: "bpmn:TimerEventDefinition",
          timeDuration: { $type: "bpmn:FormalExpression", body: "PT1H" },
        },
      ],
    };

    const [definition] = applyTimer(factory, bo, { kind: "date", value: "2026-12-24T09:00:00" });

    expect(definition).toEqual({
      $type: "bpmn:TimerEventDefinition",
      timeDate: { $type: "bpmn:FormalExpression", body: "2026-12-24T09:00:00" },
    });
    expect(definition.timeDuration).toBeUndefined();
  });

  it("leaves other event definitions alone", () => {
    const factory = fakeFactory();
    const error = { $type: "bpmn:ErrorEventDefinition" };
    const bo = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [error, { $type: "bpmn:TimerEventDefinition" }],
    };
    expect(applyTimer(factory, bo, { kind: "duration", value: "PT5M" })[0]).toBe(error);
  });
});

describe("element capability checks", () => {
  it("recognises a boundary event", () => {
    expect(isBoundaryEvent("bpmn:BoundaryEvent")).toBe(true);
    expect(isBoundaryEvent("bpmn:IntermediateCatchEvent")).toBe(false);
  });

  it("allows execution listeners on flow nodes, sequence flows and the process", () => {
    expect(supportsExecutionListeners("bpmn:Process")).toBe(true);
    expect(supportsExecutionListeners("bpmn:SequenceFlow")).toBe(true);
    expect(supportsExecutionListeners("bpmn:ServiceTask")).toBe(true);
    expect(supportsExecutionListeners("bpmn:ExclusiveGateway")).toBe(true);
    expect(supportsExecutionListeners("bpmn:StartEvent")).toBe(true);
    // Not a flow node — a lane carries no behaviour to listen to.
    expect(supportsExecutionListeners("bpmn:Lane")).toBe(false);
  });
});

/* ── Field injections ──────────────────────────────────────────────────────── */

describe("field injections", () => {
  it("reads a field's value from whichever form it was written in", () => {
    const business = {
      $type: "bpmn:ServiceTask",
      extensionElements: {
        values: [
          { $type: "flowable:Field", name: "requestUrl", stringValue: "https://example.test" },
          { $type: "flowable:Field", name: "requestMethod", expression: "${method}" },
          { $type: "flowable:Field", name: "html", string: "<p>Hello</p>" },
        ],
      },
    };

    expect(readFields(business)).toEqual([
      { name: "requestUrl", valueKind: "stringValue", value: "https://example.test" },
      { name: "requestMethod", valueKind: "expression", value: "${method}" },
      { name: "html", valueKind: "string", value: "<p>Hello</p>" },
    ]);
  });

  it("keeps other extension elements when the fields change", () => {
    const factory = fakeFactory();
    const business = {
      $type: "bpmn:ServiceTask",
      extensionElements: {
        values: [
          { $type: "flowable:ExecutionListener", event: "start", class: "com.acme.Audit" },
          { $type: "flowable:Field", name: "old", stringValue: "value" },
        ],
      },
    };

    const result = writeFields(factory, business, [
      { name: "requestUrl", valueKind: "stringValue", value: "https://example.test" },
    ]);

    const values = result?.values as ModdleElement[];
    // The listener survives; only the fields were replaced.
    expect(values.map((value) => value.$type)).toEqual([
      "flowable:ExecutionListener",
      "flowable:Field",
    ]);
    expect(values[1]).toMatchObject({ name: "requestUrl", stringValue: "https://example.test" });
  });

  it("drops a field with no name, which the engine could never resolve", () => {
    const factory = fakeFactory();
    const business = { $type: "bpmn:ServiceTask" };

    const result = writeFields(factory, business, [
      { name: "  ", valueKind: "stringValue", value: "orphan" },
    ]);

    expect(result).toBeUndefined();
  });

  it("preserves a field value verbatim, because a mail body's whitespace is content", () => {
    const factory = fakeFactory();
    const result = writeFields({ ...factory }, { $type: "bpmn:ServiceTask" }, [
      { name: "html", valueKind: "string", value: "  <p>indented</p>\n" },
    ]);

    expect((result?.values as ModdleElement[])[0].string).toBe("  <p>indented</p>\n");
  });

  it("offers fields on the delegate-backed activities only", () => {
    expect(supportsFields("bpmn:ServiceTask")).toBe(true);
    expect(supportsFields("bpmn:BusinessRuleTask")).toBe(true);
    expect(supportsFields("bpmn:UserTask")).toBe(false);
    expect(supportsFields("bpmn:ExclusiveGateway")).toBe(false);
  });
});

/* ── Variable mapping ──────────────────────────────────────────────────────── */

describe("in/out variable mapping", () => {
  it("distinguishes a plain source from an expression", () => {
    const business = {
      $type: "bpmn:CallActivity",
      extensionElements: {
        values: [
          { $type: "flowable:In", source: "customer", target: "client" },
          { $type: "flowable:In", sourceExpression: "${total * 2}", target: "doubled" },
          { $type: "flowable:Out", source: "result", target: "outcome" },
        ],
      },
    };

    expect(readMappings(business, "in")).toEqual([
      { source: "customer", sourceIsExpression: false, target: "client" },
      { source: "${total * 2}", sourceIsExpression: true, target: "doubled" },
    ]);
    expect(readMappings(business, "out")).toEqual([
      { source: "result", sourceIsExpression: false, target: "outcome" },
    ]);
  });

  it("rewrites one direction without disturbing the other", () => {
    const factory = fakeFactory();
    const business = {
      $type: "bpmn:CallActivity",
      extensionElements: {
        values: [
          { $type: "flowable:In", source: "a", target: "b" },
          { $type: "flowable:Out", source: "c", target: "d" },
        ],
      },
    };

    const result = writeMappings(factory, business, "in", [
      { source: "x", sourceIsExpression: false, target: "y" },
    ]);

    const values = result?.values as ModdleElement[];
    expect(values.filter((value) => value.$type === "flowable:Out")).toHaveLength(1);
    expect(values.filter((value) => value.$type === "flowable:In")).toEqual([
      { $type: "flowable:In", source: "x", target: "y" },
    ]);
  });

  it("drops a half-built mapping, which has nowhere to read from or write to", () => {
    const factory = fakeFactory();
    const result = writeMappings(factory, { $type: "bpmn:CallActivity" }, "in", [
      { source: "onlySource", sourceIsExpression: false, target: "" },
      { source: "", sourceIsExpression: false, target: "onlyTarget" },
    ]);

    expect(result).toBeUndefined();
  });
});

/* ── Documentation ─────────────────────────────────────────────────────────── */

describe("documentation", () => {
  it("round-trips the first documentation entry", () => {
    const factory = fakeFactory();
    const built = buildDocumentation(factory, "Refunds over 10k need a second approver.");
    expect(readDocumentation({ $type: "bpmn:UserTask", documentation: built })).toBe(
      "Refunds over 10k need a second approver.",
    );
  });

  it("writes nothing for empty text rather than an empty element", () => {
    expect(buildDocumentation(fakeFactory(), "   ")).toBeUndefined();
  });

  it("is empty for an element that has none", () => {
    expect(readDocumentation({ $type: "bpmn:Task" })).toBe("");
  });
});

describe("sequence-flow conditions", () => {
  it("creates a moddle FormalExpression, not a bare $type object", () => {
    const factory = fakeFactory();
    const built = buildCondition(factory, " ${aseApproved == 'true'} ");
    expect(factory.create).toHaveBeenCalledWith("bpmn:FormalExpression", {
      body: "${aseApproved == 'true'}",
    });
    expect(built).toEqual({ $type: "bpmn:FormalExpression", body: "${aseApproved == 'true'}" });
    expect(readCondition({ $type: "bpmn:SequenceFlow", conditionExpression: built })).toBe(
      "${aseApproved == 'true'}",
    );
  });

  it("writes nothing for a blank condition rather than an empty expression", () => {
    expect(buildCondition(fakeFactory(), "   ")).toBeUndefined();
  });
});

/* ── Event definitions ─────────────────────────────────────────────────────── */

describe("event definitions", () => {
  it("identifies which kind of event definition an element carries", () => {
    expect(
      eventDefinitionKindOf({
        $type: "bpmn:BoundaryEvent",
        eventDefinitions: [{ $type: "bpmn:ErrorEventDefinition" }],
      }),
    ).toBe("error");
    expect(
      eventDefinitionKindOf({
        $type: "bpmn:StartEvent",
        eventDefinitions: [{ $type: "bpmn:SignalEventDefinition" }],
      }),
    ).toBe("signal");
    // A plain start event has nothing to configure.
    expect(eventDefinitionKindOf({ $type: "bpmn:StartEvent" })).toBeNull();
  });

  it("declares a root element when the reference names one that does not exist", () => {
    const factory = fakeFactory();
    const business = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [{ $type: "bpmn:ErrorEventDefinition" }],
    };

    const { eventDefinitions, created } = applyEventReference(
      factory,
      business,
      "error",
      "PAYMENT_DECLINED",
      [],
    );

    /*
     * errorCode, not just name: the engine matches a thrown error to a catching boundary
     * event on the code. An error root without one is declared but uncatchable.
     */
    expect(created).toMatchObject({
      $type: "bpmn:Error",
      id: "PAYMENT_DECLINED",
      errorCode: "PAYMENT_DECLINED",
    });
    expect(eventDefinitions[0].errorRef).toBe(created);
  });

  it("reuses an existing declaration rather than creating a duplicate", () => {
    const factory = fakeFactory();
    const existing: ModdleElement = {
      $type: "bpmn:Signal",
      id: "orderCancelled",
      name: "orderCancelled",
    };
    const business = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [{ $type: "bpmn:SignalEventDefinition" }],
    };

    const { eventDefinitions, created } = applyEventReference(
      factory,
      business,
      "signal",
      "orderCancelled",
      [existing],
    );

    expect(created).toBeUndefined();
    expect(eventDefinitions[0].signalRef).toBe(existing);
  });

  it("reads a reference back through the referenced object, not as a string", () => {
    // bpmn-moddle resolves errorRef to the object; reading it as a string yields "[object Object]".
    const business = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [
        { $type: "bpmn:ErrorEventDefinition", errorRef: { $type: "bpmn:Error", id: "BOOM" } },
      ],
    };
    expect(readEventReference(business, "error")).toBe("BOOM");
  });

  it("sets and clears a conditional event's expression", () => {
    const factory = fakeFactory();
    const business = {
      $type: "bpmn:BoundaryEvent",
      eventDefinitions: [{ $type: "bpmn:ConditionalEventDefinition" }],
    };

    const set = applyEventCondition(factory, business, "${amount > 10000}");
    expect(readEventCondition({ ...business, eventDefinitions: set })).toBe("${amount > 10000}");

    const cleared = applyEventCondition(factory, business, "  ");
    expect(cleared[0].condition).toBeUndefined();
  });
});

/* ── Gateway default flow ──────────────────────────────────────────────────── */

describe("gateway default flow", () => {
  it("is offered only where the engine honours it", () => {
    expect(supportsDefaultFlow("bpmn:ExclusiveGateway")).toBe(true);
    expect(supportsDefaultFlow("bpmn:InclusiveGateway")).toBe(true);
    // A parallel gateway takes every outgoing flow, so a default would mean nothing.
    expect(supportsDefaultFlow("bpmn:ParallelGateway")).toBe(false);
  });

  it("reads the referenced flow's id, since `default` is a reference", () => {
    expect(
      readDefaultFlow({
        $type: "bpmn:ExclusiveGateway",
        default: { $type: "bpmn:SequenceFlow", id: "Flow_reject" },
      }),
    ).toBe("Flow_reject");
    expect(readDefaultFlow({ $type: "bpmn:ExclusiveGateway" })).toBe("");
  });
});

/* ── Script tasks ──────────────────────────────────────────────────────────── */

describe("script tasks", () => {
  it("reads the script body", () => {
    expect(readScript({ $type: "bpmn:ScriptTask", script: "total = 1;" })).toBe("total = 1;");
    expect(readScript({ $type: "bpmn:ScriptTask" })).toBe("");
  });
});

/* ── Form properties ───────────────────────────────────────────────────────── */

describe("form properties", () => {
  it("applies the engine's defaults when reading, rather than assuming false", () => {
    const rows = readFormProperties({
      $type: "bpmn:UserTask",
      extensionElements: {
        values: [{ $type: "flowable:FormProperty", id: "amount", type: "long" }],
      },
    });
    // Flowable treats an absent readable/writable as true; reading them as false would
    // make an existing form read-only the moment it was edited here.
    expect(rows[0]).toMatchObject({ readable: true, writable: true, required: false });
  });

  it("writes only what differs from the engine's defaults", () => {
    const factory = fakeFactory();
    const result = writeFormProperties(factory, { $type: "bpmn:UserTask" }, [
      {
        id: "amount",
        name: "Amount",
        type: "long",
        variable: "",
        expression: "",
        defaultValue: "",
        datePattern: "",
        required: true,
        readable: true,
        writable: true,
        values: [],
      },
    ]);

    const property = (result?.values as ModdleElement[])[0];
    expect(property).toMatchObject({ id: "amount", name: "Amount", type: "long", required: true });
    expect(property.readable).toBeUndefined();
    expect(property.writable).toBeUndefined();
  });

  it("carries enum options, and only for enum properties", () => {
    const factory = fakeFactory();
    const base = {
      id: "choice",
      name: "",
      variable: "",
      expression: "",
      defaultValue: "",
      datePattern: "",
      required: false,
      readable: true,
      writable: true,
      values: [
        { id: "yes", name: "Yes" },
        { id: "no", name: "" },
      ],
    };

    const asEnum = writeFormProperties(factory, { $type: "bpmn:UserTask" }, [
      { ...base, type: "enum" },
    ]);
    const options = (asEnum?.values as ModdleElement[])[0].values as ModdleElement[];
    // A blank label falls back to the id, so an option is never rendered nameless.
    expect(options).toEqual([
      { $type: "flowable:Value", id: "yes", name: "Yes" },
      { $type: "flowable:Value", id: "no", name: "no" },
    ]);

    const asString = writeFormProperties(factory, { $type: "bpmn:UserTask" }, [
      { ...base, type: "string" },
    ]);
    expect((asString?.values as ModdleElement[])[0].values).toBeUndefined();
  });

  it("drops a property with no id, which nothing could bind to", () => {
    const factory = fakeFactory();
    expect(
      writeFormProperties(factory, { $type: "bpmn:UserTask" }, [
        {
          id: "  ",
          name: "Orphan",
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
      ]),
    ).toBeUndefined();
  });
});

/* ── Job settings ──────────────────────────────────────────────────────────── */

describe("job settings", () => {
  it("round-trips a retry cycle and clears it when emptied", () => {
    const factory = fakeFactory();
    const business = { $type: "bpmn:ServiceTask" };
    const written = writeRetryCycle(factory, business, "R3/PT10M");
    const withCycle = { ...business, extensionElements: { values: written?.values as ModdleElement[] } };
    expect(readRetryCycle(withCycle)).toBe("R3/PT10M");

    const cleared = writeRetryCycle(factory, withCycle, "  ");
    expect(cleared).toBeUndefined();
  });

  it("refuses to write an exception mapping without an error code", () => {
    const factory = fakeFactory();
    /*
     * Not merely useless: the engine's parser throws on a mapException with no errorCode,
     * which makes the whole model unreadable rather than one activity misconfigured.
     */
    expect(
      writeMapExceptions(factory, { $type: "bpmn:ServiceTask" }, [
        { exceptionClass: "java.io.IOException", errorCode: "", includeChildExceptions: true, rootCause: "" },
      ]),
    ).toBeUndefined();
  });

  it("writes the exception class as the element's text, not an attribute", () => {
    const factory = fakeFactory();
    const result = writeMapExceptions(factory, { $type: "bpmn:ServiceTask" }, [
      {
        exceptionClass: "java.io.IOException",
        errorCode: "IO_FAILED",
        includeChildExceptions: true,
        rootCause: "",
      },
    ]);
    expect((result?.values as ModdleElement[])[0]).toEqual({
      $type: "flowable:MapException",
      errorCode: "IO_FAILED",
      value: "java.io.IOException",
      includeChildExceptions: true,
    });
  });

  it("keeps the retry cycle when the exception mappings change", () => {
    const factory = fakeFactory();
    const business = {
      $type: "bpmn:ServiceTask",
      extensionElements: {
        values: [{ $type: "flowable:FailedJobRetryTimeCycle", value: "R3/PT10M" }],
      },
    };
    const result = writeMapExceptions(factory, business, [
      { exceptionClass: "", errorCode: "BOOM", includeChildExceptions: false, rootCause: "" },
    ]);
    const rebuilt = { ...business, extensionElements: { values: result?.values as ModdleElement[] } };
    expect(readRetryCycle(rebuilt)).toBe("R3/PT10M");
    expect(readMapExceptions(rebuilt)).toHaveLength(1);
  });
});

/* ── Engine event listeners ────────────────────────────────────────────────── */

describe("engine event listeners", () => {
  it("omits the events attribute entirely for an all-events listener", () => {
    const factory = fakeFactory();
    const result = writeEventListeners(factory, { $type: "bpmn:Process" }, [
      { events: "  ", implementationType: "class", value: "com.acme.Audit", entityType: "" },
    ]);
    const listener = (result?.values as ModdleElement[])[0];
    // Flowable reads an absent `events` as "every event"; an empty string is not the same.
    expect(listener.events).toBeUndefined();
    expect(listener.class).toBe("com.acme.Audit");
  });

  it("reads back whichever implementation was used", () => {
    expect(
      readEventListeners({
        $type: "bpmn:Process",
        extensionElements: {
          values: [
            { $type: "flowable:EventListener", events: "TASK_CREATED", delegateExpression: "${bean}" },
          ],
        },
      }),
    ).toEqual([
      {
        events: "TASK_CREATED",
        implementationType: "delegateExpression",
        value: "${bean}",
        entityType: "",
      },
    ]);
  });
});

/* ── Data objects ──────────────────────────────────────────────────────────── */

describe("data objects", () => {
  it("reads the type out of the itemSubjectRef prefix", () => {
    expect(
      readDataObjectType({
        $type: "bpmn:DataObject",
        itemSubjectRef: { $type: "bpmn:ItemDefinition", structureRef: "xsd:long" },
      }),
    ).toBe("long");
  });

  it("falls back to string for an absent or unrecognised type, as the engine does", () => {
    expect(readDataObjectType({ $type: "bpmn:DataObject" })).toBe("string");
    expect(
      readDataObjectType({
        $type: "bpmn:DataObject",
        itemSubjectRef: { structureRef: "xsd:nonsense" },
      }),
    ).toBe("string");
  });

  it("round-trips the default value", () => {
    const factory = fakeFactory();
    const business = { $type: "bpmn:DataObject" };
    const written = writeDataObjectValue(factory, business, "100");
    expect(
      readDataObjectValue({
        ...business,
        extensionElements: { values: written?.values as ModdleElement[] },
      }),
    ).toBe("100");
  });
});

/* ── Variable aggregation ──────────────────────────────────────────────────── */

describe("variable aggregation", () => {
  it("is written inside the loop characteristics, not on the activity", () => {
    const factory = fakeFactory();
    const loop = buildMultiInstance(factory, {
      mode: "parallel",
      collection: "${reviewers}",
      elementVariable: "reviewer",
      elementIndexVariable: "loopIndex",
      cardinality: "",
      completionCondition: "",
      aggregation: {
        target: "reviews",
        createOverviewVariable: true,
        storeAsTransientVariable: false,
        variables: [{ source: "score", target: "score" }],
      },
    });

    expect(loop?.elementIndexVariable).toBe("loopIndex");
    const aggregation = (loop?.extensionElements as ModdleElement).values as ModdleElement[];
    expect(aggregation[0]).toMatchObject({
      $type: "flowable:VariableAggregation",
      target: "reviews",
      createOverviewVariable: true,
    });
    expect(aggregation[0].definitions).toEqual([
      { $type: "flowable:Variable", source: "score", target: "score" },
    ]);
  });

  it("writes no aggregation when no target is named", () => {
    const factory = fakeFactory();
    const loop = buildMultiInstance(factory, {
      ...NO_MULTI_INSTANCE,
      mode: "parallel",
      collection: "${x}",
    });
    expect(loop?.extensionElements).toBeUndefined();
  });

  it("round-trips through readMultiInstance", () => {
    const factory = fakeFactory();
    const config = {
      mode: "sequential" as const,
      collection: "${items}",
      elementVariable: "item",
      elementIndexVariable: "i",
      cardinality: "",
      completionCondition: "",
      aggregation: {
        target: "results",
        createOverviewVariable: false,
        storeAsTransientVariable: true,
        variables: [{ source: "outcome", target: "outcome" }],
      },
    };
    const loop = buildMultiInstance(factory, config);
    expect(readMultiInstance({ $type: "bpmn:UserTask", loopCharacteristics: loop })).toEqual(config);
  });
});

/* ── Named single fields ───────────────────────────────────────────────────── */

describe("named field injections", () => {
  it("reads a decision key out of the generic field list", () => {
    expect(
      readNamedField(
        {
          $type: "bpmn:ServiceTask",
          extensionElements: {
            values: [
              { $type: "flowable:Field", name: DECISION_KEY_FIELD, stringValue: "creditCheck" },
            ],
          },
        },
        DECISION_KEY_FIELD,
      ),
    ).toBe("creditCheck");
  });

  it("replaces only its own field, leaving the rest of the injections alone", () => {
    const factory = fakeFactory();
    const business = {
      $type: "bpmn:ServiceTask",
      extensionElements: {
        values: [
          { $type: "flowable:Field", name: DECISION_KEY_FIELD, stringValue: "old" },
          { $type: "flowable:Field", name: "otherField", stringValue: "keep" },
        ],
      },
    };

    const result = writeNamedField(factory, business, DECISION_KEY_FIELD, "creditCheck");
    const fields = readFields({ ...business, extensionElements: { values: result?.values as ModdleElement[] } });

    // The dedicated control and the generic editor operate on one list, not two.
    expect(fields).toEqual([
      { name: "otherField", valueKind: "stringValue", value: "keep" },
      { name: DECISION_KEY_FIELD, valueKind: "stringValue", value: "creditCheck" },
    ]);
  });

  it("removes the field when cleared, rather than leaving an empty one", () => {
    const factory = fakeFactory();
    const business = {
      $type: "bpmn:ServiceTask",
      extensionElements: {
        values: [{ $type: "flowable:Field", name: DECISION_KEY_FIELD, stringValue: "old" }],
      },
    };
    expect(writeNamedField(factory, business, DECISION_KEY_FIELD, "  ")).toBeUndefined();
  });
});
