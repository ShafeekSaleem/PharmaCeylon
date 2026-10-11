/// <reference types="vite/client" />
import type { PosBridge } from "../../shared/ipc-contract";

declare global {
  interface Window {
    /** The only way out of the renderer. Defined by src/preload. */
    pos: PosBridge;
  }
}
