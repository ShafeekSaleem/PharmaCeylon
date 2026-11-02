import { contextBridge, ipcRenderer } from "electron";
import { ipcContract, type IpcMethod, type PosBridge } from "../shared/ipc-contract";

// Only the methods in the contract are exposed — never ipcRenderer itself.
// Input is validated here so a bad call fails in the renderer with a useful
// error, and again in the main process, which is the side that is trusted.
const bridge = Object.fromEntries(
  (Object.keys(ipcContract) as IpcMethod[]).map((method) => {
    const { channel, input, output } = ipcContract[method];
    return [
      method,
      async (payload?: unknown) => {
        const parsed = input.safeParse(payload);
        // The same message main uses, so the renderer can tell bad input from a failure.
        if (!parsed.success) throw new Error("Invalid request.");
        return output.parse(await ipcRenderer.invoke(channel, parsed.data));
      },
    ];
  }),
) as unknown as PosBridge;

contextBridge.exposeInMainWorld("pos", bridge);
