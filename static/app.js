const $ = id => document.getElementById(id);
let chats = [], selectedId = null, currentChat = null;
const collapsedProjects = new Set();

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
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString("ru-RU");
}

function renderList() {
  const query = $("searchInput").value.trim().toLowerCase();
  const filtered = chats.filter(c => `${c.title} ${c.project} ${c.preview || ""}`.toLowerCase().includes(query));
  const localChats = filtered.filter(c => c.is_local);
  const sourceChats = filtered.filter(c => !c.is_local);
  const groups = new Map();
  for (const chat of sourceChats) {
    const name = chat.project || "Без проекта";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(chat);
  }
  // Внутри каждого проекта сначала показываем чаты с самой свежей активностью.
  for (const items of groups.values()) {
    items.sort((a, b) => {
      const timeA = Date.parse(a.updated || "") || 0;
      const timeB = Date.parse(b.updated || "") || 0;
      return timeB - timeA || String(a.title || "").localeCompare(String(b.title || ""), "ru");
    });
  }

  if (!filtered.length) {
    $("chatList").innerHTML = `<div class="empty-state">Ничего не найдено.</div>`;
    return;
  }

  let html = "";
  if (localChats.length) {
    html += `<section class="local-section">
      <div class="sidebar-section-title">Локальные чаты <span>${localChats.length}</span></div>
      <div class="local-chat-list">${localChats.map(c => `
        <button type="button" class="chat-item local-chat-item ${c.id===selectedId?"active":""}" data-id="${c.id}" title="${escapeHtml(c.title)}">
          <span class="local-chat-mark">●</span><span class="chat-name">${escapeHtml(c.title)}</span>
        </button>`).join("")}</div>
    </section>`;
  }

  html += [...groups.entries()].map(([project, items]) => {
    const collapsed = collapsedProjects.has(project);
    return `<section class="project-group">
      <button class="project-heading ${collapsed ? "collapsed" : ""}" type="button" data-project="${escapeHtml(project)}">
        <span class="project-chevron">${collapsed ? "›" : "⌄"}</span>
        <span class="project-title">${escapeHtml(project)}</span>
        <span class="project-count">${items.length}</span>
      </button>
      ${collapsed ? "" : `<div class="project-chats">${items.map(c => `
        <div class="source-chat-row">
          <button type="button" class="chat-item ${c.id===selectedId?"active":""}" data-id="${c.id}" title="${escapeHtml(c.title)}">
            <span class="chat-name">${escapeHtml(c.title)}</span>
          </button>
          <button type="button" class="save-chat-btn ${c.in_local?"in-local":""}" data-save-id="${c.id}" title="${c.in_local?"Добавить новые сообщения в локальный чат проекта":"Сохранить этот чат в локальную историю проекта"}">
            ${c.in_local ? "Добавить новые" : "Сохранить чат"}
          </button>
        </div>`).join("")}</div>`}
    </section>`;
  }).join("");

  $("chatList").innerHTML = html;
  $("chatList").querySelectorAll(".project-heading").forEach(el => {
    el.addEventListener("click", () => {
      const project = el.dataset.project;
      if (collapsedProjects.has(project)) collapsedProjects.delete(project);
      else collapsedProjects.add(project);
      renderList();
    });
  });
  $("chatList").querySelectorAll(".chat-item").forEach(el => {
    el.addEventListener("click", () => openChat(el.dataset.id));
  });
  $("chatList").querySelectorAll(".save-chat-btn").forEach(el => {
    el.addEventListener("click", () => saveChat(el.dataset.saveId, el));
  });
}

