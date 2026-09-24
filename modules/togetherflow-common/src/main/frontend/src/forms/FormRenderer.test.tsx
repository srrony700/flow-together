/**
 * The form renderer (REQUIREMENTS.md §7.1 Forms, §14.1, §14.3).
 *
 * `formModel.test.ts` covers the value layer — what validates, what gets submitted. This
 * covers what the user meets: whether a required field says so out loud, whether a
 * rejected submit explains itself, whether a read-only answer is readable, and whether an
 * upload refuses a file the form said it would not take.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FormField, FormModelResponse } from "../api/types";
import { FormRenderer, formatFileSize } from "./FormRenderer";
import type { FormErrors, FormValues } from "./formModel";

const model = (fields: FormField[]): FormModelResponse => ({ id: "f", fields });

function renderForm(
  fields: FormField[],
  options: {
    values?: FormValues;
    errors?: FormErrors;
    disabled?: boolean;
    submitAttempt?: number;
    onChange?: (fieldId: string, value: unknown) => void;
    onSubmit?: () => void;
    onUploadFile?: (field: FormField, file: File) => Promise<string>;
    fileUrl?: (field: FormField, value: unknown) => string | undefined;
  } = {},
) {
  const onChange = options.onChange ?? vi.fn();
  const result = render(
    <FormRenderer
      id="tf-test-form"
      model={model(fields)}
      values={options.values ?? {}}
      errors={options.errors}
      disabled={options.disabled}
      submitAttempt={options.submitAttempt}
      onChange={onChange}
      onSubmit={options.onSubmit}
      onUploadFile={options.onUploadFile}
      fileUrl={options.fileUrl}
    />,
  );
  return { ...result, onChange };
}

describe("structure", () => {
  it("renders a real form element, so Enter submits and an outside button can target it", async () => {
    const onSubmit = vi.fn();
    renderForm([{ id: "name", name: "Name", type: "text" }], { onSubmit });

    const form = document.getElementById("tf-test-form");
    expect(form?.tagName).toBe("FORM");
    // Field ids are namespaced by the form's, so two forms can coexist on one page.
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute("id", "tf-test-form-name");

    await userEvent.type(screen.getByLabelText(/^Name/), "Ada{Enter}");
    expect(onSubmit).toHaveBeenCalled();
  });

  it("lays a container's row out on the 12-column grid, honouring a declared colspan", () => {
    const { container } = renderForm([
      {
        id: "c",
        type: "container",
        fieldType: "FormContainer",
        fields: [
          [
            { id: "wide", name: "Wide", type: "text", layout: { colspan: 8 } },
            { id: "narrow", name: "Narrow", type: "text", layout: { colspan: 4 } },
          ],
          // No colspan declared: an even share of the row.
          [
            { id: "a", name: "A", type: "text" },
            { id: "b", name: "B", type: "text" },
          ],
        ],
      },
    ]);

    const columns = container.querySelectorAll<HTMLElement>(".tf-form__col");
    expect(columns[0].style.getPropertyValue("--tf-col-span")).toBe("8");
    expect(columns[1].style.getPropertyValue("--tf-col-span")).toBe("4");
    expect(columns[2].style.getPropertyValue("--tf-col-span")).toBe("6");
  });

  it("does not render a field whose visibility condition is unmet", () => {
    renderForm(
      [
        { id: "kind", name: "Kind", type: "text" },
        {
          id: "why",
          name: "Why",
          type: "text",
          params: { tfVisibleWhen: { field: "kind", operator: "equals", value: "other" } },
        },
      ],
      { values: { kind: "standard" } },
    );

    expect(screen.getByLabelText(/^Kind/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Why/)).not.toBeInTheDocument();
  });

  it("refuses to turn a non-http hyperlink into a link", () => {
    renderForm([
      {
        id: "l",
        name: "Click me",
        type: "hyperlink",
        params: { hyperlinkUrl: "javascript:alert(1)" },
      },
    ]);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Click me")).toBeInTheDocument();
  });
});

describe("labelling", () => {
  it("marks a required field for sighted and screen-reader users alike", () => {
    renderForm([{ id: "name", name: "Name", type: "text", required: true }]);

    const input = screen.getByLabelText(/^Name/);
    expect(input).toHaveAttribute("aria-required", "true");
    // The asterisk is decorative; the word carries the meaning.
    expect(screen.getByText("required", { exact: false })).toBeInTheDocument();
  });

  it("wires a field's help text to the control through aria-describedby", () => {
    renderForm([
      {
        id: "ref",
        name: "Reference",
        type: "text",
        params: { description: "As printed on the invoice." },
      },
    ]);

    const input = screen.getByLabelText(/^Reference/);
    const described = input.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)).toHaveTextContent("As printed on the invoice.");
  });

  it("names a radio group with the question, as a fieldset rather than a stray label", () => {
    renderForm([
      {
        id: "reason",
        name: "Reason",
        type: "radio-buttons",
        fieldType: "OptionFormField",
        required: true,
        options: [{ name: "Duplicate" }, { name: "Over budget" }],
      },
    ]);

    // Before, the label pointed at an id no element had and the group was anonymous.
    const group = screen.getByRole("group", { name: /Reason/ });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    // The first option answers to the field's own id, so a jump link lands on the group.
    expect(within(group).getAllByRole("radio")[0]).toHaveAttribute("id", "tf-test-form-reason");
  });

  it("shows Yes/No and stores the option id so gateway conditions still see true/false", async () => {
    const { onChange } = renderForm([
      {
        id: "aseApproved",
        name: "Approve?",
        type: "radio-buttons",
        fieldType: "OptionFormField",
        options: [
          { id: "true", name: "Yes" },
          { id: "false", name: "No" },
        ],
      },
    ]);
    await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
    expect(onChange).toHaveBeenCalledWith("aseApproved", "true");
    expect(screen.getByRole("radio", { name: "No" })).toBeInTheDocument();
  });

  it("labels a checkbox with the question itself instead of a hardcoded 'Yes'", async () => {
    const { onChange } = renderForm([{ id: "urgent", name: "Urgent", type: "boolean" }]);

    expect(screen.queryByText("Yes")).not.toBeInTheDocument();
    // Clicking the words, not just the box, toggles it.
    await userEvent.click(screen.getByText("Urgent"));
    expect(onChange).toHaveBeenCalledWith("urgent", true);
  });
});

describe("read-only and computed values", () => {
  it("shows a model-read-only field as its answer, not as a greyed-out control", () => {
    renderForm([{ id: "ref", name: "Reference", type: "text", readOnly: true }], {
      values: { ref: "INV-2291" },
    });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("INV-2291")).toBeInTheDocument();
  });

  it("puts a read-only boolean in words rather than showing a locked checkbox", () => {
    renderForm([{ id: "agreed", name: "Agreed", type: "boolean", readOnly: true }], {
      values: { agreed: true },
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("announces a checkbox's guidance instead of only rendering it", () => {
    // A checkbox has nowhere to put a placeholder, so its placeholder is the hint — and
    // a hint that is not referenced by aria-describedby is never read out.
    renderForm([
      { id: "terms", name: "Accept terms", type: "boolean", placeholder: "Required to proceed." },
    ]);
    const box = screen.getByRole("checkbox");
    const described = box.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)).toHaveTextContent("Required to proceed.");
  });

  it("says so when a read-only field has no answer at all", () => {
    renderForm([{ id: "ref", name: "Reference", type: "text", readOnly: true }], { values: {} });
    expect(screen.getByText("Not answered")).toBeInTheDocument();
  });

  it("shows an engine-computed expression field's value", () => {
    renderForm([{ id: "total", name: "Total", type: "expression", value: "4,120.00" }]);
    expect(screen.getByText("4,120.00")).toBeInTheDocument();
  });

  it("keeps real disabled controls when the whole form is only temporarily unavailable", () => {
    // An unclaimed task: the field is editable in principle, just not right now.
    renderForm([{ id: "name", name: "Name", type: "text" }], { disabled: true });
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
  });
});

describe("error summary", () => {
  const FIELDS: FormField[] = [
    { id: "comment", name: "Comment", type: "text", required: true },
    { id: "amount", name: "Amount", type: "integer" },
  ];
  const ERRORS: FormErrors = {
    amount: "Enter a whole number.",
    comment: "Comment is required.",
  };

  it("stays out of the way until a submit is actually attempted", () => {
    renderForm(FIELDS, { errors: ERRORS, submitAttempt: 0 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists every problem in the order the form presents them, and takes focus", async () => {
    renderForm(FIELDS, { errors: ERRORS, submitAttempt: 1 });

    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("There are 2 problems with this form");
    // Object-key order would have put "amount" first; form order puts "comment" first.
    const links = within(summary).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Comment is required.",
      "Enter a whole number.",
    ]);
    // Focused, so a keyboard user is moved to the explanation rather than left at a
    // button that appeared to do nothing.
    await waitFor(() => expect(summary).toHaveFocus());
  });

  it("moves focus to the field a problem is about", async () => {
    renderForm(FIELDS, { errors: ERRORS, submitAttempt: 1 });

    const summary = await screen.findByRole("alert");
    await userEvent.click(within(summary).getAllByRole("link")[1]);
    expect(screen.getByLabelText(/^Amount/)).toHaveFocus();
  });

  it("does not appear when the attempt found nothing wrong", () => {
    renderForm(FIELDS, { errors: {}, submitAttempt: 3 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("character counter", () => {
  it("counts down against a maxLength, and past it rather than blocking the paste", () => {
    const { rerender } = renderForm([
      { id: "note", name: "Note", type: "text", params: { maxLength: 10 } },
    ]);
    expect(screen.getByText("10 characters left")).toBeInTheDocument();

    rerender(
      <FormRenderer
        id="tf-test-form"
        model={model([{ id: "note", name: "Note", type: "text", params: { maxLength: 10 } }])}
        values={{ note: "over the limit" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("4 characters too many")).toBeInTheDocument();
  });
});

describe("number fields", () => {
  it("passes the model's range through to the control", () => {
    renderForm([
      { id: "n", name: "Count", type: "integer", params: { min: 1, max: 10 } },
    ]);
    const input = screen.getByLabelText(/^Count/);
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "10");
    expect(input).toHaveAttribute("inputmode", "numeric");
  });
});

describe("upload", () => {
  const FIELD: FormField = {
    id: "doc",
    name: "Document",
    type: "upload",
    params: { accept: ".pdf", maxFileSize: 1000 },
  };

  it("explains itself instead of offering a control that cannot work", () => {
    // A start form has no instance yet, so there is nowhere for a file to go.
    renderForm([FIELD]);
    expect(screen.getByText(/can't be attached before the work is started/i)).toBeInTheDocument();
  });

  it("shows the file it attached, with its size, and can remove it", async () => {
    const onUploadFile = vi.fn().mockResolvedValue("attachment-1");
    const onChange = vi.fn();
    const { rerender } = renderForm([FIELD], { onUploadFile, onChange });

    const file = new File(["x".repeat(500)], "invoice.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText(/^Document/), file);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("doc", "attachment-1"));
    rerender(
      <FormRenderer
        id="tf-test-form"
        model={model([FIELD])}
        values={{ doc: "attachment-1" }}
        onChange={onChange}
        onUploadFile={onUploadFile}
      />,
    );

    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
    expect(screen.getByText("500 B")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /remove invoice\.pdf/i }));
    expect(onChange).toHaveBeenLastCalledWith("doc", undefined);
  });

  it("refuses a file over the size limit without sending it", async () => {
    const onUploadFile = vi.fn().mockResolvedValue("nope");
    renderForm([FIELD], { onUploadFile });

    const tooBig = new File(["x".repeat(2000)], "big.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText(/^Document/), tooBig);

    expect(await screen.findByRole("alert")).toHaveTextContent(/over the 1000 B limit/i);
    expect(onUploadFile).not.toHaveBeenCalled();
  });

  it("refuses a file type the form said it would not take", async () => {
    const onUploadFile = vi.fn().mockResolvedValue("nope");
    const { container } = renderForm([FIELD], { onUploadFile });

    // `accept` filters the file picker, but nothing filters a drag-and-drop — which is
    // exactly the path a dropzone adds, so it has to turn the file away itself.
    const wrong = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(container.querySelector(".tf-upload__zone")!, {
      dataTransfer: { files: [wrong] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't accepted here/i);
    expect(onUploadFile).not.toHaveBeenCalled();
  });

  it("accepts a dropped file that does meet the constraints", async () => {
    const onUploadFile = vi.fn().mockResolvedValue("attachment-2");
    const onChange = vi.fn();
    const { container } = renderForm([FIELD], { onUploadFile, onChange });

    const good = new File(["x".repeat(100)], "ok.pdf", { type: "application/pdf" });
    fireEvent.drop(container.querySelector(".tf-upload__zone")!, {
      dataTransfer: { files: [good] },
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("doc", "attachment-2"));
  });

  it("reports a failed upload and leaves the field empty rather than pretending", async () => {
    const onUploadFile = vi.fn().mockRejectedValue(new Error("Gateway unavailable"));
    const onChange = vi.fn();
    renderForm([{ id: "doc", name: "Document", type: "upload" }], { onUploadFile, onChange });

    await userEvent.upload(
      screen.getByLabelText(/^Document/),
      new File(["x"], "invoice.pdf", { type: "application/pdf" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Gateway unavailable");
    expect(onChange).toHaveBeenLastCalledWith("doc", undefined);
  });

  it("offers a download, not a replace control, when the field is read-only", () => {
    const stored = JSON.stringify({ id: "att-1", taskId: "task-9", name: "letter.pdf" });
    renderForm(
      [{ id: "doc", name: "Resignation letter", type: "upload", readOnly: true }],
      {
        values: { doc: stored },
        fileUrl: () => "/runtime/tasks/task-9/attachments/att-1/content",
      },
    );
    const link = screen.getByRole("link", { name: /download letter\.pdf/i });
    expect(link).toHaveAttribute("href", "/runtime/tasks/task-9/attachments/att-1/content");
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe("formatFileSize", () => {
  it("reads like a file manager rather than a byte count", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(999)).toBe("999 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5 MB");
  });
});
