"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconArchive,
  IconBell,
  IconEdit,
  IconFocus,
  IconKeyboard,
  IconLock,
  IconMaximize,
  IconMinimize,
  IconMoreHorizontal,
  IconPause,
  IconPlus,
  IconReceipt,
  IconTag,
} from "@/components/icons";
import { useFullscreen } from "@/lib/use-fullscreen";
import tcss from "../till.module.css";

export type TillMode = "sale" | "returns";

type Props = {
  mode: TillMode;
  onModeChange: (mode: TillMode) => void;
  /** Loaded by the page: the bar remounts on every Sale/Returns switch, so it can't fetch it. */
  branchName: string;
  /** The scan box (sale) or the find-a-sale box (returns). */
  search: ReactNode;
  cashierName: string;
  roleLabel: string;
  holdCount: number;
  holdsEnabled: boolean;
  onHeld: () => void;
  onPriceCheck: () => void;
  focusMode: boolean;
  onToggleFocus: () => void;
  menu: {
    onNewSale: () => void;
    onOpenDrawer: () => void;
    onManualItem: () => void;
    onReprintLast: (() => void) | null;
    onSetPin: (() => void) | null;
    beepEnabled: boolean;
    onToggleBeep: () => void;
    onShortcuts: () => void;
  };
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "PC";
}

/** Hours and minutes, kept current — the till is open all day. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Everything the counter needs above the sale, in one line: where you are, Sale or Returns, the
 * scan box, held sales, price check, who is on the till, and the rest behind ⋯.
 */
export function PosTillBar({
  mode,
  onModeChange,
  branchName,
  search,
  cashierName,
  roleLabel,
  holdCount,
  holdsEnabled,
  onHeld,
  onPriceCheck,
  focusMode,
  onToggleFocus,
  menu,
}: Props) {
  const now = useClock();
  // Focus mode hides the app's top bar, and its fullscreen button with it — so the till has its own.
  const fullscreen = useFullscreen();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const day = now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const run = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  return (
    <header className={tcss.bar}>
      <div className={tcss.brand}>
        <span className={tcss.brandMark} aria-hidden>
          <IconPlus size={18} />
        </span>
        <span className={tcss.brandText}>
          <span className={tcss.brandName}>{branchName || "PharmaCeylon"}</span>
          <span className={tcss.brandSub}>Counter · {day}</span>
        </span>
      </div>

      <div className={tcss.modeSwitch} role="tablist" aria-label="Till mode">
        {(["sale", "returns"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={`${tcss.modeBtn}${mode === value ? ` ${tcss.modeBtnActive}` : ""}`}
            onClick={() => onModeChange(value)}
          >
            {value === "sale" ? "Sale" : "Returns"}
          </button>
        ))}
      </div>

      {search}

      {/* A fixed-width slot, so the scan box keeps its width whichever mode's buttons are here. */}
      <div className={tcss.barActions}>
        {mode === "sale" ? (
          <>
            {holdsEnabled && (
              <button type="button" className={tcss.barBtn} onClick={onHeld} data-tooltip="Held sales (F7)">
                <IconPause size={16} />
                <span className={tcss.barLabel}>Held</span>
                {holdCount > 0 && <span className={tcss.countBadge}>{holdCount}</span>}
              </button>
            )}
            <button
              type="button"
              className={tcss.barBtn}
              onClick={onPriceCheck}
              data-tooltip="Look up a price without touching the sale (F3)"
            >
              <IconTag size={16} />
              <span className={tcss.barLabel}>Price check</span>
            </button>
          </>
        ) : null}
      </div>

      <span className={tcss.barDivider} aria-hidden />

      <div className={tcss.cashier}>
        <span className={tcss.avatar} aria-hidden>
          {initials(cashierName)}
        </span>
        <span className={tcss.cashierText}>
          <span className={tcss.cashierName}>{cashierName}</span>
          <span className={tcss.cashierSub}>
            {roleLabel} · {time}
          </span>
        </span>
      </div>

      <div className={tcss.menuWrap} ref={menuRef}>
        <button
          type="button"
          className={`${tcss.barBtn} ${tcss.barIconBtn}`}
          aria-label="More till actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconMoreHorizontal size={18} />
        </button>
        {menuOpen && (
          <div className={tcss.menu} role="menu">
            <button type="button" role="menuitem" className={tcss.menuItem} onClick={run(menu.onNewSale)}>
              <IconPlus size={16} /> New sale <span className={`${tcss.kbd} ${tcss.menuItemKey}`}>F8</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={tcss.menuItem}
              onClick={menu.onReprintLast ? run(menu.onReprintLast) : undefined}
              disabled={!menu.onReprintLast}
            >
              <IconReceipt size={16} /> Reprint last receipt
            </button>
            <button type="button" role="menuitem" className={tcss.menuItem} onClick={run(menu.onOpenDrawer)}>
              <IconArchive size={16} /> Open cash drawer
            </button>
            <button type="button" role="menuitem" className={tcss.menuItem} onClick={run(menu.onManualItem)}>
              <IconEdit size={16} /> Manual item
            </button>
            {menu.onSetPin && (
              <button type="button" role="menuitem" className={tcss.menuItem} onClick={run(menu.onSetPin)}>
                <IconLock size={16} /> Set my till PIN
              </button>
            )}
            <span className={tcss.menuDivider} aria-hidden />
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={menu.beepEnabled}
              className={tcss.menuItem}
              onClick={menu.onToggleBeep}
            >
              <IconBell size={16} /> Scan sound {menu.beepEnabled ? "on" : "off"}
            </button>
            <button type="button" role="menuitem" className={tcss.menuItem} onClick={run(menu.onShortcuts)}>
              <IconKeyboard size={16} /> Keyboard shortcuts <span className={`${tcss.kbd} ${tcss.menuItemKey}`}>?</span>
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        className={`${tcss.barBtn} ${tcss.barIconBtn}${focusMode ? ` ${tcss.barBtnOn}` : ""}`}
        onClick={onToggleFocus}
        aria-pressed={focusMode}
        aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
        data-tooltip={focusMode ? "Focus mode is on — show the app's menu (Alt+F)" : "Focus mode — hide the app's menu (Alt+F)"}
      >
        <IconFocus size={17} />
      </button>
      <button
        type="button"
        className={`${tcss.barBtn} ${tcss.barIconBtn}${fullscreen.isFullscreen ? ` ${tcss.barBtnOn}` : ""}`}
        onClick={fullscreen.toggle}
        aria-pressed={fullscreen.isFullscreen}
        aria-label={fullscreen.isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        data-tooltip={fullscreen.isFullscreen ? "Exit fullscreen (Ctrl+Shift+F)" : "Fullscreen (Ctrl+Shift+F)"}
      >
        {fullscreen.isFullscreen ? <IconMinimize size={17} /> : <IconMaximize size={17} />}
      </button>
    </header>
  );
}