async function scan() {
  const path = $("folderPath").value.trim();
  if (!path) return toast("Сначала укажи путь к папке.");
  $("scanBtn").disabled = true; $("scanBtn").textContent = "Сканирую...";
  try {
    const response = await fetch("/api/scan", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({path})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось просканировать папку.");
    chats = data.chats; selectedId = null; currentChat = null; collapsedProjects.clear();
    $("chatCount").textContent = data.count;
    $("scanInfo").textContent = `Источник: ${data.projects_dir} · исходных чатов: ${data.source_count} · локальных чатов: ${data.local_count}`;
    $("welcome").classList.remove("hidden");
    $("conversationActions").classList.add("hidden");
    $("messages").classList.add("hidden");
    $("messages").innerHTML = "";
    renderList();
    toast(`В списке чатов: ${data.count}`);
  } catch (e) { toast(e.message); }
  finally { $("scanBtn").disabled = false; $("scanBtn").textContent = "Найти чаты"; }
}

function toolDetailsMarkup(tool) {
  const name = escapeHtml(tool.tool_name || "Инструмент");
  const input = tool.tool_input == null ? "" : (typeof tool.tool_input === "string" ? tool.tool_input : JSON.stringify(tool.tool_input, null, 2));
  const result = tool.tool_result || "";
  const details = [
    input ? `<div class="tool-section"><div class="tool-section-label">Входные данные</div><pre>${escapeHtml(input)}</pre></div>` : "",
    result ? `<div class="tool-section"><div class="tool-section-label">Результат${tool.tool_error ? " · ошибка" : ""}</div><pre>${escapeHtml(result)}</pre></div>` : ""
  ].filter(Boolean).join("");
  const time = formatTime(tool.timestamp);
  return `<div class="tool-entry" data-message-id="${escapeHtml(tool.id)}">
    <div class="tool-entry-heading"><span>⚙ ${name}</span><button class="delete-message-btn" type="button" data-delete-id="${escapeHtml(tool.id)}" title="Удалить вызов">×</button></div>
    ${details || `<div class="tool-no-details">Нет подробностей</div>`}
    ${time ? `<div class="tool-time">${escapeHtml(time)}</div>` : ""}
  </div>`;
}

function renderConversation(messages) {
  const output = [];
  for (let i = 0; i < messages.length;) {
    const message = messages[i];
    if (message.role === "tool") {
      let j = i;
      while (j < messages.length && messages[j].role === "tool") j++;
      const run = messages.slice(i, j);
      if (run.length >= 2) {
        output.push(`<details class="tool-run"><summary><span>⚙ Свернуто вызовов инструментов: ${run.length}</span><span class="tool-run-hint">Показать</span></summary><div class="tool-run-content">${run.map(t => toolDetailsMarkup(t)).join("")}</div></details>`);
      } else {
        output.push(`<details class="tool-single"><summary>⚙ ${escapeHtml(message.tool_name || "Инструмент")}</summary>${toolDetailsMarkup(message)}</details>`);
      }
      i = j;
      continue;
    }

    const isUser = message.role === "user";
    const role = isUser ? "user" : "assistant";
    const author = isUser ? "Вы" : "Claude";
    const time = formatTime(message.timestamp);
    output.push(`<article class="message ${role}" data-message-id="${escapeHtml(message.id)}">
      <div class="message-inner">
        <div class="message-topline"><div class="role-label">${author}</div><button class="delete-message-btn" type="button" data-delete-id="${escapeHtml(message.id)}" title="Удалить сообщение">×</button></div>
        <div class="bubble markdown-body">${message.html || escapeHtml(message.text || "")}</div>
        ${time ? `<div class="message-time">${escapeHtml(time)}</div>` : ""}
      </div>
    </article>`);
    i++;
  }
  $("messages").innerHTML = output.join("") || `<div class="empty-state conversation-empty">В этом диалоге пока нет отображаемых сообщений.</div>`;
  $("messages").querySelectorAll(".delete-message-btn").forEach(button => {
    button.addEventListener("click", () => deleteMessage(button.dataset.deleteId, button));
  });
}

async function openChat(id) {
  try {
    const response = await fetch(`/api/chat/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось открыть диалог.");
    selectedId = id;
    currentChat = data;
    renderList();
    $("welcome").classList.add("hidden");
    $("conversationActions").classList.remove("hidden");
    $("conversationTitle").textContent = data.is_local ? `${data.title} · локальная история` : data.title;
    $("saveCurrentChatBtn").classList.toggle("hidden", !!data.is_local);
    $("messages").classList.remove("hidden");
    renderConversation(data.messages || []);
    const scrollToBottom = () => {
      const box = $("messages"); box.scrollTop = box.scrollHeight;
      const last = box.lastElementChild; if (last) last.scrollIntoView({block:"end"});
    };
    requestAnimationFrame(() => { scrollToBottom(); requestAnimationFrame(scrollToBottom); });
    const selected = $("chatList").querySelector(`.chat-item[data-id="${id}"]`);
    if (selected) selected.scrollIntoView({block:"nearest"});
  } catch(e) { toast(e.message || "Ошибка загрузки диалога."); }
}

async function saveChat(chatId, button = null) {
  const targetId = chatId || selectedId;
  if (!targetId) return toast("Сначала выбери чат для сохранения.");
  const source = chats.find(c => c.id === targetId);
  if (source?.is_local) return toast("Это уже локальный чат проекта.");
  const original = button?.textContent || $("saveCurrentChatBtn").textContent;
  const buttonToDisable = button || $("saveCurrentChatBtn");
  buttonToDisable.disabled = true;
  if (button) button.textContent = "Сохраняю...";
  else buttonToDisable.textContent = "Сохраняю...";
  try {
    const response = await fetch(`/api/chat/${targetId}/save`, {method:"POST"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось сохранить чат.");

    const localChat = data.local_chat;
    const sourceIndex = chats.findIndex(c => c.id === targetId);
    if (sourceIndex >= 0) chats[sourceIndex] = {...chats[sourceIndex], in_local:true};
    const localIndex = chats.findIndex(c => c.id === localChat.id);
    if (localIndex >= 0) chats[localIndex] = localChat;
    else chats.unshift(localChat);
    renderList();
    $("chatCount").textContent = chats.length;
    $("scanInfo").textContent = `Локальный файл проекта: ${data.local_chat_path}`;
    const verb = data.created ? "Создан локальный чат" : "Добавлено в локальный чат";
    toast(data.added_count ? `${verb}: ${data.added_count} элементов` : "Новых сообщений для добавления нет.");
  } catch(e) {
    toast(e.message);
  } finally {
    buttonToDisable.disabled = false;
    if (button) button.textContent = original;
    else buttonToDisable.textContent = original;
  }
}

async function deleteMessage(messageId, button) {
  if (!selectedId || !confirm("Удалить это сообщение из локальной истории?")) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/chat/${selectedId}/message/${encodeURIComponent(messageId)}`, {method:"DELETE"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось удалить сообщение.");
    currentChat = data.chat;
    renderConversation(currentChat.messages || []);
    chats = chats.map(c => c.id === selectedId ? {...c, message_count:currentChat.message_count, preview:currentChat.preview, is_local:currentChat.is_local} : c);
    renderList();
    toast("Сообщение удалено из локальной истории.");
  } catch(e) { toast(e.message); button.disabled = false; }
}

async function copyHistory() {
  if (!currentChat) return;
  const messages = (currentChat.messages || []).filter(m => m.role === "user" || m.role === "assistant");
  const text = messages.map(m => {
    const author = m.role === "user" ? "Вы" : "Claude";
    return `Автор: ${author}\nДата: ${formatTime(m.timestamp) || "не указана"}\nТекст:\n${m.text || ""}`;
  }).join("\n\n---\n\n");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement("textarea");
      temp.value = text; temp.style.position = "fixed"; temp.style.opacity = "0";
      document.body.appendChild(temp); temp.select();
      const ok = document.execCommand("copy"); temp.remove();
      if (!ok) throw new Error("Браузер не разрешил копирование.");
    }
    toast(`Скопировано сообщений: ${messages.length}`);
  } catch(e) { toast(e.message || "Не удалось скопировать историю."); }
}

$("scanBtn").addEventListener("click", scan);
$("searchInput").addEventListener("input", renderList);
$("folderPath").addEventListener("keydown", e => { if (e.key === "Enter") scan(); });
$("copyHistoryBtn").addEventListener("click", copyHistory);
$("saveCurrentChatBtn").addEventListener("click", () => saveChat(selectedId));
