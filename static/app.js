const $ = id => document.getElementById(id);
let chats = [], selectedId = null, currentChat = null;
const collapsedProjects = new Set();
const RECENT_PATHS_KEY = "claudeChatViewer.recentPaths.v1";
const LANGUAGE_KEY = "claudeChatViewer.language.v1";
const MAX_RECENT_PATHS = 12;
let language = localStorage.getItem(LANGUAGE_KEY) === "en" ? "en" : "ru";
let lastScanInfo = null;

const I18N = {
  ru: {
    subtitle:"Локальная история диалогов", recentFolders:"Недавние папки", recentFoldersOption:"Недавние папки…",
    pathPlaceholder:"Путь к ~/.claude или папке projects", scan:"Найти чаты", scanning:"Сканирую…",
    conversations:"Диалоги", searchPlaceholder:"Поиск по диалогам...",
    initialEmpty:"Локальные чаты появятся здесь. Для просмотра исходных чатов укажи папку Claude сверху.",
    welcomeTitle:"История диалогов Claude", welcomeText:"Выбери диалог слева, чтобы открыть переписку.",
    saveChat:"Сохранить чат", copyHistory:"Скопировать историю", localChats:"Локальные чаты", noProject:"Без проекта",
    nothingFound:"Ничего не найдено.", saveMore:"Добавить новые", saveThis:"Сохранить чат",
    saveTitleAdded:"Добавить новые сообщения в локальный чат проекта", saveTitleNew:"Сохранить этот чат в локальную историю проекта",
    saving:"Сохраняю…", tool:"Инструмент", inputData:"Входные данные", result:"Результат", error:"ошибка",
    noDetails:"Нет подробностей", collapsedTools:"Свернуто вызовов инструментов: {n}", show:"Показать",
    you:"Вы", localHistory:"локальная история", selectPath:"Сначала укажи путь к папке.",
    scanError:"Не удалось просканировать папку.", chatCount:"В списке чатов: {n}",
    sourceInfo:"Источник: {path} · исходных чатов: {source} · локальных чатов: {local}",
    openError:"Не удалось открыть диалог.", saveError:"Не удалось сохранить чат.",
    alreadyLocal:"Это уже локальный чат проекта.", createdLocal:"Создан локальный чат", appendedLocal:"Добавлено в локальный чат",
    noNew:"Новых сообщений для добавления нет.", savedElements:"{verb}: {n} элементов", localFile:"Локальный файл проекта: {path}",
    deleteConfirm:"Удалить это сообщение из локальной истории?", deleteError:"Не удалось удалить сообщение.",
    deleted:"Сообщение удалено из локальной истории.", copyError:"Не удалось скопировать историю.",
    copied:"Скопировано сообщений: {n}", browserCopyError:"Браузер не разрешил копирование.",
    noDate:"не указана", author:"Автор", date:"Дата", text:"Текст", claude:"Claude",
    localOnlyEmpty:"Локальных чатов пока нет. Сохрани любой исходный чат, чтобы он появился здесь.",
    localChatSuffix:"локальная история", toolDelete:"Удалить вызов", messageDelete:"Удалить сообщение"
  },
  en: {
    subtitle:"Local conversation archive", recentFolders:"Recent folders", recentFoldersOption:"Recent folders…",
    pathPlaceholder:"Path to ~/.claude or the projects folder", scan:"Find chats", scanning:"Scanning…",
    conversations:"Conversations", searchPlaceholder:"Search conversations...",
    initialEmpty:"Saved local chats will appear here. To browse source chats, enter a Claude folder above.",
    welcomeTitle:"Claude conversation history", welcomeText:"Select a conversation on the left to open it.",
    saveChat:"Save chat", copyHistory:"Copy history", localChats:"Local chats", noProject:"No project",
    nothingFound:"No matches found.", saveMore:"Add new", saveThis:"Save chat",
    saveTitleAdded:"Add new messages to the project's local chat", saveTitleNew:"Save this chat to the project's local archive",
    saving:"Saving…", tool:"Tool", inputData:"Input", result:"Result", error:"error",
    noDetails:"No details", collapsedTools:"Collapsed {n} tool calls", show:"Show",
    you:"You", localHistory:"local archive", selectPath:"Enter a folder path first.",
    scanError:"Could not scan the folder.", chatCount:"Chats in list: {n}",
    sourceInfo:"Source: {path} · source chats: {source} · local chats: {local}",
    openError:"Could not open the conversation.", saveError:"Could not save the chat.",
    alreadyLocal:"This is already a local project chat.", createdLocal:"Local chat created", appendedLocal:"Added to local chat",
    noNew:"There are no new messages to add.", savedElements:"{verb}: {n} items", localFile:"Project archive: {path}",
    deleteConfirm:"Delete this message from the local archive?", deleteError:"Could not delete the message.",
    deleted:"Message deleted from the local archive.", copyError:"Could not copy the history.",
    copied:"Copied messages: {n}", browserCopyError:"The browser did not allow copying.",
    noDate:"not specified", author:"Author", date:"Date", text:"Text", claude:"Claude",
    localOnlyEmpty:"There are no local chats yet. Save any source chat to make it appear here.",
    localChatSuffix:"local archive", toolDelete:"Delete tool call", messageDelete:"Delete message"
  }
};
function t(key, vars = {}) {
  let value = I18N[language][key] ?? I18N.ru[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}
function applyLanguage() {
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  $("languageSelect").value = language;
  const selectedRecentPath = $("recentPathsSelect").value;
  renderRecentPaths();
  if (selectedRecentPath) $("recentPathsSelect").value = selectedRecentPath;
  renderList();
  if (lastScanInfo) {
    $("scanInfo").textContent = lastScanInfo.kind === "scan"
      ? t("sourceInfo", lastScanInfo.data)
      : t("localFile", lastScanInfo.data);
  }
  if (currentChat) {
    $("conversationTitle").textContent = currentChat.is_local ? `${currentChat.title} · ${t("localHistory")}` : currentChat.title;
    if (currentChat.messages) renderConversation(currentChat.messages);
  }
}

function getRecentPaths() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_PATHS_KEY) || "[]");
    return Array.isArray(value) ? value.filter(v => typeof v === "string" && v.trim()) : [];
  } catch (_) { return []; }
}
function renderRecentPaths() {
  const paths = getRecentPaths();
  $("recentPathsSelect").innerHTML = `<option value="">${escapeHtml(t("recentFoldersOption"))}</option>` +
    paths.map(path => `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`).join("");
  $("recentPaths").innerHTML = paths.map(path => `<option value="${escapeHtml(path)}"></option>`).join("");
}
function rememberPath(path) {
  try {
    const normalized = path.trim();
    const paths = [normalized, ...getRecentPaths().filter(item => item !== normalized)].slice(0, MAX_RECENT_PATHS);
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(paths));
    renderRecentPaths();
  } catch (_) { /* Browser storage is optional. */ }
}
function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3000);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString(language === "en" ? "en-GB" : "ru-RU");
}
function updateCount() { $("chatCount").textContent = chats.length; }

