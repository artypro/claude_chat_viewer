from flask import Flask, render_template, request, jsonify
from pathlib import Path
from datetime import datetime
import hashlib
import json
import re
from typing import Optional

import markdown
import bleach

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
HISTORY_DIR = BASE_DIR / "history"

ALLOWED_TAGS = set(bleach.sanitizer.ALLOWED_TAGS) | {
    "p", "pre", "code", "blockquote", "h1", "h2", "h3", "h4",
    "hr", "br", "ul", "ol", "li", "table", "thead", "tbody",
    "tr", "th", "td", "del", "ins", "input"
}
ALLOWED_ATTRIBUTES = {
    **bleach.sanitizer.ALLOWED_ATTRIBUTES,
    "a": ["href", "title", "rel"],
    "code": ["class"],
    "pre": ["class"],
    "th": ["align"],
    "td": ["align"],
    "input": ["type", "checked", "disabled"],
}

# In-memory index of the source chats currently scanned and local project threads.
CHAT_FILES = {}
PROJECTS_DIR = None


def render_markdown(source: str) -> str:
    rendered = markdown.markdown(
        source,
        extensions=["fenced_code", "tables", "nl2br", "sane_lists"],
        output_format="html5",
    )
    return bleach.clean(
        rendered,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols={"http", "https", "mailto"},
        strip=True,
    )


def find_projects_dir(raw_path: str) -> Path:
    path = Path(raw_path).expanduser().resolve()
    if not path.exists() or not path.is_dir():
        raise ValueError("Указанная папка не существует или это не папка.")

    candidates = [path / "projects", path / ".claude" / "projects", path / "claude" / "projects"]
    for parent in [path, *path.parents]:
        if parent.name == "projects" and parent.is_dir():
            return parent
        if (parent / "projects").is_dir() and parent.name == ".claude":
            return parent / "projects"
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise ValueError("Не найдена папка projects. Укажи путь к .claude или непосредственно к projects.")


def stable_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8", errors="replace")).hexdigest()


def make_chat_id(project: str, session_id: str, file_path: Path) -> str:
    identity = session_id or file_path.stem
    return stable_hash(f"{project}\0{identity}")


def make_local_chat_id(project_name: str) -> str:
    # One continuous local conversation per project. Each selected source chat
    # contributes its messages to the end of this local conversation.
    return stable_hash(f"local-project\0{project_name}")


def as_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        pieces = []
        for part in value:
            if isinstance(part, str) and part.strip():
                pieces.append(part.strip())
            elif isinstance(part, dict):
                if part.get("type") == "text" and part.get("text"):
                    pieces.append(str(part["text"]).strip())
                elif part.get("type") == "image":
                    pieces.append("[Изображение]")
                elif part.get("type") == "document":
                    pieces.append("[Документ]")
        return "\n\n".join(p for p in pieces if p)
    return str(value).strip()


def fallback_record_id(item: dict, role: str, content) -> str:
    raw = json.dumps(content, ensure_ascii=False, sort_keys=True, default=str)
    return stable_hash(f"{item.get('timestamp', '')}\0{role}\0{raw}")


