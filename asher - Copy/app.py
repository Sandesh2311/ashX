import json
import os
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "database.db"
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
ALLOWED_VIDEO_EXTENSIONS = {"mp4", "webm", "mov", "m4v", "ogg"}
ALLOWED_DOCUMENT_EXTENSIONS = {"pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "zip", "rar", "csv"}
ALLOWED_AUDIO_EXTENSIONS = {"webm", "wav", "mp3", "m4a", "aac", "ogg"}
MAX_UPLOAD_MB = 25

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-change-me")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

online_users = set()
user_sockets = {}
sid_to_user = {}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def now_iso():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_IMAGE_EXTENSIONS


def classify_media(filename, preferred_type=None):
    ext = filename.rsplit(".", 1)[1].lower() if "." in filename else ""
    if preferred_type == "voice":
        return "voice" if ext in ALLOWED_AUDIO_EXTENSIONS else None
    if ext in ALLOWED_IMAGE_EXTENSIONS:
        return "image"
    if ext in ALLOWED_VIDEO_EXTENSIONS:
        return "video"
    if ext in ALLOWED_AUDIO_EXTENSIONS:
        return "audio"
    if ext in ALLOWED_DOCUMENT_EXTENSIONS:
        return "document"
    return None


def auth_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    conn = get_db()
    user = conn.execute(
        "SELECT id, username, email, avatar_url FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    conn.close()
    return user


def ensure_column(conn, table, column, ddl):
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(ddl)


def init_db():
    conn = get_db()
    with open(BASE_DIR / "schema.sql", "r", encoding="utf-8") as f:
        conn.executescript(f.read())

    ensure_column(conn, "users", "last_seen", "ALTER TABLE users ADD COLUMN last_seen TEXT")
    ensure_column(conn, "messages", "reply_to_id", "ALTER TABLE messages ADD COLUMN reply_to_id INTEGER")
    ensure_column(conn, "messages", "forwarded_from_id", "ALTER TABLE messages ADD COLUMN forwarded_from_id INTEGER")
    ensure_column(conn, "messages", "edited_at", "ALTER TABLE messages ADD COLUMN edited_at TEXT")
    ensure_column(conn, "messages", "media_url", "ALTER TABLE messages ADD COLUMN media_url TEXT")
    ensure_column(conn, "messages", "media_type", "ALTER TABLE messages ADD COLUMN media_type TEXT")
    ensure_column(conn, "messages", "file_name", "ALTER TABLE messages ADD COLUMN file_name TEXT")
    ensure_column(conn, "messages", "file_size", "ALTER TABLE messages ADD COLUMN file_size INTEGER")
    ensure_column(conn, "messages", "duration_sec", "ALTER TABLE messages ADD COLUMN duration_sec REAL")
    ensure_column(conn, "messages", "waveform_json", "ALTER TABLE messages ADD COLUMN waveform_json TEXT")

    conn.commit()
    conn.close()


def can_access_pair(conn, me, peer_id):
    row = conn.execute("SELECT id FROM users WHERE id = ?", (peer_id,)).fetchone()
    return bool(row and int(me) != int(peer_id))


def serialize_messages(conn, rows, viewer_id):
    message_ids = [r["id"] for r in rows]
    reactions_map = {mid: [] for mid in message_ids}
    if message_ids:
        placeholders = ",".join(["?"] * len(message_ids))
        reaction_rows = conn.execute(
            f"""
            SELECT r.message_id, r.user_id, u.username, r.emoji
            FROM message_reactions r
            JOIN users u ON u.id = r.user_id
            WHERE r.message_id IN ({placeholders})
            ORDER BY r.id ASC
            """,
            message_ids,
        ).fetchall()
        for rr in reaction_rows:
            reactions_map[rr["message_id"]].append(
                {
                    "user_id": rr["user_id"],
                    "username": rr["username"],
                    "emoji": rr["emoji"],
                    "is_me": int(rr["user_id"]) == int(viewer_id),
                }
            )

    out = []
    for row in rows:
        item = dict(row)
        item["reactions"] = reactions_map.get(row["id"], [])
        item["is_forwarded"] = bool(row["forwarded_from_id"])
        if row["reply_to_id"]:
            item["reply_preview"] = {
                "id": row["reply_to_id"],
                "sender_name": row["reply_sender_name"],
                "content": row["reply_content"],
                "image_url": row["reply_image_url"],
            }
        else:
            item["reply_preview"] = None

        if not item.get("media_type") and item.get("image_url"):
            item["media_type"] = "image"
            item["media_url"] = item["image_url"]

        waveform = item.get("waveform_json")
        if waveform:
            try:
                item["waveform"] = json.loads(waveform)
            except json.JSONDecodeError:
                item["waveform"] = []
        else:
            item["waveform"] = []

        out.append(item)
    return out


def emit_message_status_bulk(conn, recipient_id, from_status, to_status):
    rows = conn.execute(
        "SELECT id, sender_id FROM messages WHERE recipient_id = ? AND status = ?",
        (recipient_id, from_status),
    ).fetchall()
    if not rows:
        return

    ids = [r["id"] for r in rows]
    conn.execute(
        f"UPDATE messages SET status = ? WHERE id IN ({','.join(['?'] * len(ids))})",
        [to_status, *ids],
    )

    by_sender = {}
    for r in rows:
        by_sender.setdefault(r["sender_id"], []).append(r["id"])

    for sender_id, sender_ids in by_sender.items():
        emit("message_status", {"message_ids": sender_ids, "status": to_status}, room=f"user_{sender_id}")


@app.before_request
def require_login_for_chat():
    public_routes = {"login", "signup", "static"}
    if request.endpoint in public_routes or request.endpoint is None:
        return
    if request.path.startswith("/static/"):
        return
    if request.endpoint in {
        "index",
        "upload_image",
        "upload_media",
        "upload_avatar",
        "chat",
        "api_me",
        "api_contacts",
        "api_messages",
        "api_friend_search",
        "api_add_friend",
        "api_remove_friend",
    }:
        if "user_id" not in session:
            return redirect(url_for("login"))


@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("chat"))
    return redirect(url_for("login"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""

        if len(username) < 3 or "@" not in email or len(password) < 6:
            return render_template("signup.html", error="Invalid input. Use valid email and 6+ char password.")

        password_hash = generate_password_hash(password)
        default_avatar = f"https://ui-avatars.com/api/?name={username}&background=1b9aaa&color=fff"

        conn = get_db()
        try:
            cur = conn.execute(
                "INSERT INTO users (username, email, password_hash, avatar_url, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
                (username, email, password_hash, default_avatar, now_iso(), now_iso()),
            )
            conn.commit()
            session["user_id"] = cur.lastrowid
            return redirect(url_for("chat"))
        except sqlite3.IntegrityError:
            return render_template("signup.html", error="Username or email already exists.")
        finally:
            conn.close()

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""

        conn = get_db()
        user = conn.execute(
            "SELECT id, username, email, password_hash FROM users WHERE email = ?", (email,)
        ).fetchone()
        conn.close()

        if not user or not check_password_hash(user["password_hash"], password):
            return render_template("login.html", error="Invalid email or password.")

        session["user_id"] = user["id"]
        return redirect(url_for("chat"))

    return render_template("login.html")


@app.route("/logout")
def logout():
    session.pop("user_id", None)
    return redirect(url_for("login"))


@app.route("/chat")
def chat():
    user = auth_user()
    if not user:
        return redirect(url_for("login"))
    return render_template("chat.html", me=dict(user))


@app.route("/api/me")
def api_me():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify(dict(user))


@app.route("/api/contacts")
def api_contacts():
    me = session["user_id"]
    conn = get_db()
    contacts = conn.execute(
        """
        SELECT u.id, u.username, u.email, u.avatar_url, u.last_seen,
               (
                 SELECT COALESCE(m.content, m.file_name, '[media]')
                 FROM messages m
                 WHERE ((m.sender_id = u.id AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = u.id))
                   AND NOT EXISTS (
                      SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?
                   )
                 ORDER BY m.created_at DESC
                 LIMIT 1
               ) AS last_message,
               (
                 SELECT m.created_at
                 FROM messages m
                 WHERE ((m.sender_id = u.id AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = u.id))
                   AND NOT EXISTS (
                      SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?
                   )
                 ORDER BY m.created_at DESC
                 LIMIT 1
               ) AS last_message_time,
               (
                 SELECT COUNT(*)
                 FROM messages m
                 WHERE m.sender_id = u.id AND m.recipient_id = ? AND m.status != 'seen' AND m.deleted_at IS NULL
                   AND NOT EXISTS (
                      SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?
                   )
               ) AS unread_count
        FROM users u
        JOIN friends f ON f.friend_id = u.id AND f.user_id = ?
        WHERE u.id != ?
        ORDER BY COALESCE(last_message_time, u.created_at) DESC
        """,
        (me, me, me, me, me, me, me, me, me, me),
    ).fetchall()
    conn.close()

    result = []
    for row in contacts:
        item = dict(row)
        item["is_online"] = row["id"] in online_users
        item["device_count"] = len(user_sockets.get(row["id"], set()))
        result.append(item)

    return jsonify(result)


@app.route("/api/friends/search")
def api_friend_search():
    me = session["user_id"]
    q = (request.args.get("q") or "").strip().lower()
    conn = get_db()
    rows = conn.execute(
        """
        SELECT u.id, u.username, u.email, u.avatar_url
        FROM users u
        LEFT JOIN friends f ON f.friend_id = u.id AND f.user_id = ?
        WHERE u.id != ? AND f.id IS NULL
          AND (? = '' OR LOWER(u.username) LIKE ? OR LOWER(u.email) LIKE ?)
        ORDER BY u.username ASC
        LIMIT 20
        """,
        (me, me, q, f"%{q}%", f"%{q}%"),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/friends/add", methods=["POST"])
def api_add_friend():
    me = int(session["user_id"])
    payload = request.get_json(silent=True) or {}
    friend_id = int(payload.get("friend_id") or 0)
    if not friend_id or friend_id == me:
        return jsonify({"error": "Invalid friend"}), 400

    conn = get_db()
    target = conn.execute("SELECT id FROM users WHERE id = ?", (friend_id,)).fetchone()
    if not target:
        conn.close()
        return jsonify({"error": "User not found"}), 404

    conn.execute(
        "INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)",
        (me, friend_id, now_iso()),
    )
    conn.execute(
        "INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)",
        (friend_id, me, now_iso()),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/friends/remove", methods=["POST"])
def api_remove_friend():
    me = int(session["user_id"])
    payload = request.get_json(silent=True) or {}
    friend_id = int(payload.get("friend_id") or 0)
    if not friend_id:
        return jsonify({"error": "Invalid friend"}), 400
    conn = get_db()
    conn.execute("DELETE FROM friends WHERE user_id = ? AND friend_id = ?", (me, friend_id))
    conn.execute("DELETE FROM friends WHERE user_id = ? AND friend_id = ?", (friend_id, me))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/messages/<int:peer_id>")
def api_messages(peer_id):
    me = session["user_id"]
    limit = min(max(int(request.args.get("limit", 30)), 1), 100)
    before_id = request.args.get("before_id", type=int)

    conn = get_db()
    if not can_access_pair(conn, me, peer_id):
        conn.close()
        return jsonify({"error": "Contact not found"}), 404

    params = [me, peer_id, peer_id, me, me]
    before_clause = ""
    if before_id:
        before_clause = "AND m.id < ?"
        params.append(before_id)

    rows = conn.execute(
        f"""
        SELECT m.id, m.sender_id, m.recipient_id, m.content, m.image_url, m.media_url, m.media_type,
               m.file_name, m.file_size, m.duration_sec, m.waveform_json, m.reply_to_id,
               m.forwarded_from_id, m.status, m.created_at, m.edited_at, m.deleted_at,
               s.username AS sender_name,
               rs.username AS reply_sender_name,
               rm.content AS reply_content,
               rm.image_url AS reply_image_url
        FROM messages m
        JOIN users s ON s.id = m.sender_id
        LEFT JOIN messages rm ON rm.id = m.reply_to_id
        LEFT JOIN users rs ON rs.id = rm.sender_id
        WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          {before_clause}
        ORDER BY m.id DESC
        LIMIT ?
        """,
        (*params, limit),
    ).fetchall()

    has_more = len(rows) == limit
    rows_asc = list(reversed(rows))

    seen_rows = conn.execute(
        "SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status != 'seen'",
        (peer_id, me),
    ).fetchall()
    seen_ids = [r["id"] for r in seen_rows]
    if seen_ids:
        conn.execute(
            "UPDATE messages SET status = 'seen' WHERE sender_id = ? AND recipient_id = ? AND status != 'seen'",
            (peer_id, me),
        )
        socketio.emit("message_status", {"message_ids": seen_ids, "status": "seen"}, room=f"user_{peer_id}")

    conn.commit()
    messages = serialize_messages(conn, rows_asc, me)
    conn.close()

    return jsonify({"messages": messages, "has_more": has_more})


@app.route("/upload/media", methods=["POST"])
def upload_media():
    if "user_id" not in session:
        return jsonify({"error": "Unauthorized"}), 401

    if "media" not in request.files:
        return jsonify({"error": "No media uploaded"}), 400

    media = request.files["media"]
    if media.filename == "":
        return jsonify({"error": "No selected file"}), 400

    requested_type = (request.form.get("media_type") or "").strip().lower() or None
    media_type = classify_media(media.filename, preferred_type=requested_type)
    if not media_type:
        return jsonify({"error": "Unsupported media format"}), 400

    ext = media.filename.rsplit(".", 1)[1].lower()
    filename = secure_filename(f"media_{uuid.uuid4().hex}.{ext}")
    media_path = UPLOAD_DIR / filename
    media.save(media_path)

    return jsonify(
        {
            "media_url": url_for("static", filename=f"uploads/{filename}"),
            "media_type": media_type,
            "file_name": secure_filename(media.filename),
            "file_size": media_path.stat().st_size,
        }
    )


@app.route("/upload/image", methods=["POST"])
def upload_image():
    if "user_id" not in session:
        return jsonify({"error": "Unauthorized"}), 401

    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    image = request.files["image"]
    if image.filename == "":
        return jsonify({"error": "No selected file"}), 400

    if not allowed_file(image.filename):
        return jsonify({"error": "Invalid image format"}), 400

    ext = image.filename.rsplit(".", 1)[1].lower()
    filename = secure_filename(f"img_{uuid.uuid4().hex}.{ext}")
    image_path = UPLOAD_DIR / filename
    image.save(image_path)

    return jsonify({"image_url": url_for("static", filename=f"uploads/{filename}")})


@app.route("/upload/avatar", methods=["POST"])
def upload_avatar():
    if "user_id" not in session:
        return jsonify({"error": "Unauthorized"}), 401

    if "avatar" not in request.files:
        return jsonify({"error": "No avatar uploaded"}), 400

    avatar = request.files["avatar"]
    if avatar.filename == "" or not allowed_file(avatar.filename):
        return jsonify({"error": "Invalid avatar image"}), 400

    ext = avatar.filename.rsplit(".", 1)[1].lower()
    filename = secure_filename(f"avatar_{session['user_id']}_{uuid.uuid4().hex}.{ext}")
    avatar_path = UPLOAD_DIR / filename
    avatar.save(avatar_path)

    avatar_url = url_for("static", filename=f"uploads/{filename}")
    conn = get_db()
    conn.execute("UPDATE users SET avatar_url = ? WHERE id = ?", (avatar_url, session["user_id"]))
    conn.commit()
    conn.close()

    return jsonify({"avatar_url": avatar_url})


@socketio.on("connect")
def handle_connect():
    user = auth_user()
    if not user:
        return False

    user_id = int(user["id"])
    sid = request.sid
    sid_to_user[sid] = user_id
    sockets = user_sockets.setdefault(user_id, set())
    sockets.add(sid)
    online_users.add(user_id)
    join_room(f"user_{user_id}")

    conn = get_db()
    emit_message_status_bulk(conn, user_id, "sent", "delivered")
    conn.commit()
    conn.close()

    emit(
        "presence",
        {
            "user_id": user_id,
            "status": "online",
            "is_online": True,
            "device_count": len(sockets),
            "last_seen": None,
        },
        broadcast=True,
    )


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    user_id = sid_to_user.pop(sid, None) or session.get("user_id")
    if not user_id:
        return

    user_id = int(user_id)
    sockets = user_sockets.get(user_id, set())
    sockets.discard(sid)

    if sockets:
        emit(
            "presence",
            {
                "user_id": user_id,
                "status": "online",
                "is_online": True,
                "device_count": len(sockets),
                "last_seen": None,
            },
            broadcast=True,
        )
        return

    user_sockets.pop(user_id, None)
    online_users.discard(user_id)
    last_seen = now_iso()
    conn = get_db()
    conn.execute("UPDATE users SET last_seen = ? WHERE id = ?", (last_seen, user_id))
    conn.commit()
    conn.close()

    emit(
        "presence",
        {
            "user_id": user_id,
            "status": "offline",
            "is_online": False,
            "device_count": 0,
            "last_seen": last_seen,
        },
        broadcast=True,
    )


@socketio.on("join_chat")
def handle_join_chat(data):
    me = session.get("user_id")
    peer_id = int((data or {}).get("peer_id", 0))
    if not me or not peer_id:
        return

    join_room(f"chat_{min(int(me), peer_id)}_{max(int(me), peer_id)}")

    conn = get_db()
    unseen = conn.execute(
        "SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status != 'seen'",
        (peer_id, me),
    ).fetchall()
    ids = [r["id"] for r in unseen]
    if ids:
        conn.execute(
            "UPDATE messages SET status = 'seen' WHERE sender_id = ? AND recipient_id = ? AND status != 'seen'",
            (peer_id, me),
        )
        conn.commit()
    conn.close()

    if ids:
        emit("message_status", {"message_ids": ids, "status": "seen"}, room=f"user_{peer_id}")


@socketio.on("typing")
def handle_typing(data):
    me = session.get("user_id")
    if not me:
        return

    recipient_id = int((data or {}).get("recipient_id", 0))
    is_typing = bool((data or {}).get("is_typing", False))
    if not recipient_id:
        return

    emit("typing", {"from_user_id": me, "to_user_id": recipient_id, "is_typing": is_typing}, room=f"user_{recipient_id}")


@socketio.on("send_message")
def handle_send_message(data):
    me = session.get("user_id")
    if not me:
        return

    recipient_id = int((data or {}).get("recipient_id", 0))
    content = ((data or {}).get("content") or "").strip()
    image_url = ((data or {}).get("image_url") or "").strip()
    media_url = ((data or {}).get("media_url") or "").strip()
    media_type = ((data or {}).get("media_type") or "").strip().lower()
    file_name = ((data or {}).get("file_name") or "").strip()
    file_size = int((data or {}).get("file_size") or 0)
    duration_sec = float((data or {}).get("duration_sec") or 0)
    waveform = (data or {}).get("waveform") or []
    reply_to_id = int((data or {}).get("reply_to_id") or 0)
    forwarded_from_id = int((data or {}).get("forwarded_from_id") or 0)

    if not recipient_id:
        return
    if not content and not image_url and not media_url:
        return

    if len(content) > 2000:
        content = content[:2000]

    if image_url and not media_url:
        media_url = image_url
        media_type = "image"

    if media_url and media_type not in {"image", "video", "document", "audio", "voice"}:
        return

    if duration_sec < 0:
        duration_sec = 0

    if not isinstance(waveform, list):
        waveform = []
    waveform = waveform[:80]

    status = "delivered" if recipient_id in online_users else "sent"

    conn = get_db()
    if not can_access_pair(conn, me, recipient_id):
        conn.close()
        return

    valid_reply_to = None
    if reply_to_id:
        reply_row = conn.execute(
            """
            SELECT id FROM messages
            WHERE id = ?
              AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
            """,
            (reply_to_id, me, recipient_id, recipient_id, me),
        ).fetchone()
        valid_reply_to = reply_to_id if reply_row else None

    valid_forward = None
    if forwarded_from_id:
        fw_row = conn.execute(
            "SELECT id FROM messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)",
            (forwarded_from_id, me, me),
        ).fetchone()
        valid_forward = forwarded_from_id if fw_row else None

    user = conn.execute("SELECT username FROM users WHERE id = ?", (me,)).fetchone()
    cur = conn.execute(
        """
        INSERT INTO messages (
          sender_id, recipient_id, content, image_url, media_url, media_type, file_name, file_size,
          duration_sec, waveform_json, reply_to_id, forwarded_from_id, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            me,
            recipient_id,
            content,
            image_url or None,
            media_url or None,
            media_type or None,
            file_name[:255] if file_name else None,
            file_size if file_size > 0 else None,
            duration_sec if duration_sec > 0 else None,
            json.dumps(waveform) if waveform else None,
            valid_reply_to,
            valid_forward,
            status,
            now_iso(),
        ),
    )
    message_id = cur.lastrowid

    msg_row = conn.execute(
        """
        SELECT m.id, m.sender_id, m.recipient_id, m.content, m.image_url, m.media_url, m.media_type,
               m.file_name, m.file_size, m.duration_sec, m.waveform_json, m.reply_to_id,
               m.forwarded_from_id, m.status, m.created_at, m.edited_at, m.deleted_at,
               s.username AS sender_name,
               rs.username AS reply_sender_name,
               rm.content AS reply_content,
               rm.image_url AS reply_image_url
        FROM messages m
        JOIN users s ON s.id = m.sender_id
        LEFT JOIN messages rm ON rm.id = m.reply_to_id
        LEFT JOIN users rs ON rs.id = rm.sender_id
        WHERE m.id = ?
        """,
        (message_id,),
    ).fetchall()

    conn.commit()
    payload = serialize_messages(conn, msg_row, me)[0]
    payload["sender_name"] = user["username"] if user else "Unknown"
    conn.close()

    emit("new_message", payload, room=f"user_{me}")
    emit("new_message", payload, room=f"user_{recipient_id}")


@socketio.on("edit_message")
def handle_edit_message(data):
    me = session.get("user_id")
    message_id = int((data or {}).get("message_id") or 0)
    content = ((data or {}).get("content") or "").strip()
    if not me or not message_id:
        return
    if not content:
        return

    conn = get_db()
    msg = conn.execute(
        "SELECT id, sender_id, recipient_id, deleted_at FROM messages WHERE id = ?",
        (message_id,),
    ).fetchone()
    if not msg or int(msg["sender_id"]) != int(me) or msg["deleted_at"]:
        conn.close()
        return

    edited_at = now_iso()
    conn.execute(
        "UPDATE messages SET content = ?, edited_at = ? WHERE id = ?",
        (content[:2000], edited_at, message_id),
    )
    conn.commit()
    conn.close()

    emit(
        "message_edited",
        {"message_id": message_id, "content": content[:2000], "edited_at": edited_at},
        room=f"user_{msg['sender_id']}",
    )
    emit(
        "message_edited",
        {"message_id": message_id, "content": content[:2000], "edited_at": edited_at},
        room=f"user_{msg['recipient_id']}",
    )


@socketio.on("react_message")
def handle_react_message(data):
    me = session.get("user_id")
    message_id = int((data or {}).get("message_id") or 0)
    emoji = ((data or {}).get("emoji") or "").strip()
    if not me or not message_id or len(emoji) > 12:
        return

    conn = get_db()
    msg = conn.execute(
        "SELECT id, sender_id, recipient_id FROM messages WHERE id = ?",
        (message_id,),
    ).fetchone()
    if not msg or int(me) not in (int(msg["sender_id"]), int(msg["recipient_id"])):
        conn.close()
        return

    existing = conn.execute(
        "SELECT id, emoji FROM message_reactions WHERE message_id = ? AND user_id = ?",
        (message_id, me),
    ).fetchone()

    if not emoji:
        conn.execute("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?", (message_id, me))
    elif existing and existing["emoji"] == emoji:
        conn.execute("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?", (message_id, me))
    elif existing:
        conn.execute(
            "UPDATE message_reactions SET emoji = ?, created_at = ? WHERE id = ?",
            (emoji, now_iso(), existing["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
            (message_id, me, emoji, now_iso()),
        )

    reaction_rows = conn.execute(
        """
        SELECT r.message_id, r.user_id, u.username, r.emoji
        FROM message_reactions r
        JOIN users u ON u.id = r.user_id
        WHERE r.message_id = ?
        ORDER BY r.id ASC
        """,
        (message_id,),
    ).fetchall()
    conn.commit()
    conn.close()

    reactions = [
        {
            "user_id": rr["user_id"],
            "username": rr["username"],
            "emoji": rr["emoji"],
            "is_me": int(rr["user_id"]) == int(me),
        }
        for rr in reaction_rows
    ]

    payload = {"message_id": message_id, "reactions": reactions}
    emit("message_reactions", payload, room=f"user_{msg['sender_id']}")
    emit("message_reactions", payload, room=f"user_{msg['recipient_id']}")


@socketio.on("delete_message")
def handle_delete_message(data):
    me = session.get("user_id")
    msg_id = int((data or {}).get("message_id") or 0)
    mode = ((data or {}).get("mode") or "everyone").strip().lower()
    if not me or not msg_id:
        return

    conn = get_db()
    msg = conn.execute(
        "SELECT id, sender_id, recipient_id, deleted_at FROM messages WHERE id = ?",
        (msg_id,),
    ).fetchone()
    if not msg:
        conn.close()
        return

    if mode == "me":
        if int(me) not in (int(msg["sender_id"]), int(msg["recipient_id"])):
            conn.close()
            return
        conn.execute(
            "INSERT OR IGNORE INTO message_hidden (message_id, user_id, created_at) VALUES (?, ?, ?)",
            (msg_id, me, now_iso()),
        )
        conn.commit()
        conn.close()
        emit("message_hidden", {"message_id": msg_id}, room=f"user_{me}")
        return

    if int(msg["sender_id"]) != int(me) or msg["deleted_at"]:
        conn.close()
        return

    deleted_at = now_iso()
    conn.execute(
        """
        UPDATE messages
        SET content = '', image_url = NULL, media_url = NULL, media_type = NULL, file_name = NULL,
            file_size = NULL, duration_sec = NULL, waveform_json = NULL, edited_at = NULL, deleted_at = ?
        WHERE id = ?
        """,
        (deleted_at, msg_id),
    )
    conn.execute("DELETE FROM message_reactions WHERE message_id = ?", (msg_id,))
    conn.commit()
    conn.close()

    emit("message_deleted", {"message_id": msg_id, "mode": "everyone"}, room=f"user_{msg['sender_id']}")
    emit("message_deleted", {"message_id": msg_id, "mode": "everyone"}, room=f"user_{msg['recipient_id']}")


if __name__ == "__main__":
    init_db()
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)
