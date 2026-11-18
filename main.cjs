const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require("electron");
const pdfParse = require("pdf-parse");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

let db;
let mainWindow;
let keyCursor={groq:0,gemini:0};

function database() {
  if (db) return db;
  const file = path.join(app.getPath("userData"), "study.sqlite");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#b9a2ff', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE, prompt TEXT NOT NULL, options TEXT NOT NULL, answer TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '', difficulty TEXT NOT NULL DEFAULT 'hard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE, front TEXT NOT NULL, back TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject_id INTEGER, score INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'groq', label TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  databaseLegacyKeyMigration(db);
  return db;
}

function decodeStoredKey(value) {
  const raw=Buffer.from(value,"base64");
  return safeStorage.isEncryptionAvailable()?safeStorage.decryptString(raw):raw.toString("utf8");
}

function databaseLegacyKeyMigration(d) {
  const legacy=d.prepare("SELECT value FROM settings WHERE key='groq_key'").get();
  if(legacy){if(!d.prepare("SELECT id FROM api_keys LIMIT 1").get())d.prepare("INSERT INTO api_keys(provider,label,value) VALUES('groq','Imported Groq key',?)").run(legacy.value);d.prepare("DELETE FROM settings WHERE key='groq_key'").run();}
}

function readKeys(provider="groq") {
  try{return database().prepare("SELECT id,label,value FROM api_keys WHERE provider=? ORDER BY id").all(provider).map(row=>({...row,key:decodeStoredKey(row.value)})).filter(row=>row.key);}catch{return [];}
}

function saveKey(provider,key,label) {
  if(!["groq","gemini"].includes(provider))throw new Error("Choose a supported AI provider.");
  const value=String(key||"").trim();if(!value)throw new Error("Enter an API key.");
  const name=String(label||"").trim().slice(0,60)||provider.toUpperCase()+" key "+(readKeys(provider).length+1);
  const raw=safeStorage.isEncryptionAvailable()?safeStorage.encryptString(value):Buffer.from(value);
  const result=database().prepare("INSERT INTO api_keys(provider,label,value) VALUES(?,?,?)").run(provider,name,raw.toString("base64"));
  return {saved:true,id:Number(result.lastInsertRowid),label:name,provider,encrypted:safeStorage.isEncryptionAvailable()};
}

function deleteKey(provider,id){database().prepare("DELETE FROM api_keys WHERE id=? AND provider=?").run(Number(id),provider);return {keys:readKeys(provider).map(({id,label})=>({id,label,provider}))};}

function applyBackgroundGif(data){
  if(data===null){database().prepare("DELETE FROM settings WHERE key='background_gif'").run();return {backgroundGif:null};}
  const match=String(data||"").match(/^data:image\/gif;base64,([A-Za-z0-9+/=]+)$/);if(!match)throw new Error("Choose a valid GIF image.");
  if(Buffer.from(match[1],"base64").length>15*1024*1024)throw new Error("GIF must be 15 MB or smaller.");
  database().prepare("INSERT INTO settings(key,value) VALUES('background_gif',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(data);return {backgroundGif:data};
}

function getState() {
  const d = database();
  return {
    subjects: d.prepare("SELECT s.*, (SELECT COUNT(*) FROM topics t WHERE t.subject_id=s.id) topic_count, (SELECT COUNT(*) FROM questions q WHERE q.subject_id=s.id) question_count, (SELECT COUNT(*) FROM cards c WHERE c.subject_id=s.id) card_count FROM subjects s ORDER BY s.created_at DESC").all(),
    topics: d.prepare("SELECT t.*,s.name subject_name FROM topics t JOIN subjects s ON s.id=t.subject_id ORDER BY t.created_at DESC").all(),
    questions: d.prepare("SELECT * FROM questions ORDER BY created_at DESC LIMIT 500").all().map(q=>({...q,options:JSON.parse(q.options)})),
    cards: d.prepare("SELECT * FROM cards ORDER BY created_at DESC LIMIT 500").all(),
    sessions: d.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20").all(),
    keyConfigured: readKeys("groq").length+readKeys("gemini").length>0,
    apiKeys: ["groq","gemini"].flatMap(provider=>readKeys(provider).map(({id,label})=>({id,label,provider}))),
    activeProvider: d.prepare("SELECT value FROM settings WHERE key='active_provider'").get()?.value || "gemini",
    backgroundGif: d.prepare("SELECT value FROM settings WHERE key='background_gif'").get()?.value || null
  };
}

function addSubject({name,color}) {
  const value = String(name || "").trim();
  if (!value) throw new Error("Enter a subject name.");
  const result = database().prepare("INSERT INTO subjects(name,color) VALUES(?,?)").run(value, color || "#b9a2ff");
  return {id:Number(result.lastInsertRowid),name:value,color:color || "#b9a2ff"};
}

function addTopic({subjectId,name,notes}) {
  const value = String(name || "").trim();
  if (!value || !database().prepare("SELECT id FROM subjects WHERE id=?").get(subjectId)) throw new Error("Choose a subject and enter a topic.");
  const result = database().prepare("INSERT INTO topics(subject_id,name,notes) VALUES(?,?,?)").run(subjectId,value,String(notes || ""));
  return {id:Number(result.lastInsertRowid),subject_id:subjectId,name:value,notes:String(notes || "")};
}

function saveGenerated({kind,subjectId,topicId,items}) {
  const d=database();
  const tx=d.transaction(()=>{
    if(kind==="questions"){
      const insert=d.prepare("INSERT INTO questions(topic_id,subject_id,prompt,options,answer,explanation,difficulty) VALUES(?,?,?,?,?,?,?)");
      for(const q of items) insert.run(topicId || null,subjectId || null,String(q.question || q.prompt || ""),JSON.stringify(q.options || []),String(q.answer || ""),String(q.explanation || ""),String(q.difficulty || "hard"));
    } else {
      const insert=d.prepare("INSERT INTO cards(topic_id,subject_id,front,back) VALUES(?,?,?,?)");
      for(const c of items) insert.run(topicId || null,subjectId || null,String(c.front || ""),String(c.back || ""));
    }
  });
  tx();
  return {saved:items.length};
}

function parseAiJson(content){
  if(!content)throw new Error("The model returned an empty response.");
  try{return JSON.parse(content);}catch{const match=content.match(/\{[\s\S]*\}/);if(match)return JSON.parse(match[0]);throw new Error("The model response was not valid JSON.");}
}

async function geminiGenerate(key,messages,maxTokens=16000){
  const system=messages.find(m=>m.role==="system")?.content||"";
  const prompt=messages.filter(m=>m.role!=="system").map(m=>m.content).join("\n\n");
  const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key="+encodeURIComponent(key),{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:maxTokens,temperature:0.35}})
  });
  const body=await response.json();
  if(!response.ok)throw new Error(body.error?.message||"Gemini request failed ("+response.status+").");
  return parseAiJson(body.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join(""));
}