function renderList() {
  const query = $("searchInput").value.trim().toLowerCase();
  const filtered = chats.filter(c => `${c.title} ${c.project} ${c.preview || ""}`.toLowerCase().includes(query));
  const localChats = filtered.filter(c => c.is_local);
  const sourceChats = filtered.filter(c => !c.is_local);
  const groups = new Map();
  for (const chat of sourceChats) {
    const name = chat.project || t("noProject");
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(chat);
  }
  for (const items of groups.values()) {
    items.sort((a, b) => (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0) || String(a.title || "").localeCompare(String(b.title || ""), language === "en" ? "en" : "ru"));
  }

  if (!filtered.length) {
    $("chatList").innerHTML = `<div class="empty-state">${escapeHtml(chats.length ? t("nothingFound") : t("initialEmpty"))}</div>`;
    return;
  }
  let html = "";
  if (localChats.length) {
    html += `<section class="local-section"><div class="sidebar-section-title">${escapeHtml(t("localChats"))} <span>${localChats.length}</span></div>
      <div class="local-chat-list">${localChats.map(c => `<button type="button" class="chat-item local-chat-item ${c.id===selectedId?"active":""}" data-id="${escapeHtml(c.id)}" title="${escapeHtml(c.title)}"><span class="local-chat-mark">●</span><span class="chat-name">${escapeHtml(c.title)}</span></button>`).join("")}</div></section>`;
  }
  html += [...groups.entries()].map(([project, items]) => {
    const collapsed = collapsedProjects.has(project);
    return `<section class="project-group"><button class="project-heading ${collapsed?"collapsed":""}" type="button" data-project="${escapeHtml(project)}"><span class="project-chevron">${collapsed?"›":"⌄"}</span><span class="project-title">${escapeHtml(project)}</span><span class="project-count">${items.length}</span></button>
      ${collapsed ? "" : `<div class="project-chats">${items.map(c => `<div class="source-chat-row"><button type="button" class="chat-item ${c.id===selectedId?"active":""}" data-id="${escapeHtml(c.id)}" title="${escapeHtml(c.title)}"><span class="chat-name">${escapeHtml(c.title)}</span></button><button type="button" class="save-chat-btn ${c.in_local?"in-local":""}" data-save-id="${escapeHtml(c.id)}" title="${escapeHtml(c.in_local?t("saveTitleAdded"):t("saveTitleNew"))}">${escapeHtml(c.in_local?t("saveMore"):t("saveThis"))}</button></div>`).join("")}</div>`}
    </section>`;
  }).join("");
  $("chatList").innerHTML = html;
  $("chatList").querySelectorAll(".project-heading").forEach(el => el.addEventListener("click", () => {
    const project = el.dataset.project;
    if (collapsedProjects.has(project)) collapsedProjects.delete(project); else collapsedProjects.add(project);
    renderList();
  }));
  $("chatList").querySelectorAll(".chat-item").forEach(el => el.addEventListener("click", () => openChat(el.dataset.id)));
  $("chatList").querySelectorAll(".save-chat-btn").forEach(el => el.addEventListener("click", () => saveChat(el.dataset.saveId, el)));
}

