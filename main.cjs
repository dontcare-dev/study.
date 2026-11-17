const { app, BrowserWindow, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

let db;
let mainWindow;

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
  `);
  return db;
}

function readKey() {
  try {
    const row = database().prepare("SELECT value FROM settings WHERE key='groq_key'").get();
    if (!row) return "";
    const raw = Buffer.from(row.value, "base64");
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
  } catch { return ""; }
}

function saveKey(key) {
  const raw = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key);
  database().prepare("INSERT INTO settings(key,value) VALUES('groq_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(raw.toString("base64"));
  return { saved: true, encrypted: safeStorage.isEncryptionAvailable() };
}

function getState() {
  const d = database();
  return {
    subjects: d.prepare("SELECT s.*, (SELECT COUNT(*) FROM topics t WHERE t.subject_id=s.id) topic_count, (SELECT COUNT(*) FROM questions q WHERE q.subject_id=s.id) question_count, (SELECT COUNT(*) FROM cards c WHERE c.subject_id=s.id) card_count FROM subjects s ORDER BY s.created_at DESC").all(),
    topics: d.prepare("SELECT t.*,s.name subject_name FROM topics t JOIN subjects s ON s.id=t.subject_id ORDER BY t.created_at DESC").all(),
    questions: d.prepare("SELECT * FROM questions ORDER BY created_at DESC LIMIT 500").all().map(q=>({...q,options:JSON.parse(q.options)})),
    cards: d.prepare("SELECT * FROM cards ORDER BY created_at DESC LIMIT 500").all(),
    sessions: d.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20").all(),
    keyConfigured: Boolean(readKey())
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

function groqMessages(key, messages, maxTokens=12000) {
  return fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
    body:JSON.stringify({model:"llama-3.3-70b-versatile",messages,temperature:0.35,max_tokens:maxTokens,response_format:{type:"json_object"}})
  }).then(async response=>{
    const body=await response.json();
    if(!response.ok) throw new Error(body.error?.message || "Groq request failed ("+response.status+").");
    const content=body.choices?.[0]?.message?.content;
    if(!content) throw new Error("The model returned an empty response.");
    try{return JSON.parse(content);}catch{const match=content.match(/\{[\s\S]*\}/);if(match)return JSON.parse(match[0]);throw new Error("The model response was not valid JSON.");}
  });
}

ipcMain.handle("state:get",()=>getState());
ipcMain.handle("subject:add",(_,data)=>addSubject(data));
ipcMain.handle("subject:delete",(_,id)=>{database().prepare("DELETE FROM subjects WHERE id=?").run(id);return getState();});
ipcMain.handle("topic:add",(_,data)=>addTopic(data));
ipcMain.handle("topic:delete",(_,id)=>{database().prepare("DELETE FROM topics WHERE id=?").run(id);return getState();});
ipcMain.handle("key:save",(_,key)=>saveKey(String(key || "").trim()));
ipcMain.handle("key:test",async()=>{const key=readKey();if(!key)throw new Error("Add your Groq API key first.");await groqMessages(key,[{role:"user",content:'Return JSON only: {"status":"connected"}'}],80);return {connected:true};});
ipcMain.handle("ai:generate",async(_,request)=>{
  const key=readKey();if(!key)throw new Error("Add your Groq API key in Settings before generating content.");
  const subject=String(request.subject || "General").slice(0,120);
  const topic=String(request.topic || "Full subject").slice(0,180);
  const source=String(request.source || "").slice(0,18000);
  const count=Math.max(1,Math.min(100,Number(request.count)||20));
  const mode=request.mode;
  let prompt="";
  if(mode==="questions") prompt=`Create exactly ${count} challenging exam-standard multiple-choice questions for subject: ${subject}; topic: ${topic}. Make them genuinely difficult, application-based and varied. Each question must have exactly four plausible options. Correct answer must exactly match one option. Include a concise but useful explanation. Avoid duplicates. Return JSON object: {"items":[{"question":"...","options":["...","...","...","..."],"answer":"...","explanation":"...","difficulty":"hard"}]}. Source material: ${source || "Use standard curriculum knowledge."}`;
  if(mode==="cards") prompt=`Create exactly ${count} high-value active-recall flashcards for subject: ${subject}; topic: ${topic}. Cover definitions, mechanisms, distinctions, causes, consequences, formulae and common traps where relevant. Return JSON: {"items":[{"front":"one focused question","back":"concise accurate answer"}]}. Source material: ${source || "Use standard curriculum knowledge."}`;
  if(mode==="paper") prompt=`Build a rigorous full examination paper with exactly 100 questions for subject: ${subject}; topic/syllabus: ${topic}. Make it difficult but fair, varied and curriculum-relevant. Mix MCQ, true/false, short answer and long/application questions. Include marks for every question, clear instructions, and a complete answer key with explanations or marking points. Return valid JSON: {"title":"...","duration_minutes":180,"total_marks":100,"instructions":["..."],"sections":[{"title":"...","questions":[{"type":"mcq","question":"...","options":["A...","B...","C...","D..."],"answer":"...","explanation":"...","marks":1},{"type":"short","question":"...","answer":"...","marking_points":["..."],"marks":3},{"type":"long","question":"...","answer":"...","marking_points":["..."],"marks":5},{"type":"true_false","question":"...","answer":"True","explanation":"...","marks":1}]}]}. Exactly 100 questions total across sections. Source material: ${source || "Use standard curriculum knowledge."}`;
  if(mode==="revision") prompt=`Create a complete but efficient revision guide for subject: ${subject}; topic: ${topic}. Focus on exam-relevant facts, explanations, processes, formulae, comparisons, common misconceptions and likely question angles. Return JSON: {"title":"...","overview":"...","sections":[{"heading":"...","content":"...","key_points":["..."],"exam_traps":["..."]}],"quick_recall":["..."]}. Source material: ${source || "Use standard curriculum knowledge."}`;
  const result=await groqMessages(key,[{role:"system",content:"You are a precise senior examiner and expert teacher. Never invent syllabus-specific facts. Follow the requested JSON schema exactly. Do not include markdown fences."},{role:"user",content:prompt}],mode==="paper"?16000:10000);
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