def parse_chat(file_path: Path, project_dir: Path):
    title = file_path.stem
    cwd = ""
    session_id = file_path.stem
    messages = []
    tool_by_id = {}
    order = 0

    try:
        with file_path.open("r", encoding="utf-8") as stream:
            for line in stream:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(item, dict):
                    continue

                typ = item.get("type")
                if typ == "custom-title" and item.get("customTitle"):
                    title = str(item["customTitle"])
                cwd = cwd or item.get("cwd") or ""
                session_id = item.get("sessionId") or session_id

                if typ not in ("user", "assistant") or item.get("isSidechain"):
                    continue
                message = item.get("message") or {}
                role = message.get("role") or typ
                if role not in ("user", "assistant"):
                    continue
                content = message.get("content")
                record_id = str(item.get("uuid") or message.get("id") or fallback_record_id(item, role, content))
                timestamp = item.get("timestamp") or ""

                if isinstance(content, str):
                    text = content.strip()
                    if text:
                        messages.append({
                            "id": f"{record_id}:text", "role": role, "text": text,
                            "timestamp": timestamp, "order": order,
                        })
                        order += 1
                    continue

                if not isinstance(content, list):
                    continue

                text_parts = []
                text_block_indexes = []

                def flush_text():
                    nonlocal order, text_parts, text_block_indexes
                    text = "\n\n".join(p for p in text_parts if p).strip()
                    if text:
                        suffix = "-".join(str(i) for i in text_block_indexes) or "0"
                        messages.append({
                            "id": f"{record_id}:text:{suffix}", "role": role, "text": text,
                            "timestamp": timestamp, "order": order,
                        })
                        order += 1
                    text_parts = []
                    text_block_indexes = []

                for block_index, block in enumerate(content):
                    if isinstance(block, str):
                        if block.strip():
                            text_parts.append(block.strip())
                            text_block_indexes.append(block_index)
                        continue
                    if not isinstance(block, dict):
                        continue
                    kind = block.get("type")
                    if kind == "text":
                        if block.get("text"):
                            text_parts.append(str(block["text"]).strip())
                            text_block_indexes.append(block_index)
                    elif kind in ("image", "document"):
                        text_parts.append("[Изображение]" if kind == "image" else "[Документ]")
                        text_block_indexes.append(block_index)
                    elif kind == "tool_use":
                        flush_text()
                        tool_use_id = str(block.get("id") or f"{record_id}:{block_index}")
                        tool_message = {
                            "id": f"tool:{tool_use_id}", "role": "tool",
                            "tool_name": str(block.get("name") or "Инструмент"),
                            "tool_input": block.get("input"), "tool_result": "",
                            "tool_error": False, "timestamp": timestamp, "order": order,
                        }
                        messages.append(tool_message)
                        tool_by_id[tool_use_id] = tool_message
                        order += 1
                    elif kind == "tool_result":
                        flush_text()
                        tool_use_id = str(block.get("tool_use_id") or "")
                        result_text = as_text(block.get("content"))
                        if not result_text and block.get("content") is not None:
                            result_text = json.dumps(block.get("content"), ensure_ascii=False, indent=2, default=str)
                        target = tool_by_id.get(tool_use_id)
                        if target:
                            target["tool_result"] = result_text
                            target["tool_error"] = bool(block.get("is_error"))
                        else:
                            orphan_id = tool_use_id or f"{record_id}:{block_index}"
                            target = {
                                "id": f"tool-result:{orphan_id}", "role": "tool",
                                "tool_name": "Результат инструмента", "tool_input": None,
                                "tool_result": result_text, "tool_error": bool(block.get("is_error")),
                                "timestamp": timestamp, "order": order,
                            }
                            messages.append(target)
                            if tool_use_id:
                                tool_by_id[tool_use_id] = target
                            order += 1
                flush_text()
    except (OSError, UnicodeError):
        return None

    project_name = Path(cwd.replace("\\", "/")).name if cwd else project_dir.name
    chat_id = make_chat_id(project_name, session_id, file_path)
    messages.sort(key=lambda m: m.get("order", 0))
    visible = [m for m in messages if m.get("role") in ("user", "assistant")]
    if not messages:
        return None
    latest_timestamp = max(
        (str(m.get("timestamp") or "") for m in messages if m.get("timestamp")),
        default="",
    )
    preview = next((m["text"][:140] for m in visible if m["role"] == "user"), "")
    if not preview and visible:
        preview = visible[0]["text"][:140]
    return {
        "id": chat_id,
        "title": title,
        "project": project_name,
        "cwd": cwd,
        "session_id": str(session_id),
        "updated": latest_timestamp,
        "message_count": len(visible),
        "preview": preview,
        "messages": messages,
        "deleted_ids": [],
        "saved": False,
        "in_local": False,
        "is_local": False,
        "source_path": str(file_path),
    }


def project_history_path(project_name: str) -> Path:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    cleaned = re.sub(r"[^\w.-]+", "_", project_name.strip(), flags=re.UNICODE).strip("._")
    cleaned = (cleaned or "project")[:70]
    suffix = stable_hash(project_name)[:8]
    return HISTORY_DIR / f"{cleaned}-{suffix}.jsonl"