async function loadLocalChats() {
  try {
    const response = await fetch("/api/local-chats");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t("openError"));
    const localChats = data.chats || [];
    const sourceChats = chats.filter(chat => !chat.is_local);
    chats = [...localChats, ...sourceChats];
    updateCount();
    renderList();
    if (!sourceChats.length && !localChats.length) $("chatList").innerHTML = `<div class="empty-state">${escapeHtml(t("initialEmpty"))}</div>`;
  } catch (_) {
    // The local archive remains optional; source scanning can still be used.
  }
}

async function scan() {
  const path = $("folderPath").value.trim();
  if (!path) return toast(t("selectPath"));
  $("scanBtn").disabled = true; $("scanBtn").textContent = t("scanning");
  try {
    const response = await fetch("/api/scan", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({path})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t("scanError"));
    chats = data.chats || []; selectedId = null; currentChat = null; collapsedProjects.clear();
    rememberPath(path);
    $("recentPathsSelect").value = path;
    updateCount();
    lastScanInfo = {kind:"scan", data:{path:data.projects_dir, source:data.source_count, local:data.local_count}};
    $("scanInfo").textContent = t("sourceInfo", lastScanInfo.data);
    $("welcome").classList.remove("hidden"); $("conversationActions").classList.add("hidden");
    $("messages").classList.add("hidden"); $("messages").innerHTML = "";
    renderList(); toast(t("chatCount", {n:data.count}));
  } catch (e) { toast(e.message); }
  finally { $("scanBtn").disabled = false; $("scanBtn").textContent = t("scan"); }
}

