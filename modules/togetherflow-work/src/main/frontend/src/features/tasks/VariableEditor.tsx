/**
 * Generic typed variable grid. Phase 1 stands in for real form rendering
 * (REQUIREMENTS.md §7.1 Forms bullet) until the form-schema decision lands.
 */

import {
  Button,
  useT,
  validateVariable,
  type EditableVariable,
  type EditableVariableType,
} from "@togetherflow/common";

const TYPES: EditableVariableType[] = ["string", "integer", "long", "double", "boolean", "date", "json"];

export interface VariableEditorProps {
  variables: EditableVariable[];
  onChange: (variables: EditableVariable[]) => void;
  disabled?: boolean;
  /** Existing task variables can be edited but not renamed or removed. */
  allowAdd?: boolean;
  /** Names locked after the employee task — shown, but not writable. */
  lockedNames?: string[];
}

export function VariableEditor({
  variables,
  onChange,
  disabled = false,
  allowAdd = true,
  lockedNames = [],
}: VariableEditorProps) {
  const t = useT();

  function update(index: number, patch: Partial<EditableVariable>) {
    onChange(variables.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)));
  }

  function remove(index: number) {
    onChange(variables.filter((_, i) => i !== index));
  }

  return (
    <div className="tf-variables">
      {variables.length === 0 ? (
        <p className="tf-muted tf-variables__empty">{t("variables.none")}</p>
      ) : (
        <ul className="tf-variables__list">
          {variables.map((variable, index) => {
            const error = validateVariable(variable);
            const locked = lockedNames.includes(variable.name);
            const rowDisabled = disabled || locked;
            return (
              <li className="tf-variables__row" key={index}>
                <div className="tf-variables__name">
                  <label className="tf-visually-hidden" htmlFor={`var-name-${index}`}>
                    {t("variables.name")}
                  </label>
                  <input
                    id={`var-name-${index}`}
                    className="tf-input"
                    value={variable.name}
                    disabled={rowDisabled}
                    placeholder={t("variables.namePlaceholder")}
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                </div>
                <div className="tf-variables__type">
                  <label className="tf-visually-hidden" htmlFor={`var-type-${index}`}>
                    {t("variables.type")}
                  </label>
                  <select
                    id={`var-type-${index}`}
                    className="tf-input tf-select"
                    value={variable.type}
                    disabled={rowDisabled}
                    onChange={(event) =>
                      update(index, { type: event.target.value as EditableVariableType })
                    }
                  >
                    {TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="tf-variables__value">
                  <label className="tf-visually-hidden" htmlFor={`var-value-${index}`}>
                    {t("variables.valueFor", {
                      name: variable.name || t("variables.newVariable"),
                    })}
                  </label>
                  {variable.type === "json" ? (
                    <textarea
                      id={`var-value-${index}`}
                      className="tf-input tf-textarea"
                      rows={3}
                      value={variable.input}
                      disabled={rowDisabled}
                      aria-invalid={Boolean(error) || undefined}
                      onChange={(event) => update(index, { input: event.target.value })}
                    />
                  ) : (
                    <input
                      id={`var-value-${index}`}
                      className="tf-input"
                      value={variable.input}
                      disabled={rowDisabled}
                      aria-invalid={Boolean(error) || undefined}
                      onChange={(event) => update(index, { input: event.target.value })}
                    />
                  )}
                  {error ? (
                    <p className="tf-field__error" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
                {allowAdd ? (
                  <button
                    type="button"
                    className="tf-variables__remove"
                    onClick={() => remove(index)}
                    disabled={rowDisabled}
                    aria-label={t("variables.remove", { name: variable.name || index + 1 })}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {allowAdd ? (
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => onChange([...variables, { name: "", type: "string", input: "" }])}
        >
          {t("variables.add")}
        </Button>
      ) : null}
    </div>
  );
}
