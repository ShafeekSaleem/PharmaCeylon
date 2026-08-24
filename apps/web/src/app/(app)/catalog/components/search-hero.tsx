"use client";

import type { RefObject } from "react";
import { useCallback, useRef } from "react";
import { IconBarcodeScan, IconSearch, IconX } from "@/components/icons";
import css from "../catalog.module.css";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onScanBarcode?: () => void;
  scanArmed?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
};

export function SearchHero({
  value,
  onChange,
  onClear,
  onScanBarcode,
  scanArmed,
  inputRef,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const tryCameraScan = useCallback(async () => {
    onScanBarcode?.();
    type Detector = {
      detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
    };
    const BD = (
      window as unknown as {
        BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
      }
    ).BarcodeDetector;
    if (!BD) {
      fileRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      const detector = new BD({
        formats: ["ean_13", "ean_8", "code_128", "qr_code", "upc_a", "upc_e"],
      });
      const deadline = Date.now() + 12000;
      const tick = async () => {
        if (Date.now() > deadline) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        try {
          const codes = await detector.detect(video);
          const raw = codes[0]?.rawValue?.trim();
          if (raw) {
            stream.getTracks().forEach((t) => t.stop());
            onChange(raw);
            return;
          }
        } catch {
          /* keep trying */
        }
        window.requestAnimationFrame(() => {
          void tick();
        });
      };
      void tick();
    } catch {
      fileRef.current?.click();
    }
  }, [onChange, onScanBarcode]);

  return (
    <div className={css.heroCard}>
      <div
        className={`${css.searchWrap}${scanArmed ? ` ${css.searchWrapScan}` : ""}`}
      >
        <IconSearch size={18} className={css.searchIcon} />
        <input
          ref={inputRef}
          className={css.searchInput}
          type="text"
          inputMode="search"
          enterKeyHint="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            scanArmed
              ? "Scan or type barcode / SKU, then press Enter…"
              : "Search by product name, generic name, SKU, barcode, alias, or brand…"
          }
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Search catalog"
        />
        <div className={css.searchActions}>
          <button
            type="button"
            className={`${css.iconBtn} ${css.barcodeBtn}${scanArmed ? ` ${css.barcodeBtnActive}` : ""}`}
            onClick={() => {
              void tryCameraScan();
            }}
            aria-label="Scan barcode"
            data-tooltip="Scan barcode"
          >
            <IconBarcodeScan size={18} />
          </button>
          {value ? (
            <button
              type="button"
              className={css.iconBtn}
              onClick={onClear}
              aria-label="Clear search"
              data-tooltip="Clear"
            >
              <IconX size={16} />
            </button>
          ) : (
            <kbd className={css.searchKbd}>/</kbd>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          type Detector = {
            detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
          };
          const BD = (
            window as unknown as {
              BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
            }
          ).BarcodeDetector;
          if (!BD) return;
          try {
            const bitmap = await createImageBitmap(file);
            const detector = new BD({
              formats: ["ean_13", "ean_8", "code_128", "qr_code", "upc_a", "upc_e"],
            });
            const codes = await detector.detect(bitmap);
            const raw = codes[0]?.rawValue?.trim();
            if (raw) onChange(raw);
          } catch {
            /* ignore */
          }
        }}
      />
      {scanArmed ? (
        <p className={css.scanHint}>
          Exact match on — point the scanner here, or type the code and press Enter
        </p>
      ) : null}
    </div>
  );
}
