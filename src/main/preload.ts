import { contextBridge, ipcRenderer } from "electron";
const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld("api", {
  selectDirectory: call("dialog:directory"),
  getTasks: call("tasks:list"),
  createTask: call("tasks:create"),
  startTask: call("tasks:start"),
  cancelTask: call("tasks:cancel"),
  deleteTask: call("tasks:delete"),
  setPriority: call("tasks:priority"),
  scanSource: call("source:scan"),
  listVolumes: call("volumes:list"),
  driveInfo: call("volumes:info"),
  ejectVolume: call("volumes:eject"),
  reveal: call("system:reveal"),
  getSettings: call("settings:get"),
  saveSettings: call("settings:save"),
  getProjects: call("projects:list"),
  saveProject: call("projects:save"),
  exportReport: call("report:export"),
  createProxy: call("proxy:create"),
  onProgress: (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("tasks:progress", listener);
    return () => ipcRenderer.removeListener("tasks:progress", listener);
  },
});