function toolDetailsMarkup(tool) {
  const name = escapeHtml(tool.tool_name || t("tool"));
  const input = tool.tool_input == null ? "" : (typeof tool.tool_input === "string" ? tool.tool_input : JSON.stringify(tool.tool_input, null, 2));
  const result = tool.tool_result || "";
  const details = [input ? `<div class="tool-section"><div class="tool-section-label">${escapeHtml(t("inputData"))}</div><pre>${escapeHtml(input)}</pre></div>` : "", result ? `<div class="tool-section"><div class="tool-section-label">${escapeHtml(t("result"))}${tool.tool_error?` · ${escapeHtml(t("error"))}`:""}</div><pre>${escapeHtml(result)}</pre></div>` : ""].filter(Boolean).join("");
  const time = formatTime(tool.timestamp);
  return `<div class="tool-entry" data-message-id="${escapeHtml(tool.id)}"><div class="tool-entry-heading"><span>⚙ ${name}</span><button class="delete-message-btn" type="button" data-delete-id="${escapeHtml(tool.id)}" title="${escapeHtml(t("toolDelete"))}">×</button></div>${details || `<div class="tool-no-details">${escapeHtml(t("noDetails"))}</div>`}${time?`<div class="tool-time">${escapeHtml(time)}</div>`:""}</div>`;
}
function renderConversation(messages) {
  const output = [];
  for (let i=0; i<messages.length;) {
    const message = messages[i];
    if (message.role === "tool") {
      let j=i; while (j<messages.length && messages[j].role === "tool") j++;
      const run=messages.slice(i,j);
      if (run.length>=2) output.push(`<details class="tool-run"><summary><span>⚙ ${escapeHtml(t("collapsedTools",{n:run.length}))}</span><span class="tool-run-hint">${escapeHtml(t("show"))}</span></summary><div class="tool-run-content">${run.map(toolDetailsMarkup).join("")}</div></details>`);
      else output.push(`<details class="tool-single"><summary>⚙ ${escapeHtml(message.tool_name || t("tool"))}</summary>${toolDetailsMarkup(message)}</details>`);
      i=j; continue;
    }
    const isUser=message.role === "user", role=isUser?"user":"assistant", time=formatTime(message.timestamp);
    output.push(`<article class="message ${role}" data-message-id="${escapeHtml(message.id)}" title="${escapeHtml(time)}"><div class="message-inner"><div class="message-topline">${isUser?`<div class="role-label">${escapeHtml(t("you"))}</div>`:""}<button class="delete-message-btn" type="button" data-delete-id="${escapeHtml(message.id)}" title="${escapeHtml(t("messageDelete"))}">×</button></div><div class="bubble markdown-body">${message.html || escapeHtml(message.text || "")}</div>${time?`<div class="message-time">${escapeHtml(time)}</div>`:""}</div></article>`);
    i++;
  }
  $("messages").innerHTML=output.join("") || `<div class="empty-state conversation-empty">${escapeHtml(t("noDetails"))}</div>`;
  $("messages").querySelectorAll(".delete-message-btn").forEach(button => button.addEventListener("click",()=>deleteMessage(button.dataset.deleteId,button)));
}

async function openChat(id) {
  try {
    const response=await fetch(`/api/chat/${id}`), data=await response.json();
    if (!response.ok) throw new Error(data.error || t("openError"));
    selectedId=id; currentChat=data; renderList();
    $("welcome").classList.add("hidden"); $("conversationActions").classList.remove("hidden");
    $("conversationTitle").textContent=data.is_local?`${data.title} · ${t("localHistory")}`:data.title;
    $("saveCurrentChatBtn").classList.toggle("hidden",!!data.is_local);
    $("messages").classList.remove("hidden"); renderConversation(data.messages||[]);
    const scrollToBottom=()=>{const box=$("messages");box.scrollTop=box.scrollHeight;const last=box.lastElementChild;if(last)last.scrollIntoView({block:"end"});};
    requestAnimationFrame(()=>{scrollToBottom();requestAnimationFrame(scrollToBottom);});
    const selected=$("chatList").querySelector(`.chat-item[data-id="${CSS.escape(id)}"]`); if(selected)selected.scrollIntoView({block:"nearest"});
  } catch(e) { toast(e.message || t("openError")); }
}