def public_chat(chat: dict, include_messages=False):
    hidden = ("messages", "deleted_ids", "source_path", "imported_message_keys")
    result = {k: v for k, v in chat.items() if k not in hidden}
    if include_messages:
        result["messages"] = [
            ({**m, "html": render_markdown(m.get("text", ""))} if m.get("role") in ("user", "assistant") else m)
            for m in sorted(chat.get("messages", []), key=lambda x: x.get("order", 0))
        ]
    return result


def append_chat_snapshot(chat: dict):
    """Persist a source-chat edit/deletion for backward compatibility."""
    path = project_history_path(chat["project"])
    snapshot = {
        "record": "chat_snapshot",
        "chat": {k: chat.get(k, "") for k in ("id", "title", "project", "cwd", "session_id", "updated", "message_count", "preview")},
        "messages": sorted(chat.get("messages", []), key=lambda x: x.get("order", 0)),
        "deleted_ids": sorted(set(chat.get("deleted_ids", []))),
        "saved_at": datetime.now().isoformat(timespec="seconds"),
    }
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(snapshot, ensure_ascii=False, default=str) + "\n")
    chat["saved"] = True


def append_local_chat_snapshot(chat: dict):
    path = project_history_path(chat["project"])
    snapshot = {
        "record": "local_chat_snapshot",
        "chat": {k: chat.get(k, "") for k in (
            "id", "title", "project", "cwd", "session_id", "updated",
            "message_count", "preview", "source_chat_ids", "source_chat_titles"
        )},
        "messages": sorted(chat.get("messages", []), key=lambda x: x.get("order", 0)),
        "deleted_ids": sorted(set(chat.get("deleted_ids", []))),
        "imported_message_keys": sorted(set(chat.get("imported_message_keys", []))),
        "saved_at": datetime.now().isoformat(timespec="seconds"),
    }
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(snapshot, ensure_ascii=False, default=str) + "\n")
    chat["saved"] = True


def load_archived_chats():
    """Load older source-chat snapshots so existing archives are not lost."""
    archived = {}
    if not HISTORY_DIR.exists():
        return archived
    for path in HISTORY_DIR.glob("*.jsonl"):
        try:
            with path.open("r", encoding="utf-8") as stream:
                for line in stream:
                    try:
                        snapshot = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if snapshot.get("record") != "chat_snapshot" or not isinstance(snapshot.get("chat"), dict):
                        continue
                    meta = snapshot["chat"]
                    chat_id = meta.get("id")
                    if not chat_id:
                        continue
                    archived[chat_id] = {
                        **meta,
                        "messages": snapshot.get("messages") or [],
                        "deleted_ids": snapshot.get("deleted_ids") or [],
                        "saved": True,
                        "in_local": False,
                        "is_local": False,
                        "source_path": "",
                    }
        except (OSError, UnicodeError):
            continue
    return archived


def load_local_chats():
    local_chats = {}
    if not HISTORY_DIR.exists():
        return local_chats
    for path in HISTORY_DIR.glob("*.jsonl"):
        try:
            with path.open("r", encoding="utf-8") as stream:
                for line in stream:
                    try:
                        snapshot = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if snapshot.get("record") != "local_chat_snapshot" or not isinstance(snapshot.get("chat"), dict):
                        continue
                    meta = snapshot["chat"]
                    local_id = meta.get("id")
                    if not local_id:
                        continue
                    local_chats[local_id] = {
                        **meta,
                        "messages": snapshot.get("messages") or [],
                        "deleted_ids": snapshot.get("deleted_ids") or [],
                        "imported_message_keys": snapshot.get("imported_message_keys") or [],
                        "saved": True,
                        "in_local": True,
                        "is_local": True,
                        "source_path": "",
                    }
        except (OSError, UnicodeError):
            continue
    return local_chats


