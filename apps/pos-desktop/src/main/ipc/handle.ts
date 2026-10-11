import { ipcMain } from "electron";
import { ZodError } from "zod";
import { ipcContract, type IpcInput, type IpcMethod, type IpcOutput } from "../../shared/ipc-contract";
import type { Logger } from "../logging/logger";

export type IpcHandlers = {
  [M in IpcMethod]: (input: IpcInput<M>) => Promise<IpcOutput<M>> | IpcOutput<M>;
};

/**
 * Registers one handler per contract entry. Each call is checked three ways:
 * it must come from the app's own page, its input must match the contract,
 * and what goes back must match too. Anything else the renderer sees is a
 * fixed message — internal errors go to the log, not across the bridge.
 */
export function registerIpcHandlers(
  handlers: IpcHandlers,
  opts: { isTrustedSender: (url: string) => boolean; logger: Logger },
): void {
  for (const method of Object.keys(ipcContract) as IpcMethod[]) {
    const { channel, input, output } = ipcContract[method];
    const handler = handlers[method] as (input: unknown) => unknown;

    ipcMain.handle(channel, async (event, payload: unknown) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !opts.isTrustedSender(senderUrl)) {
        opts.logger.warn("ipc.rejected_sender", { channel });
        throw new Error("Not allowed.");
      }

      let parsed: unknown;
      try {
        parsed = input.parse(payload);
      } catch (error) {
        opts.logger.warn("ipc.invalid_input", { channel, issues: error instanceof ZodError ? error.issues.length : 0 });
        throw new Error("Invalid request.");
      }

      try {
        return output.parse(await handler(parsed));
      } catch (error) {
        opts.logger.error("ipc.handler_failed", { channel, error });
        throw new Error("Something went wrong. Please try again.");
      }
    });
  }
}