function groqMessages(key, messages, maxTokens=12000) {
  return fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
    body:JSON.stringify({model:"openai/gpt-oss-120b",messages,temperature:0.35,max_completion_tokens:maxTokens,response_format:{type:"json_object"}})
  }).then(async response=>{
    const body=await response.json();
    if(!response.ok) throw new Error(body.error?.message || "Groq request failed ("+response.status+").");
    const content=body.choices?.[0]?.message?.content;
    if(!content) throw new Error("The model returned an empty response.");
    return parseAiJson(content);
  });
}

ipcMain.handle("state:get",()=>getState());
ipcMain.handle("pdf:open",async()=>{
  const result=await dialog.showOpenDialog(mainWindow,{title:"Choose a study PDF",properties:["openFile"],filters:[{name:"PDF documents",extensions:["pdf"]}]});
  if(result.canceled||!result.filePaths.length)return {canceled:true};
  const file=result.filePaths[0];
  const buffer=fs.readFileSync(file);
  if(buffer.subarray(0,5).toString("ascii")!=="%PDF-")throw new Error("The selected file is not a valid PDF.");
  const parsed=await pdfParse(buffer);
  const fullText=String(parsed.text||"").replace(/\r\n?/g,"\n").trim();
  if(!fullText)throw new Error("No selectable text was found. This PDF may contain scanned pages; OCR is not available yet.");
  return {canceled:false,name:path.basename(file),pages:parsed.numpages||0,text:fullText,truncated:false,totalChars:fullText.length};
});
ipcMain.handle("subject:add",(_,data)=>addSubject(data));
ipcMain.handle("subject:delete",(_,id)=>{database().prepare("DELETE FROM subjects WHERE id=?").run(id);return getState();});
ipcMain.handle("topic:add",(_,data)=>addTopic(data));
ipcMain.handle("topic:delete",(_,id)=>{database().prepare("DELETE FROM topics WHERE id=?").run(id);return getState();});
ipcMain.handle("key:save",(_,data)=>saveKey(data.provider,data.key,data.label));
ipcMain.handle("key:delete",(_,data)=>deleteKey(data.provider,data.id));
ipcMain.handle("provider:set",(_,provider)=>{if(!["groq","gemini"].includes(provider))throw new Error("Unsupported AI provider.");database().prepare("INSERT INTO settings(key,value) VALUES('active_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(provider);return {activeProvider:provider};});
ipcMain.handle("key:test",async()=>{let last;for(const provider of ["gemini","groq"]){for(const item of readKeys(provider)){try{const messages=[{role:"system",content:"Return valid JSON only."},{role:"user",content:'Return {"status":"connected"}'}];if(provider==="gemini")await geminiGenerate(item.key,messages,80);else await groqMessages(item.key,messages,80);return {connected:true,label:item.label,provider};}catch(e){last=e;}}}throw last||new Error("Add a Gemini or Groq API key first.");});
ipcMain.handle("background:open",async()=>{const result=await dialog.showOpenDialog(mainWindow,{title:"Choose an animated GIF",properties:["openFile"],filters:[{name:"GIF images",extensions:["gif"]}]});if(result.canceled||!result.filePaths.length)return {canceled:true};const buffer=fs.readFileSync(result.filePaths[0]);const sig=buffer.subarray(0,6).toString("ascii");if(sig!=="GIF87a"&&sig!=="GIF89a")throw new Error("The selected file is not a valid GIF.");if(buffer.length>15*1024*1024)throw new Error("GIF must be 15 MB or smaller.");return applyBackgroundGif("data:image/gif;base64,"+buffer.toString("base64"));});
ipcMain.handle("background:clear",()=>applyBackgroundGif(null));
ipcMain.handle("ai:generate",async(_,request)=>{
  const provider=database().prepare("SELECT value FROM settings WHERE key='active_provider'").get()?.value || "gemini";
  const keys=readKeys(provider);if(!keys.length)throw new Error("Add a "+(provider==="gemini"?"Gemini":"Groq")+" API key in Settings, or switch providers.");
  const subject=String(request.subject || "General").slice(0,120);
  const topic=String(request.topic || "Full subject").slice(0,180);
  const source=String(request.source || "");
  const count=Math.max(1,Math.min(100,Number(request.count)||20));
  const mode=request.mode;
  let prompt="";
  if(mode==="questions") prompt=`Create exactly ${count} challenging exam-standard multiple-choice questions for subject: ${subject}; topic: ${topic}. Make them genuinely difficult, application-based and varied. Each question must have exactly four plausible options. Correct answer must exactly match one option. Include a concise but useful explanation. Avoid duplicates. Return JSON object: {"items":[{"question":"...","options":["...","...","...","..."],"answer":"...","explanation":"...","difficulty":"hard"}]}. Source material: ${source || "Use standard curriculum knowledge."}`;
  if(mode==="cards") prompt=`Create exactly ${count} high-value active-recall flashcards for subject: ${subject}; topic: ${topic}. Cover definitions, mechanisms, distinctions, causes, consequences, formulae and common traps where relevant. Return JSON: {"items":[{"front":"one focused question","back":"concise accurate answer"}]}. Source material: ${source || "Use standard curriculum knowledge."}`;
  if(mode==="paper") prompt=`Build a rigorous full examination paper with exactly 100 questions for subject: ${subject}; topic/syllabus: ${topic}. Make it difficult but fair, varied and curriculum-relevant. Mix MCQ, true/false, short answer and long/application questions. Include marks for every question, clear instructions, and a complete answer key with explanations or marking points. Return valid JSON: {"title":"...","duration_minutes":180,"total_marks":100,"instructions":["..."],"sections":[{"title":"...","questions":[{"type":"mcq","question":"...","options":["A...","B...","C...","D..."],"answer":"...","explanation":"...","marks":1},{"type":"short","question":"...","answer":"...","marking_points":["..."],"marks":3},{"type":"long","question":"...","answer":"...","marking_points":["..."],"marks":5},{"type":"true_false","question":"...","answer":"True","explanation":"...","marks":1}]}]}. Exactly 100 questions total across sections. Source material: ${source || "Use standard curriculum knowledge."}`;
  if(mode==="revision") prompt=`Create a complete but efficient revision guide for subject: ${subject}; topic: ${topic}. Focus on exam-relevant facts, explanations, processes, formulae, comparisons, common misconceptions and likely question angles. Return JSON: {"title":"...","overview":"...","sections":[{"heading":"...","content":"...","key_points":["..."],"exam_traps":["..."]}],"quick_recall":["..."]}. Source material: ${source || "Use standard curriculum knowledge."}`;
  const messages=[{role:"system",content:"You are a precise senior examiner and expert teacher. Never invent syllabus-specific facts. Follow the requested JSON schema exactly. Do not include markdown fences."},{role:"user",content:prompt}];
  let result,lastError;const cursor=keyCursor[provider]||0;const ordered=keys.slice(cursor).concat(keys.slice(0,cursor));
  for(const item of ordered){try{result=provider==="gemini"?await geminiGenerate(item.key,messages,mode==="paper"?24000:16000):await groqMessages(item.key,messages,mode==="paper"?16000:10000);keyCursor[provider]=(keys.findIndex(k=>k.id===item.id)+1)%keys.length;break;}catch(error){lastError=error;}}
  if(!result)throw lastError||new Error("All Groq API keys failed.");
  if((mode==="questions"||mode==="cards")&&Array.isArray(result.items)) saveGenerated({kind:mode==="questions"?"questions":"cards",subjectId:request.subjectId,topicId:request.topicId,items:result.items});
  return result;
});
ipcMain.handle("session:save",(_,data)=>{database().prepare("INSERT INTO sessions(kind,subject_id,score,total) VALUES(?,?,?,?)").run(data.kind,data.subjectId||null,Number(data.score)||0,Number(data.total)||0);return true;});
ipcMain.handle("app:openExternal",(_,url)=>{if(/^https:\/\//.test(url))return shell.openExternal(url);return false;});

function createWindow(){
  mainWindow=new BrowserWindow({width:1440,height:940,minWidth:1080,minHeight:720,backgroundColor:"#070709",title:"Study",autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,"preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  mainWindow.loadFile(path.join(__dirname,"renderer","index.html"));
}
app.whenReady().then(()=>{database();createWindow();app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit();});
app.on("before-quit",()=>{if(db){db.close();db=null;}});
