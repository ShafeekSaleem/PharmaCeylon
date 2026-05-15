"use client";

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import styles from "./form-field.module.css";

type BaseProps = {
  label: string;
  error?: string;
  hint?: string;
  icon?: ReactNode;
  required?: boolean;
  fullWidth?: boolean;
};

type InputFieldProps = BaseProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
    as?: "input";
  };

type SelectFieldProps = BaseProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
    as: "select";
    children: ReactNode;
  };

type TextareaFieldProps = BaseProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
    as: "textarea";
  };

export type FormFieldProps = InputFieldProps | SelectFieldProps | TextareaFieldProps;

export const FormField = forwardRef<
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  FormFieldProps
>(function FormField(props, ref) {
  const autoId = useId();
  const {
    label,
    error,
    hint,
    icon,
    required,
    fullWidth = true,
    as = "input",
    className,
    ...rest
  } = props as BaseProps & { as?: string; className?: string; children?: ReactNode } & Record<string, unknown>;

  const id = (rest.id as string) ?? autoId;
  const hasError = !!error;

  const wrapCls = [
    styles.field,
    fullWidth ? styles.fullWidth : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  const controlCls = [
    styles.control,
    icon ? styles.hasIcon : "",
    hasError ? styles.error : "",
    as === "textarea" ? styles.textarea : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={wrapCls}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {required && <span className={styles.required}>*</span>}
      </label>
      <div className={styles.inputWrap}>
        {icon && <span className={styles.icon}>{icon}</span>}
        {as === "select" ? (
          <select
            id={id}
            ref={ref as React.Ref<HTMLSelectElement>}
            className={controlCls}
            aria-invalid={hasError || undefined}
            aria-describedby={hasError ? `${id}-err` : hint ? `${id}-hint` : undefined}
            {...(rest as SelectHTMLAttributes<HTMLSelectElement>)}
          >
            {(props as SelectFieldProps).children}
          </select>
        ) : as === "textarea" ? (
          <textarea
            id={id}
            ref={ref as React.Ref<HTMLTextAreaElement>}
            className={controlCls}
            aria-invalid={hasError || undefined}
            aria-describedby={hasError ? `${id}-err` : hint ? `${id}-hint` : undefined}
            {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          />
        ) : (
          <input
            id={id}
            ref={ref as React.Ref<HTMLInputElement>}
            className={controlCls}
            aria-invalid={hasError || undefined}
            aria-describedby={hasError ? `${id}-err` : hint ? `${id}-hint` : undefined}
            {...(rest as InputHTMLAttributes<HTMLInputElement>)}
          />
        )}
      </div>
      {hasError ? (
        <p id={`${id}-err`} className={styles.errorText}>{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className={styles.hintText}>{hint}</p>
      ) : null}
    </div>
  );
});
