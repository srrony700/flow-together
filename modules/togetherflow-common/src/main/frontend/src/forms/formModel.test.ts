import { describe, expect, it } from "vitest";
import type { FormModelResponse } from "../api/types";
import {
  fieldConstraints,
  fieldLabel,
  fieldLocales,
  withFieldLabel,
  fieldIdsInOrder,
  flattenFields,
  formValuesToVariables,
  hasRenderableFields,
  parseStoredUpload,
  serialiseStoredUpload,
  initialValues,
  isOptionField,
  isSubmittable,
  toDateInputValue,
  validateField,
  validateForm,
} from "./formModel";

const model = (fields: FormModelResponse["fields"]): FormModelResponse => ({ fields });

describe("flattenFields", () => {
  it("walks container rows and columns", () => {
    const flat = flattenFields([
      {
        id: "c1",
        type: "container",
        fieldType: "FormContainer",
        fields: [
          [
            { id: "a", type: "text" },
            { id: "b", type: "text" },
          ],
          [{ id: "c", type: "text" }],
        ],
      },
      { id: "d", type: "text" },
    ]);
    expect(flat.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("survives a container with no children", () => {
    expect(flattenFields([{ id: "c", type: "container", fieldType: "FormContainer" }])).toEqual([]);
  });
});

describe("isSubmittable", () => {
  it("excludes layout, display and engine-computed fields", () => {
    for (const type of ["container", "spacer", "horizontal-line", "headline", "hyperlink", "expression"]) {
      expect(isSubmittable({ id: "x", type })).toBe(false);
    }
    for (const type of ["text", "integer", "boolean", "dropdown", "date"]) {
      expect(isSubmittable({ id: "x", type })).toBe(true);
    }
  });
});

describe("isOptionField", () => {
  it("detects by discriminator or by type", () => {
    expect(isOptionField({ id: "x", type: "dropdown" })).toBe(true);
    expect(isOptionField({ id: "x", type: "radio-buttons" })).toBe(true);
    expect(isOptionField({ id: "x", type: "text", fieldType: "OptionFormField" })).toBe(true);
    expect(isOptionField({ id: "x", type: "text" })).toBe(false);
  });
});

describe("initialValues", () => {
  it("seeds from the field's value and skips non-submittable fields", () => {
    const values = initialValues(
      model([
        { id: "name", type: "text", value: "Ada" },
        { id: "agreed", type: "boolean", value: true },
        { id: "note", type: "headline" },
      ]),
    );
    expect(values).toEqual({ name: "Ada", agreed: true });
  });

  it("represents an absent value as empty, not the string 'null'", () => {
    expect(initialValues(model([{ id: "x", type: "text", value: null }]))).toEqual({ x: "" });
  });

  it("coerces a date to the yyyy-MM-dd an input[type=date] accepts", () => {
    const values = initialValues(model([{ id: "d", type: "date", value: "2026-03-05T10:00:00Z" }]));
    expect(values.d).toBe("2026-03-05");
  });

  it("treats a missing boolean as false rather than empty string", () => {
    expect(initialValues(model([{ id: "b", type: "boolean" }]))).toEqual({ b: false });
  });
});

describe("toDateInputValue", () => {
  it("passes through an already-valid date string and rejects nonsense", () => {
    expect(toDateInputValue("2026-03-05T00:00:00Z")).toBe("2026-03-05");
    expect(toDateInputValue("not-a-date")).toBe("not-a-date");
    expect(toDateInputValue(undefined)).toBe("");
  });

  it("keeps the calendar date the value carries, whatever the offset", () => {
    // Converting through UTC would report 4 March here, and the day would walk backwards
    // one step per save for every user east of UTC.
    expect(toDateInputValue("2026-03-05T01:00:00+03:00")).toBe("2026-03-05");
    expect(toDateInputValue("2026-03-05T23:30:00-05:00")).toBe("2026-03-05");
  });

  it("round-trips what formValuesToVariables writes", () => {
    const written = formValuesToVariables(model([{ id: "d", type: "date" }]), {
      d: "2026-03-05",
    })[0].value as string;
    expect(toDateInputValue(written)).toBe("2026-03-05");
  });
});

describe("fieldConstraints", () => {
  it("reads the optional limits out of the engine's free-form params map", () => {
    expect(
      fieldConstraints({
        id: "x",
        type: "text",
        params: {
          description: "As printed on the invoice.",
          // Numbers arrive as strings from JSON authored by hand.
          maxLength: "40",
          min: 1,
          pattern: "^INV-",
          patternMessage: "Start with INV-.",
          accept: ".pdf",
          maxFileSize: 1000,
        },
      }),
    ).toEqual({
      hint: "As printed on the invoice.",
      minLength: undefined,
      maxLength: 40,
      min: 1,
      max: undefined,
      pattern: "^INV-",
      patternMessage: "Start with INV-.",
      accept: ".pdf",
      maxFileSize: 1000,
    });
  });

  it("is all-undefined for a field that declares nothing, so nothing changes", () => {
    expect(fieldConstraints({ id: "x", type: "text" })).toEqual({
      hint: undefined,
      minLength: undefined,
      maxLength: undefined,
      min: undefined,
      max: undefined,
      pattern: undefined,
      patternMessage: undefined,
      accept: undefined,
      maxFileSize: undefined,
    });
  });
});

describe("fieldIdsInOrder", () => {
  it("reads containers in the order the form presents them", () => {
    expect(
      fieldIdsInOrder(
        model([
          {
            id: "c",
            type: "container",
            fieldType: "FormContainer",
            fields: [[{ id: "a", type: "text" }, { id: "b", type: "text" }]],
          },
          { id: "z", type: "text" },
        ]),
      ),
    ).toEqual(["a", "b", "z"]);
  });
});

describe("validateField", () => {
  it("enforces required, but not on booleans (false is a valid answer)", () => {
    expect(validateField({ id: "x", name: "Name", type: "text", required: true }, "")).toMatch(
      /required/,
    );
    expect(validateField({ id: "x", type: "boolean", required: true }, false)).toBeUndefined();
  });

  it("validates numeric and date formats", () => {
    expect(validateField({ id: "x", type: "integer" }, "1.5")).toBe("Enter a whole number.");
    expect(validateField({ id: "x", type: "integer" }, "12")).toBeUndefined();
    expect(validateField({ id: "x", type: "decimal" }, "abc")).toBe("Enter a number.");
    expect(validateField({ id: "x", type: "amount" }, "12.50")).toBeUndefined();
    expect(validateField({ id: "x", type: "date" }, "nope")).toBe("Enter a valid date.");
  });

  it("allows a blank optional field", () => {
    expect(validateField({ id: "x", type: "integer" }, "")).toBeUndefined();
  });

  it("enforces the length, range and pattern a field declares", () => {
    const limited = { id: "x", name: "Code", type: "text", params: { minLength: 3, maxLength: 5 } };
    expect(validateField(limited, "ab")).toBe("Enter at least 3 characters.");
    expect(validateField(limited, "abcdef")).toBe("Use 5 characters or fewer.");
    expect(validateField(limited, "abcd")).toBeUndefined();

    const ranged = { id: "n", type: "integer", params: { min: 1, max: 10 } };
    expect(validateField(ranged, "0")).toBe("Enter 1 or more.");
    expect(validateField(ranged, "11")).toBe("Enter 10 or less.");
    expect(validateField(ranged, "5")).toBeUndefined();

    const shaped = { id: "r", type: "text", params: { pattern: "^INV-\\d+$" } };
    expect(validateField(shaped, "nope")).toBe("Enter this in the format the form expects.");
    expect(validateField(shaped, "INV-42")).toBeUndefined();
  });

  it("prefers the form author's own words for a pattern to the generic message", () => {
    expect(
      validateField(
        { id: "r", type: "text", params: { pattern: "^INV-", patternMessage: "Start with INV-." } },
        "nope",
      ),
    ).toBe("Start with INV-.");
  });

  it("lets a value through when the pattern itself is broken", () => {
    // An unparseable regex is the form author's bug. Blocking on it would make the form
    // unsubmittable by anyone, which is a worse failure than accepting the value.
    expect(validateField({ id: "r", type: "text", params: { pattern: "([" } }, "x")).toBeUndefined();
  });

  it("reports in the caller's language rather than baked-in English (§8)", () => {
    const de = (key: string, params?: Record<string, string | number>) =>
      key === "form.validation.required" ? `${params?.field} ist erforderlich.` : key;
    expect(validateField({ id: "x", name: "Name", type: "text", required: true }, "", de)).toBe(
      "Name ist erforderlich.",
    );
    expect(
      validateForm(model([{ id: "x", name: "Name", type: "text", required: true }]), { x: "" }, de),
    ).toEqual({ x: "Name ist erforderlich." });
  });
});

describe("validateForm", () => {
  it("collects errors by field id and ignores read-only fields", () => {
    const errors = validateForm(
      model([
        { id: "a", name: "A", type: "text", required: true },
        { id: "b", name: "B", type: "text", required: true, readOnly: true },
      ]),
      { a: "", b: "" },
    );
    expect(Object.keys(errors)).toEqual(["a"]);
  });

  it("validates fields nested inside containers", () => {
    const errors = validateForm(
      model([
        {
          id: "c",
          type: "container",
          fieldType: "FormContainer",
          fields: [[{ id: "inner", name: "Inner", type: "integer" }]],
        },
      ]),
      { inner: "abc" },
    );
    expect(errors.inner).toBe("Enter a whole number.");
  });
});

describe("formValuesToVariables", () => {
  it("maps each field type to the variable type the engine expects", () => {
    const vars = formValuesToVariables(
      model([
        { id: "s", type: "text" },
        { id: "i", type: "integer" },
        { id: "d", type: "decimal" },
        { id: "amt", type: "amount" },
        { id: "b", type: "boolean" },
        { id: "when", type: "date" },
      ]),
      { s: "hi", i: "42", d: "1.5", amt: "9.99", b: true, when: "2026-03-05" },
    );
    expect(vars).toEqual([
      { name: "s", type: "string", value: "hi" },
      { name: "i", type: "integer", value: 42 },
      { name: "d", type: "double", value: 1.5 },
      { name: "amt", type: "double", value: 9.99 },
      { name: "b", type: "boolean", value: true },
      { name: "when", type: "date", value: new Date("2026-03-05").toISOString() },
    ]);
  });

  it("submits a cleared field as null so the variable is actually cleared", () => {
    const vars = formValuesToVariables(model([{ id: "x", type: "text" }]), { x: "  " });
    expect(vars).toEqual([{ name: "x", type: "string", value: null }]);
  });

  it("omits read-only fields so a later task cannot overwrite the original answers", () => {
    const vars = formValuesToVariables(
      model([
        { id: "employeeId", type: "text", readOnly: true },
        { id: "decision", type: "text" },
      ]),
      { employeeId: "E-1", decision: "true" },
    );
    expect(vars.map((item) => item.name)).toEqual(["decision"]);
  });

  it("omits layout and expression fields", () => {
    const vars = formValuesToVariables(
      model([
        { id: "head", type: "headline" },
        { id: "calc", type: "expression" },
        { id: "keep", type: "text" },
      ]),
      { keep: "v", calc: "ignored" },
    );
    expect(vars.map((v) => v.name)).toEqual(["keep"]);
  });

  it("includes fields nested in containers", () => {
    const vars = formValuesToVariables(
      model([
        {
          id: "c",
          type: "container",
          fieldType: "FormContainer",
          fields: [[{ id: "inner", type: "text" }]],
        },
      ]),
      { inner: "v" },
    );
    expect(vars).toEqual([{ name: "inner", type: "string", value: "v" }]);
  });
});

describe("stored uploads", () => {
  it("round-trips the attachment id, owning task and file name", () => {
    const stored = { id: "att-1", taskId: "task-9", name: "letter.pdf" };
    expect(parseStoredUpload(serialiseStoredUpload(stored))).toEqual(stored);
  });

  it("ignores a bare attachment id — content URLs are task-scoped, so that is not enough", () => {
    expect(parseStoredUpload("att-1")).toBeNull();
  });
});

describe("hasRenderableFields", () => {
  it("is false for undefined, empty, or container-only-with-no-children models", () => {
    expect(hasRenderableFields(undefined)).toBe(false);
    expect(hasRenderableFields({})).toBe(false);
    expect(hasRenderableFields(model([]))).toBe(false);
    expect(
      hasRenderableFields(model([{ id: "c", type: "container", fieldType: "FormContainer" }])),
    ).toBe(false);
  });

  it("is true when at least one leaf field exists", () => {
    expect(hasRenderableFields(model([{ id: "x", type: "text" }]))).toBe(true);
  });
});

describe("expression fields", () => {
  it("are excluded from submitted variables but keep their model value for display", () => {
    const m = model([{ id: "calc", name: "Total", type: "expression", value: "4,120.00" }]);
    expect(formValuesToVariables(m, {})).toEqual([]);
    // Not seeded into values — the renderer reads field.value directly.
    expect(initialValues(m)).toEqual({});
    expect(m.fields?.[0].value).toBe("4,120.00");
  });
});

describe("per-model translations (W3.3)", () => {
  const field = (params?: Record<string, unknown>) => ({
    id: "amount",
    name: "Amount",
    type: "text",
    ...(params ? { params } : {}),
  });

  it("uses the field's own name when nothing is translated", () => {
    // The source text is the fallback: a missing translation must not render a key or a
    // blank, which is what a catalogue-shaped design would do.
    expect(fieldLabel(field(), "de")).toBe("Amount");
  });

  it("prefers the active locale's label", () => {
    expect(fieldLabel(field({ tfLabels: { de: "Betrag" } }), "de")).toBe("Betrag");
  });

  it("falls back through the base language before the source", () => {
    expect(fieldLabel(field({ tfLabels: { de: "Betrag" } }), "de-AT")).toBe("Betrag");
  });

  it("ignores a blank translation rather than rendering nothing", () => {
    expect(fieldLabel(field({ tfLabels: { de: "   " } }), "de")).toBe("Amount");
  });

  it("adds and clears a locale without touching the source text", () => {
    const translated = withFieldLabel(field(), "de", "Betrag");
    expect(fieldLocales(translated)).toEqual(["de"]);
    expect(translated.name).toBe("Amount");

    const cleared = withFieldLabel(translated, "de", "");
    expect(fieldLocales(cleared)).toEqual([]);
    // The params map goes entirely when it holds nothing, rather than lingering as `{}`.
    expect(cleared.params).toBeUndefined();
  });

  it("leaves other params alone", () => {
    const translated = withFieldLabel(field({ maxLength: 40 }), "fr", "Montant");
    expect(translated.params?.maxLength).toBe(40);
  });
});
