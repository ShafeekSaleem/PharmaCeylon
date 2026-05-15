"use client";

import { useCallback, useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { apiFetch } from "@/lib/auth-client";
import styles from "./image-upload.module.css";

export type ImageUploadProps = {
  value?: string | null;
  onChange: (url: string | null) => void;
  folder?: string;
  disabled?: boolean;
  className?: string;
};

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

export function ImageUpload({
  value,
  onChange,
  folder = "products",
  disabled = false,
  className,
}: ImageUploadProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validate = (file: File): string | null => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      return "Only JPEG, PNG, or WebP images are allowed.";
    }
    if (file.size > MAX_SIZE) {
      return "File must be under 2 MB.";
    }
    return null;
  };

  const upload = useCallback(
    async (file: File) => {
      const validationError = validate(file);
      if (validationError) {
        setError(validationError);
        return;
      }

      setError(null);
      setUploading(true);

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await apiFetch(`/uploads/image?context=${folder}`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.message || `Upload failed (${res.status})`);
        }

        const data = await res.json();
        onChange(data.url);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [folder, onChange],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) upload(file);
    },
    [upload],
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleRemove = () => {
    onChange(null);
    setError(null);
  };

  const wrapperClass = [styles.wrapper, disabled ? styles.disabled : "", className]
    .filter(Boolean)
    .join(" ");

  if (value) {
    return (
      <div className={wrapperClass}>
        <div className={styles.previewContainer}>
          <img src={value} alt="Preview" className={styles.preview} />
          {!disabled && (
            <button
              type="button"
              className={styles.removeBtn}
              onClick={handleRemove}
              aria-label="Remove image"
            >
              &times;
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={wrapperClass}>
      <div
        role="button"
        tabIndex={0}
        className={`${styles.dropZone} ${dragOver ? styles.dropZoneDragOver : ""}`}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleClick();
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        aria-label="Upload image"
      >
        {uploading ? (
          <div className={styles.spinner} />
        ) : (
          <>
            <svg
              className={styles.icon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <span className={styles.hint}>Drop or click</span>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className={styles.hidden}
        onChange={handleFileChange}
        disabled={disabled}
      />

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