async function saveChat(chatId, button=null) {
  const targetId=chatId||selectedId; if(!targetId)return toast(t("selectPath"));
  const source=chats.find(c=>c.id===targetId); if(source?.is_local)return toast(t("alreadyLocal"));
  const original=button?.textContent || $("saveCurrentChatBtn").textContent, target=button||$("saveCurrentChatBtn");
  target.disabled=true; target.textContent=t("saving");
  try {
    const response=await fetch(`/api/chat/${targetId}/save`,{method:"POST"}), data=await response.json();
    if(!response.ok)throw new Error(data.error||t("saveError"));
    const localChat=data.local_chat, sourceIndex=chats.findIndex(c=>c.id===targetId);
    if(sourceIndex>=0)chats[sourceIndex]={...chats[sourceIndex],in_local:true};
    const localIndex=chats.findIndex(c=>c.id===localChat.id);
    if(localIndex>=0)chats[localIndex]=localChat;else chats.unshift(localChat);
    updateCount(); renderList();
    lastScanInfo = {kind:"local", data:{path:data.local_chat_path}};
    $("scanInfo").textContent=t("localFile",lastScanInfo.data);
    const verb=data.created?t("createdLocal"):t("appendedLocal");
    toast(data.added_count?t("savedElements",{verb,n:data.added_count}):t("noNew"));
  } catch(e) { toast(e.message); }
  finally { target.disabled=false; target.textContent=original; }
}

async function deleteMessage(messageId, button) {
  if(!selectedId || !confirm(t("deleteConfirm")))return;
  button.disabled=true;
  try {
    const response=await fetch(`/api/chat/${selectedId}/message/${encodeURIComponent(messageId)}`,{method:"DELETE"}),data=await response.json();
    if(!response.ok)throw new Error(data.error||t("deleteError"));
    currentChat=data.chat; renderConversation(currentChat.messages||[]);
    chats=chats.map(c=>c.id===selectedId?{...c,message_count:currentChat.message_count,preview:currentChat.preview,is_local:currentChat.is_local}:c);
    renderList(); toast(t("deleted"));
  } catch(e) { toast(e.message); button.disabled=false; }
}
async function copyHistory() {
  if(!currentChat)return;
  const messages=(currentChat.messages||[]).filter(m=>m.role==="user"||m.role==="assistant");
  const text=messages.map(m=>`${t("author")}: ${m.role==="user"?t("you"):t("claude")}\n${t("date")}: ${formatTime(m.timestamp)||t("noDate")}\n${t("text")}:\n${m.text||""}`).join("\n\n---\n\n");
  try {
    if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(text);
    else {const temp=document.createElement("textarea");temp.value=text;temp.style.position="fixed";temp.style.opacity="0";document.body.appendChild(temp);temp.select();const ok=document.execCommand("copy");temp.remove();if(!ok)throw new Error(t("browserCopyError"));}
    toast(t("copied",{n:messages.length}));
  } catch(e) { toast(e.message||t("copyError")); }
}

$("scanBtn").addEventListener("click",scan);
$("recentPathsSelect").addEventListener("change",()=>{const value=$("recentPathsSelect").value;if(value)$("folderPath").value=value;});
$("searchInput").addEventListener("input",renderList);
$("folderPath").addEventListener("keydown",e=>{if(e.key==="Enter")scan();});
$("copyHistoryBtn").addEventListener("click",copyHistory);
$("saveCurrentChatBtn").addEventListener("click",()=>saveChat(selectedId));
$("languageSelect").addEventListener("change",()=>{language=$("languageSelect").value;localStorage.setItem(LANGUAGE_KEY,language);applyLanguage();});
applyLanguage();
loadLocalChats();
