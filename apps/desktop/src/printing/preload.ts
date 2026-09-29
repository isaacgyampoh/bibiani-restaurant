import { contextBridge, ipcRenderer } from 'electron';

/** The only things the Printing window can ask for. */
contextBridge.exposeInMainWorld('printing', {
  status: () => ipcRenderer.invoke('printing:status'),
  scan: () => ipcRenderer.invoke('printing:scan'),
  usb: () => ipcRenderer.invoke('printing:usb'),
  refresh: () => ipcRenderer.invoke('printing:refresh'),
  test: (p: unknown) => ipcRenderer.invoke('printing:test', p),
  copy: (text: string) => ipcRenderer.invoke('printing:copy', text),
  forget: () => ipcRenderer.invoke('printing:forget'),
});
