import { detectRemoteTools, parseTasklist } from "./remote-tools";

describe("remote-control tool detection", () => {
  it("reads image names from tasklist's CSV output", () => {
    const csv =
      '"System Idle Process","0","Services","0","8 K"\r\n' +
      '"AnyDesk.exe","4120","Console","1","31,204 K"\r\n' +
      '"remoting_host.exe","5532","Services","0","12,000 K"\r\n\r\n';
    expect(parseTasklist(csv)).toEqual(["System Idle Process", "AnyDesk.exe", "remoting_host.exe"]);
  });

  it("names each tool once, whatever the case of its process name", () => {
    expect(detectRemoteTools(["AnyDesk.exe", "TeamViewer.exe", "TeamViewer_Service.exe"])).toEqual([
      "AnyDesk",
      "TeamViewer",
    ]);
    expect(detectRemoteTools(["remoting_host.exe", "winvnc.exe", "RustDesk.exe"])).toEqual([
      "Chrome Remote Desktop",
      "RustDesk",
      "VNC",
    ]);
  });

  it("finds nothing on an ordinary counter", () => {
    expect(detectRemoteTools(["explorer.exe", "chrome.exe", "Curalio POS.exe", "svchost.exe"])).toEqual([]);
  });
});
