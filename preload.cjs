const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("study",{
  getState:()=>ipcRenderer.invoke("state:get"),
  openPdf:()=>ipcRenderer.invoke("pdf:open"),
  addSubject:data=>ipcRenderer.invoke("subject:add",data),
  deleteSubject:id=>ipcRenderer.invoke("subject:delete",id),
  addTopic:data=>ipcRenderer.invoke("topic:add",data),
  deleteTopic:id=>ipcRenderer.invoke("topic:delete",id),
  saveKey:key=>ipcRenderer.invoke("key:save",key),
  testKey:()=>ipcRenderer.invoke("key:test"),
  generate:request=>ipcRenderer.invoke("ai:generate",request),
  saveSession:data=>ipcRenderer.invoke("session:save",data),
  openExternal:url=>ipcRenderer.invoke("app:openExternal",url)
});
