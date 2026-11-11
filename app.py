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

# Active index for the currently scanned source folders and local archive.
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
    # Session IDs survive moving/copying a Claude projects folder to another root.
    identity = session_id or file_path.stem
    return stable_hash(f"{project}\0{identity}")


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

                # A plain string is a regular visible message.
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
                            # Keep an unmatched result visible as a tool event, not as a user message.
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
    first_timestamp = next((m.get("timestamp") for m in messages if m.get("timestamp")), "")
    preview = next((m["text"][:140] for m in visible if m["role"] == "user"), "")
    if not preview and visible:
        preview = visible[0]["text"][:140]
    return {
        "id": chat_id,
        "title": title,
        "project": project_name,
        "cwd": cwd,
        "session_id": str(session_id),
        "updated": first_timestamp,
        "message_count": len(visible),
        "preview": preview,
        "messages": messages,
        "deleted_ids": [],
        "saved": False,
        "source_path": str(file_path),
    }


def project_history_path(project_name: str) -> Path:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    cleaned = re.sub(r"[^\w.-]+", "_", project_name.strip(), flags=re.UNICODE).strip("._")
    cleaned = (cleaned or "project")[:70]
    suffix = stable_hash(project_name)[:8]
    return HISTORY_DIR / f"{cleaned}-{suffix}.jsonl"


def public_chat(chat: dict, include_messages=False):
    result = {k: v for k, v in chat.items() if k not in ("messages", "deleted_ids", "source_path")}
    if include_messages:
        result["messages"] = [
            ({**m, "html": render_markdown(m.get("text", ""))} if m.get("role") in ("user", "assistant") else m)
            for m in sorted(chat.get("messages", []), key=lambda x: x.get("order", 0))
        ]
    return result


def append_chat_snapshot(chat: dict):
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


def load_archived_chats():
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
                        "source_path": "",
                    }
        except (OSError, UnicodeError):
            continue
    return archived


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
    # Preserve archive metadata if the latest source did not provide it.
    if not incoming.get("source_path"):
        result["source_path"] = existing.get("source_path", "")
    visible = [m for m in result["messages"] if m.get("role") in ("user", "assistant")]
    result["message_count"] = len(visible)
    result["preview"] = next((m["text"][:140] for m in visible if m["role"] == "user"), visible[0]["text"][:140] if visible else "")
    return result


def refresh_chat_metadata(chat: dict):
    visible = [m for m in chat.get("messages", []) if m.get("role") in ("user", "assistant")]
    chat["message_count"] = len(visible)
    chat["preview"] = next((m["text"][:140] for m in visible if m["role"] == "user"), visible[0]["text"][:140] if visible else "")


@app.route("/")
def index():
    return render_template("index.html")


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
    # Keep previously scanned, not-yet-saved sources in this running session too.
    # This lets the user scan several Claude roots in succession and save once.
    previous_chats = CHAT_FILES
    CHAT_FILES = load_archived_chats()
    for previous in previous_chats.values():
        CHAT_FILES[previous["id"]] = merge_chats(CHAT_FILES.get(previous["id"]), previous)
    source_count = 0
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for file_path in project_dir.rglob("*.jsonl"):
            parsed = parse_chat(file_path, project_dir)
            if not parsed:
                continue
            source_count += 1
            CHAT_FILES[parsed["id"]] = merge_chats(CHAT_FILES.get(parsed["id"]), parsed)

    chats = [public_chat(chat) for chat in CHAT_FILES.values()]
    chats.sort(key=lambda c: c.get("updated", ""), reverse=True)
    return jsonify({
        "projects_dir": str(projects_dir),
        "count": len(chats),
        "source_count": source_count,
        "saved_count": sum(1 for c in chats if c.get("saved")),
        "chats": chats,
    })


@app.get("/api/chat/<chat_id>")
def get_chat(chat_id):
    chat = CHAT_FILES.get(chat_id)
    if not chat:
        return jsonify({"error": "Диалог не найден. Возможно, нужно повторить сканирование."}), 404
    return jsonify(public_chat(chat, include_messages=True))


@app.post("/api/project/save")
def save_project():
    data = request.get_json(silent=True) or {}
    project_name = (data.get("project") or "").strip()
    if not project_name:
        return jsonify({"error": "Не указано название проекта."}), 400
    project_chats = [c for c in CHAT_FILES.values() if c.get("project") == project_name]
    if not project_chats:
        return jsonify({"error": "В этом проекте нет диалогов для сохранения."}), 404

    try:
        for chat in project_chats:
            refresh_chat_metadata(chat)
            append_chat_snapshot(chat)
    except OSError as exc:
        return jsonify({"error": f"Не удалось записать локальный архив: {exc}"}), 500

    return jsonify({"ok": True, "project": project_name, "saved_chats": len(project_chats), "path": str(project_history_path(project_name))})


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
    # Persist deletion immediately, even if this chat had not yet been explicitly saved.
    try:
        append_chat_snapshot(chat)
    except OSError as exc:
        return jsonify({"error": f"Не удалось сохранить удаление: {exc}"}), 500
    return jsonify({"ok": True, "chat": public_chat(chat, include_messages=True)})


if __name__ == "__main__":
    # Localhost only: the viewer is intended for personal use on this computer.
    app.run(host="127.0.0.1", port=5055, debug=False)
