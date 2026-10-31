import type { WindowsSessionEvidence } from "@pharmaceylon/shared";

/** What the Windows APIs reported about the session this process runs in. */
export type WindowsSessionFacts = {
  /** ProcessIdToSessionId(GetCurrentProcessId()). */
  processSessionId: number;
  /** WTSGetActiveConsoleSessionId(); 0xFFFFFFFF when no session is attached to the console. */
  activeConsoleSessionId: number;
  /** GetSystemMetrics(SM_REMOTESESSION) !== 0. */
  remoteSessionMetric: boolean;
  /** WTSQuerySessionInformation(WTSClientProtocolType): 0 console, 1 ICA, 2 RDP; null if unreadable. */
  clientProtocol: number | null;
};

const NO_CONSOLE_SESSION = 0xffffffff;
const MAX_SESSION_ID = 2_147_483_647;

/**
 * Only a positive identification of the physical console session is `console`: the process is in
 * the session attached to the console, Windows says it is not remote, and the client protocol is
 * the console. RDP is `rdp`. Anything else, including a failed or partial read, is `unknown`,
 * which the server refuses. Remote-control tools that drive the console session (AnyDesk,
 * TeamViewer, Chrome Remote Desktop) look like the console here; that limit is documented.
 */
export function classifyWindowsSession(facts: WindowsSessionFacts | null): WindowsSessionEvidence {
  if (!facts) return { sessionId: 0, protocol: "unknown", remoteSession: false };
  const sessionId =
    Number.isSafeInteger(facts.processSessionId) && facts.processSessionId >= 0 && facts.processSessionId <= MAX_SESSION_ID
      ? facts.processSessionId
      : 0;
  const remoteSession = facts.remoteSessionMetric || facts.clientProtocol === 1 || facts.clientProtocol === 2;
  if (facts.clientProtocol === 2) return { sessionId, protocol: "rdp", remoteSession: true };
  const onConsole =
    facts.clientProtocol === 0 &&
    !remoteSession &&
    facts.activeConsoleSessionId !== NO_CONSOLE_SESSION &&
    facts.processSessionId === facts.activeConsoleSessionId;
  return { sessionId, protocol: onConsole ? "console" : "unknown", remoteSession };
}

type Reader = () => WindowsSessionFacts | null;

/**
 * Reads the facts straight from user32/kernel32/wtsapi32 through koffi: no shell, no environment
 * variables (SESSIONNAME is trivially set by anyone). Any failure reads as null → `unknown`.
 */
export function createWindowsSessionReader(platform: NodeJS.Platform = process.platform): Reader {
  if (platform !== "win32") return () => null;
  let bound: Reader | null = null;
  return () => {
    try {
      bound ??= bindWin32();
      return bound();
    } catch {
      return null;
    }
  };
}

function bindWin32(): Reader {
  // Loaded lazily so non-Windows tests and tooling never touch the native module.
  const koffi = require("koffi") as typeof import("koffi");
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const wtsapi32 = koffi.load("wtsapi32.dll");
  const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int nIndex)");
  const GetCurrentProcessId = kernel32.func("uint32_t __stdcall GetCurrentProcessId()");
  const ProcessIdToSessionId = kernel32.func("bool __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *sid)");
  const WTSGetActiveConsoleSessionId = kernel32.func("uint32_t __stdcall WTSGetActiveConsoleSessionId()");
  const WTSQuerySessionInformationW = wtsapi32.func(
    "bool __stdcall WTSQuerySessionInformationW(void *server, uint32_t session, int infoClass, _Out_ void **buffer, _Out_ uint32_t *bytes)",
  );
  const WTSFreeMemory = wtsapi32.func("void __stdcall WTSFreeMemory(void *memory)");
  const SM_REMOTESESSION = 0x1000;
  const WTS_CURRENT_SESSION = 0xffffffff;
  const WTSClientProtocolType = 16;

  return () => {
    const sid = [0];
    if (!ProcessIdToSessionId(GetCurrentProcessId(), sid)) return null;
    const buffer: unknown[] = [null];
    const bytes = [0];
    let clientProtocol: number | null = null;
    if (WTSQuerySessionInformationW(null, WTS_CURRENT_SESSION, WTSClientProtocolType, buffer, bytes)) {
      try {
        if ((bytes[0] ?? 0) >= 2 && buffer[0]) clientProtocol = koffi.decode(buffer[0], "uint16_t") as number;
      } finally {
        WTSFreeMemory(buffer[0]);
      }
    }
    return {
      processSessionId: sid[0] as number,
      activeConsoleSessionId: WTSGetActiveConsoleSessionId() as number,
      remoteSessionMetric: (GetSystemMetrics(SM_REMOTESESSION) as number) !== 0,
      clientProtocol,
    };
  };
}
