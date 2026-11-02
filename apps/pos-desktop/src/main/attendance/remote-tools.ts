import { execFile } from "node:child_process";

/**
 * Remote-control tools that drive the physical console session, which Windows reports as local.
 * Seeing one running narrows the risk the v1 attendance decision accepts: it stops the casual
 * "approve it from home over AnyDesk" case. It is not a security boundary (a determined
 * administrator can rename a process), so the documented limits still apply.
 */
const REMOTE_TOOLS: ReadonlyArray<{ name: string; images: readonly string[] }> = [
  { name: "AnyDesk", images: ["anydesk.exe"] },
  { name: "TeamViewer", images: ["teamviewer.exe", "teamviewer_service.exe", "tv_w32.exe", "tv_x64.exe"] },
  { name: "Chrome Remote Desktop", images: ["remoting_host.exe", "remoting_desktop.exe"] },
  { name: "RustDesk", images: ["rustdesk.exe"] },
  { name: "Splashtop", images: ["srserver.exe", "srservice.exe", "strwinclt.exe"] },
  { name: "VNC", images: ["winvnc.exe", "tvnserver.exe", "vncserver.exe", "uvnc_service.exe"] },
  { name: "Supremo", images: ["supremo.exe", "supremoservice.exe"] },
  { name: "LogMeIn", images: ["logmein.exe", "lmiguardiansvc.exe"] },
];

/** Names of the remote-control tools among these running process images. */
export function detectRemoteTools(images: readonly string[]): string[] {
  const running = new Set(images.map((i) => i.trim().toLowerCase()));
  return REMOTE_TOOLS.filter((tool) => tool.images.some((image) => running.has(image))).map(
    (tool) => tool.name,
  );
}

/** Image names from `tasklist /fo csv /nh` output: the first quoted column of each row. */
export function parseTasklist(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .map((line) => /^"([^"]+)"/.exec(line.trim())?.[1])
    .filter((image): image is string => Boolean(image));
}

/** Running process image names on Windows. Elsewhere (development, tests) there are none. */
export function listProcessImages(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile(
      "tasklist.exe",
      ["/fo", "csv", "/nh"],
      { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(parseTasklist(stdout))),
    );
  });
}
