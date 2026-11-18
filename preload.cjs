const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("study",{
  getState:()=>ipcRenderer.invoke("state:get"),
  openPdf:()=>ipcRenderer.invoke("pdf:open"),
  addSubject:data=>ipcRenderer.invoke("subject:add",data),
  deleteSubject:id=>ipcRenderer.invoke("subject:delete",id),
  addTopic:data=>ipcRenderer.invoke("topic:add",data),
  deleteTopic:id=>ipcRenderer.invoke("topic:delete",id),
  saveKey:data=>ipcRenderer.invoke("key:save",data),
  deleteKey:data=>ipcRenderer.invoke("key:delete",data),
  setProvider:provider=>ipcRenderer.invoke("provider:set",provider),
  testKey:()=>ipcRenderer.invoke("key:test"),
  openBackgroundGif:()=>ipcRenderer.invoke("background:open"),
  clearBackgroundGif:()=>ipcRenderer.invoke("background:clear"),
  generate:request=>ipcRenderer.invoke("ai:generate",request),
  saveSession:data=>ipcRenderer.invoke("session:save",data),
  openExternal:url=>ipcRenderer.invoke("app:openExternal",url)
});
