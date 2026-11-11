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
  const filtered = chats.filter(c => `${c.title} ${c.project} ${c.preview}`.toLowerCase().includes(query));
  const groups = new Map();
  for (const chat of filtered) {
    const name = chat.project || "Без проекта";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(chat);
  }
  if (!filtered.length) {
    $("chatList").innerHTML = `<div class="empty-state">Ничего не найдено.</div>`;
    return;
  }

  $("chatList").innerHTML = [...groups.entries()].map(([project, items]) => {
    const collapsed = collapsedProjects.has(project);
    return `<section class="project-group">
      <div class="project-heading-row">
        <button class="project-heading ${collapsed ? "collapsed" : ""}" type="button" data-project="${escapeHtml(project)}">
          <span class="project-chevron">${collapsed ? "›" : "⌄"}</span>
          <span class="project-title">${escapeHtml(project)}</span>
          <span class="project-count">${items.length}</span>
        </button>
        <button class="save-project-btn" type="button" data-save-project="${escapeHtml(project)}" title="Сохранить все чаты проекта">Сохранить историю</button>
      </div>
      ${collapsed ? "" : `<div class="project-chats">${items.map(c => `
        <button type="button" class="chat-item ${c.id===selectedId?"active":""}" data-id="${c.id}" title="${escapeHtml(c.title)}">
          <span class="chat-name">${escapeHtml(c.title)}</span>
          ${c.saved ? `<span class="saved-indicator" title="Есть локальная копия">●</span>` : ""}
        </button>`).join("")}</div>`}
    </section>`;
  }).join("");

  $("chatList").querySelectorAll(".project-heading").forEach(el => {
    el.addEventListener("click", () => {
      const project = el.dataset.project;
      if (collapsedProjects.has(project)) collapsedProjects.delete(project);
      else collapsedProjects.add(project);
      renderList();
    });
  });
  $("chatList").querySelectorAll(".save-project-btn").forEach(el => {
    el.addEventListener("click", () => saveProject(el.dataset.saveProject, el));
  });
  $("chatList").querySelectorAll(".chat-item").forEach(el => {
    el.addEventListener("click", () => openChat(el.dataset.id));
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
    $("scanInfo").textContent = `Источник: ${data.projects_dir} · найдено в папке: ${data.source_count} · в локальном архиве: ${data.saved_count}`;
    $("welcome").classList.remove("hidden");
    $("conversationActions").classList.add("hidden");
    $("messages").classList.add("hidden");
    $("messages").innerHTML = "";
    renderList();
    toast(`Диалогов в списке: ${data.count}`);
  } catch (e) { toast(e.message); }
  finally { $("scanBtn").disabled = false; $("scanBtn").textContent = "Найти чаты"; }
}

function toolDetailsMarkup(tool, index, total) {
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
        output.push(`<details class="tool-run"><summary><span>⚙ Свернуто вызовов инструментов: ${run.length}</span><span class="tool-run-hint">Показать</span></summary><div class="tool-run-content">${run.map((t, n) => toolDetailsMarkup(t, n, run.length)).join("")}</div></details>`);
      } else {
        output.push(`<details class="tool-single"><summary>⚙ ${escapeHtml(message.tool_name || "Инструмент")}</summary>${toolDetailsMarkup(message, 0, 1)}</details>`);
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
    $("conversationTitle").textContent = data.title;
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

async function saveProject(project, button) {
  const original = button.textContent;
  button.disabled = true; button.textContent = "Сохраняю...";
  try {
    const response = await fetch("/api/project/save", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({project})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось сохранить историю.");
    chats = chats.map(c => c.project === project ? {...c, saved:true} : c);
    renderList();
    $("scanInfo").textContent = `Локальный архив: ${data.path}`;
    toast(`Сохранено чатов проекта «${project}»: ${data.saved_chats}`);
  } catch(e) { toast(e.message); button.disabled = false; button.textContent = original; }
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
    chats = chats.map(c => c.id === selectedId ? {...c, message_count:currentChat.message_count, preview:currentChat.preview, saved:true} : c);
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