def merge_chats(existing: Optional[dict], incoming: dict) -> dict:
    if not existing:
        return incoming
    deleted = set(existing.get("deleted_ids", [])) | set(incoming.get("deleted_ids", []))
    merged_messages = {m["id"]: m for m in existing.get("messages", []) if m.get("id") not in deleted}
    for message in incoming.get("messages", []):
        if message.get("id") not in deleted:
            merged_messages[message["id"]] = message
    result = {**existing, **incoming}
    result["messages"] = sorted(merged_messages.values(), key=lambda m: m.get("order", 0))
    result["deleted_ids"] = sorted(deleted)
    result["saved"] = bool(existing.get("saved") or incoming.get("saved"))
    result["in_local"] = bool(existing.get("in_local") or incoming.get("in_local"))
    result["is_local"] = False
    if not incoming.get("source_path"):
        result["source_path"] = existing.get("source_path", "")
    refresh_chat_metadata(result)
    return result


def refresh_chat_metadata(chat: dict):
    messages = chat.get("messages", [])
    visible = [m for m in messages if m.get("role") in ("user", "assistant")]
    chat["message_count"] = len(visible)
    chat["preview"] = next((m["text"][:140] for m in visible if m.get("role") == "user"), visible[0]["text"][:140] if visible else "")
    # Claude timestamps are ISO-8601, so their string order is chronological.
    # Use the newest event (including tool events) as the chat's last activity.
    chat["updated"] = max(
        (str(m.get("timestamp") or "") for m in messages if m.get("timestamp")),
        default=chat.get("updated", ""),
    )


def create_local_chat(project_name: str) -> dict:
    local_id = make_local_chat_id(project_name)
    return {
        "id": local_id,
        "title": project_name,
        "project": project_name,
        "cwd": "",
        "session_id": f"local-{local_id[:12]}",
        "updated": datetime.now().isoformat(timespec="seconds"),
        "message_count": 0,
        "preview": "",
        "messages": [],
        "deleted_ids": [],
        "imported_message_keys": [],
        "source_chat_ids": [],
        "source_chat_titles": [],
        "saved": True,
        "in_local": True,
        "is_local": True,
        "source_path": "",
    }


def append_source_chat_to_local(local_chat: dict, source_chat: dict) -> int:
    imported = set(local_chat.get("imported_message_keys", []))
    current_messages = local_chat.setdefault("messages", [])
    next_order = max((m.get("order", -1) for m in current_messages), default=-1) + 1
    added = 0

    for source_message in sorted(source_chat.get("messages", []), key=lambda m: m.get("order", 0)):
        source_message_id = str(source_message.get("id", ""))
        import_key = stable_hash(f"{source_chat['id']}\0{source_message_id}")
        if not source_message_id or import_key in imported:
            continue
        copied = {k: v for k, v in source_message.items() if k != "html"}
        copied.update({
            "id": f"local:{import_key}",
            "order": next_order,
            "source_chat_id": source_chat["id"],
            "source_chat_title": source_chat.get("title", ""),
        })
        current_messages.append(copied)
        imported.add(import_key)
        next_order += 1
        added += 1

    local_chat["imported_message_keys"] = sorted(imported)
    source_ids = set(local_chat.get("source_chat_ids", []))
    source_ids.add(source_chat["id"])
    local_chat["source_chat_ids"] = sorted(source_ids)
    title_map = dict(local_chat.get("source_chat_titles", []))
    title_map[source_chat["id"]] = source_chat.get("title", "")
    local_chat["source_chat_titles"] = sorted(title_map.items())
    local_chat["updated"] = datetime.now().isoformat(timespec="seconds")
    if not local_chat.get("cwd"):
        local_chat["cwd"] = source_chat.get("cwd", "")
    refresh_chat_metadata(local_chat)
    return added


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/local-chats")
def get_local_chats():
    """Return saved local chats independently of the currently scanned source folder."""
    local_chats = load_local_chats()
    for local_chat in local_chats.values():
        CHAT_FILES[local_chat["id"]] = local_chat
    chats = [public_chat(chat) for chat in local_chats.values()]
    chats.sort(key=lambda chat: chat.get("updated", ""), reverse=True)
    return jsonify({"count": len(chats), "chats": chats})


@app.post("/api/scan")
def scan():
    global CHAT_FILES, PROJECTS_DIR
    data = request.get_json(silent=True) or {}
    raw_path = (data.get("path") or "").strip()
    if not raw_path:
        return jsonify({"error": "Укажи путь к папке Claude."}), 400
    try:
        projects_dir = find_projects_dir(raw_path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    PROJECTS_DIR = projects_dir
    # Each scan must represent ONLY the source directory entered by the user.
    # Keep archived snapshots separately and apply them only when the matching
    # source chat is actually found in this scan. Never carry over source chats
    # from the previous scan: that made changing the path appear to do nothing.
    archived_chats = load_archived_chats()
    CHAT_FILES = {}

    source_count = 0
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for file_path in project_dir.rglob("*.jsonl"):
            parsed = parse_chat(file_path, project_dir)
            if not parsed:
                continue
            source_count += 1
            CHAT_FILES[parsed["id"]] = merge_chats(archived_chats.get(parsed["id"]), parsed)

    local_chats = load_local_chats()
    for local_chat in local_chats.values():
        CHAT_FILES[local_chat["id"]] = local_chat

    local_ids_by_project = {}
    for local_chat in local_chats.values():
        local_ids_by_project.setdefault(local_chat["project"], set()).update(local_chat.get("source_chat_ids", []))
    for chat in CHAT_FILES.values():
        if not chat.get("is_local"):
            chat["in_local"] = chat.get("id") in local_ids_by_project.get(chat.get("project"), set())

    chats = [public_chat(chat) for chat in CHAT_FILES.values()]
    chats.sort(key=lambda c: (not c.get("is_local", False), c.get("updated", "")), reverse=False)
    return jsonify({
        "projects_dir": str(projects_dir),
        "count": len(chats),
        "source_count": source_count,
        "local_count": len(local_chats),
        "chats": chats,
    })


@app.get("/api/chat/<chat_id>")
def get_chat(chat_id):
    chat = CHAT_FILES.get(chat_id)
    if not chat:
        return jsonify({"error": "Диалог не найден. Возможно, нужно повторить сканирование."}), 404
    return jsonify(public_chat(chat, include_messages=True))


@app.post("/api/chat/<chat_id>/save")
def save_chat(chat_id):
    source_chat = CHAT_FILES.get(chat_id)
    if not source_chat:
        return jsonify({"error": "Исходный диалог не найден."}), 404
    if source_chat.get("is_local"):
        return jsonify({"error": "Этот чат уже является локальной историей проекта."}), 400

    project_name = source_chat.get("project") or "Без проекта"
    local_id = make_local_chat_id(project_name)
    local_chat = CHAT_FILES.get(local_id)
    created = local_chat is None
    if created:
        local_chat = create_local_chat(project_name)

    try:
        added_count = append_source_chat_to_local(local_chat, source_chat)
        append_local_chat_snapshot(local_chat)
    except OSError as exc:
        return jsonify({"error": f"Не удалось записать локальный архив: {exc}"}), 500

    CHAT_FILES[local_id] = local_chat
    source_chat["in_local"] = True
    return jsonify({
        "ok": True,
        "created": created,
        "added_count": added_count,
        "local_chat": public_chat(local_chat),
        "local_chat_path": str(project_history_path(project_name)),
    })


@app.delete("/api/chat/<chat_id>/message/<path:message_id>")
def delete_message(chat_id, message_id):
    chat = CHAT_FILES.get(chat_id)
    if not chat:
        return jsonify({"error": "Диалог не найден."}), 404
    existing_ids = {m.get("id") for m in chat.get("messages", [])}
    if message_id not in existing_ids:
        return jsonify({"error": "Сообщение уже удалено или не найдено."}), 404

    chat["messages"] = [m for m in chat.get("messages", []) if m.get("id") != message_id]
    chat.setdefault("deleted_ids", []).append(message_id)
    chat["deleted_ids"] = sorted(set(chat["deleted_ids"]))
    refresh_chat_metadata(chat)
    try:
        if chat.get("is_local"):
            append_local_chat_snapshot(chat)
        else:
            append_chat_snapshot(chat)
    except OSError as exc:
        return jsonify({"error": f"Не удалось сохранить удаление: {exc}"}), 500
    return jsonify({"ok": True, "chat": public_chat(chat, include_messages=True)})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5055, debug=False)
