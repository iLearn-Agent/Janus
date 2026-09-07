from __future__ import annotations

from pathlib import Path
import shutil
import sqlite3
import uuid

from .agent_defs import AgentDefinition
from .paths import db_path, legacy_db_path


def utc_now_sql() -> str:
    return "strftime('%Y-%m-%dT%H:%M:%fZ','now')"


def connect(root: Path | None = None) -> sqlite3.Connection:
    path = db_path(root)
    legacy = legacy_db_path(root)
    if not path.exists() and legacy.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy), str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  hr_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_agent_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, agent_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS evolution_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hr_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'skipped', 'failed')),
  evidence_message_count INTEGER NOT NULL DEFAULT 0,
  proposal_path TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS hr_reviews (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  hr_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'skipped', 'failed')),
  proposal_path TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS pending_evolutions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed')) DEFAULT 'pending',
  evolution_run_id TEXT REFERENCES evolution_runs(id),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS evolution_archives (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evolution_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL DEFAULT '',
  parent_archive_id TEXT DEFAULT '',
  proposal_path TEXT NOT NULL DEFAULT '',
  proposal_hash TEXT NOT NULL DEFAULT '',
  gate_status TEXT NOT NULL DEFAULT 'pending',
  gate_score REAL NOT NULL DEFAULT 0.0,
  gate_reasons_json TEXT NOT NULL DEFAULT '[]',
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  skill_snapshot_path TEXT NOT NULL DEFAULT '',
  memory_snapshot_path TEXT NOT NULL DEFAULT '',
  post_skill_hash TEXT NOT NULL DEFAULT '',
  post_memory_hash TEXT NOT NULL DEFAULT '',
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS typed_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'evolution',
  source_run_id TEXT NOT NULL DEFAULT '',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  privacy_level TEXT NOT NULL DEFAULT 'public_reusable',
  status TEXT NOT NULL DEFAULT 'active',
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_credit_assignments (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES evolution_runs(id) ON DELETE SET NULL,
  review_id TEXT REFERENCES hr_reviews(id) ON DELETE SET NULL,
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  workflow_step TEXT NOT NULL DEFAULT '',
  failure_type TEXT NOT NULL DEFAULT '',
  responsibility REAL NOT NULL DEFAULT 0.0,
  evidence_summary TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS specialist_experiments (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  candidate_agent_id TEXT NOT NULL,
  baseline_agent_id TEXT NOT NULL DEFAULT '',
  started_by_review_id TEXT REFERENCES hr_reviews(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'shadow',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  decision_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated
  ON sessions(agent_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_pending_evolutions_status
  ON pending_evolutions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_evolution_archives_run
  ON evolution_archives(run_id);
CREATE INDEX IF NOT EXISTS idx_typed_memories_agent_status
  ON typed_memories(agent_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_workflow_credit_department
  ON workflow_credit_assignments(department_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_specialist_experiments_department
  ON specialist_experiments(department_id, state, created_at);
"""


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _index_columns(conn: sqlite3.Connection, index_name: str) -> list[str]:
    escaped = index_name.replace("'", "''")
    return [row["name"] for row in conn.execute(f"PRAGMA index_info('{escaped}')").fetchall()]


def _pending_evolutions_has_old_unique_constraint(conn: sqlite3.Connection) -> bool:
    for row in conn.execute("PRAGMA index_list(pending_evolutions)").fetchall():
        if not row["unique"]:
            continue
        if _index_columns(conn, row["name"]) == ["session_id", "agent_id", "status"]:
            return True
    return False


def _rebuild_pending_evolutions_without_unique_constraint(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("ALTER TABLE pending_evolutions RENAME TO pending_evolutions_old")
        conn.execute(
            """
            CREATE TABLE pending_evolutions (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
              agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed')) DEFAULT 'pending',
              evolution_run_id TEXT REFERENCES evolution_runs(id),
              error TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )
            """
        )
        conn.execute(
            """
            INSERT INTO pending_evolutions (
              id, session_id, agent_id, user_id, status, evolution_run_id,
              error, created_at, updated_at
            )
            SELECT id, session_id, agent_id, user_id, status, evolution_run_id,
                   error, created_at, updated_at
            FROM pending_evolutions_old
            """
        )
        conn.execute("DROP TABLE pending_evolutions_old")
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    if _pending_evolutions_has_old_unique_constraint(conn):
        _rebuild_pending_evolutions_without_unique_constraint(conn)
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_pending_evolutions_status
              ON pending_evolutions(status, updated_at)
            """
        )
    agent_cols = _columns(conn, "agents")
    if "department_id" not in agent_cols:
        conn.execute("ALTER TABLE agents ADD COLUMN department_id TEXT NOT NULL DEFAULT ''")
    if "hr_id" not in agent_cols:
        conn.execute("ALTER TABLE agents ADD COLUMN hr_id TEXT NOT NULL DEFAULT ''")
    if "leader_id" in agent_cols:
        conn.execute("UPDATE agents SET hr_id = leader_id WHERE hr_id = ''")
    evolution_cols = _columns(conn, "evolution_runs")
    if "hr_id" not in evolution_cols:
        conn.execute("ALTER TABLE evolution_runs ADD COLUMN hr_id TEXT NOT NULL DEFAULT ''")
    if "leader_id" in evolution_cols:
        conn.execute("UPDATE evolution_runs SET hr_id = leader_id WHERE hr_id = ''")
    conn.commit()


def seed_agents(conn: sqlite3.Connection, agents: dict[str, AgentDefinition]) -> None:
    import json

    for agent in agents.values():
        cols = _columns(conn, "agents")
        if "leader_id" in cols:
            conn.execute(
                """
                INSERT INTO agents (
                  id, name, description, leader_id, department_id, hr_id, config_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name,
                  description=excluded.description,
                  leader_id=excluded.leader_id,
                  department_id=excluded.department_id,
                  hr_id=excluded.hr_id,
                  config_json=excluded.config_json,
                  updated_at=excluded.updated_at
                """,
                (
                    agent.id,
                    agent.name,
                    agent.description,
                    agent.hr_id,
                    agent.department_id,
                    agent.hr_id,
                    json.dumps(agent.__dict__, sort_keys=True),
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO agents (
                  id, name, description, department_id, hr_id, config_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name,
                  description=excluded.description,
                  department_id=excluded.department_id,
                  hr_id=excluded.hr_id,
                  config_json=excluded.config_json,
                  updated_at=excluded.updated_at
                """,
                (
                    agent.id,
                    agent.name,
                    agent.description,
                    agent.department_id,
                    agent.hr_id,
                    json.dumps(agent.__dict__, sort_keys=True),
                ),
            )
    conn.commit()


def ensure_user(conn: sqlite3.Connection, user_id: str, display_name: str, role: str = "member") -> None:
    conn.execute(
        """
        INSERT INTO users (id, display_name, role)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name=excluded.display_name,
          role=excluded.role
        """,
        (user_id, display_name, role),
    )
    conn.commit()


def get_user(conn: sqlite3.Connection, user_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def require_user(conn: sqlite3.Connection, user_id: str) -> sqlite3.Row:
    row = get_user(conn, user_id)
    if row is None:
        raise ValueError(f"Unknown user: {user_id}")
    return row


def require_admin(conn: sqlite3.Connection, admin_id: str) -> None:
    row = require_user(conn, admin_id)
    if row["role"] != "admin":
        raise PermissionError(f"User is not an admin: {admin_id}")


def list_users(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT id, display_name, role, created_at FROM users ORDER BY created_at").fetchall()


def count_users(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()
    return int(row["count"])


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return None if row is None else row["value"]


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO app_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value=excluded.value,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        """,
        (key, value),
    )
    conn.commit()


def list_agents(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT id, name, department_id, hr_id, description, enabled
        FROM agents ORDER BY department_id, id
        """
    ).fetchall()


def agent_exists(conn: sqlite3.Connection, agent_id: str) -> bool:
    return conn.execute("SELECT 1 FROM agents WHERE id = ? AND enabled = 1", (agent_id,)).fetchone() is not None


def grant_access(conn: sqlite3.Connection, granted_by: str, user_id: str, agent_id: str) -> None:
    require_user(conn, granted_by)
    require_user(conn, user_id)
    if not agent_exists(conn, agent_id):
        raise ValueError(f"Unknown or disabled agent: {agent_id}")
    conn.execute(
        """
        INSERT OR IGNORE INTO user_agent_access (user_id, agent_id, granted_by)
        VALUES (?, ?, ?)
        """,
        (user_id, agent_id, granted_by),
    )
    conn.commit()


def has_access(conn: sqlite3.Connection, user_id: str, agent_id: str) -> bool:
    user = get_user(conn, user_id)
    if user is None:
        return False
    if user["role"] == "admin":
        return agent_exists(conn, agent_id)
    return (
        conn.execute(
            "SELECT 1 FROM user_agent_access WHERE user_id = ? AND agent_id = ?",
            (user_id, agent_id),
        ).fetchone()
        is not None
    )


def list_accessible_agents(conn: sqlite3.Connection, user_id: str) -> list[sqlite3.Row]:
    user = require_user(conn, user_id)
    if user["role"] == "admin":
        return conn.execute(
            """
            SELECT id, name, department_id, hr_id, description, enabled
            FROM agents
            WHERE enabled = 1
            ORDER BY department_id, id
            """
        ).fetchall()
    return conn.execute(
        """
        SELECT a.id, a.name, a.department_id, a.hr_id, a.description, a.enabled
        FROM agents a
        JOIN user_agent_access access ON access.agent_id = a.id
        WHERE access.user_id = ? AND a.enabled = 1
        ORDER BY a.department_id, a.id
        """,
        (user_id,),
    ).fetchall()


def create_session(conn: sqlite3.Connection, user_id: str, agent_id: str, title: str | None = None) -> str:
    require_user(conn, user_id)
    if not has_access(conn, user_id, agent_id):
        raise PermissionError(f"User '{user_id}' does not have access to agent '{agent_id}'")
    session_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO sessions (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)",
        (session_id, user_id, agent_id, title or f"{agent_id} session"),
    )
    conn.commit()
    return session_id


def get_session(conn: sqlite3.Connection, session_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()


def get_session_updated_at(conn: sqlite3.Connection, session_id: str) -> str | None:
    row = conn.execute("SELECT updated_at FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return None if row is None else row["updated_at"]


def require_session_owner(conn: sqlite3.Connection, session_id: str, user_id: str) -> sqlite3.Row:
    row = get_session(conn, session_id)
    if row is None:
        raise ValueError(f"Unknown session: {session_id}")
    user = require_user(conn, user_id)
    if user["role"] != "admin" and row["user_id"] != user_id:
        raise PermissionError("Only the session owner or an admin can open this session")
    if not has_access(conn, user_id, row["agent_id"]):
        raise PermissionError(f"User '{user_id}' no longer has access to agent '{row['agent_id']}'")
    return row


def list_sessions(conn: sqlite3.Connection, user_id: str, agent_id: str | None = None) -> list[sqlite3.Row]:
    user = require_user(conn, user_id)
    if user["role"] == "admin":
        if agent_id:
            return conn.execute(
                """
                SELECT id, user_id, agent_id, title, archived, created_at, updated_at
                FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC
                """,
                (agent_id,),
            ).fetchall()
        return conn.execute(
            """
            SELECT id, user_id, agent_id, title, archived, created_at, updated_at
            FROM sessions ORDER BY updated_at DESC
            """
        ).fetchall()
    if agent_id:
        return conn.execute(
            """
            SELECT id, user_id, agent_id, title, archived, created_at, updated_at
            FROM sessions WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC
            """,
            (user_id, agent_id),
        ).fetchall()
    return conn.execute(
        """
        SELECT id, user_id, agent_id, title, archived, created_at, updated_at
        FROM sessions WHERE user_id = ? ORDER BY updated_at DESC
        """,
        (user_id,),
    ).fetchall()


def add_message(conn: sqlite3.Connection, session_id: str, role: str, content: str) -> str:
    message_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
        (message_id, session_id, role, content),
    )
    conn.execute(
        "UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        (session_id,),
    )
    conn.commit()
    return message_id


def get_messages(conn: sqlite3.Connection, session_id: str, limit: int | None = None) -> list[sqlite3.Row]:
    sql = "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at"
    params: tuple[object, ...] = (session_id,)
    if limit is not None:
        sql = f"SELECT * FROM ({sql}) ORDER BY created_at DESC LIMIT ?"
        params = (session_id, limit)
    rows = conn.execute(sql, params).fetchall()
    if limit is not None:
        return list(reversed(rows))
    return rows


def recent_agent_messages(conn: sqlite3.Connection, agent_id: str, limit: int = 50) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT m.role, m.content, m.created_at, s.id AS session_id
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE s.agent_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
        """,
        (agent_id, limit),
    ).fetchall()


def create_evolution_run(conn: sqlite3.Connection, agent_id: str, hr_id: str, count: int) -> str:
    run_id = str(uuid.uuid4())
    cols = _columns(conn, "evolution_runs")
    if "leader_id" in cols:
        conn.execute(
            """
            INSERT INTO evolution_runs (id, agent_id, leader_id, hr_id, status, evidence_message_count)
            VALUES (?, ?, ?, ?, 'proposed', ?)
            """,
            (run_id, agent_id, hr_id, hr_id, count),
        )
    else:
        conn.execute(
            """
            INSERT INTO evolution_runs (id, agent_id, hr_id, status, evidence_message_count)
            VALUES (?, ?, ?, 'proposed', ?)
            """,
            (run_id, agent_id, hr_id, count),
        )
    conn.commit()
    return run_id


def finish_evolution_run(
    conn: sqlite3.Connection,
    run_id: str,
    status: str,
    proposal_path: str = "",
    summary: str = "",
) -> None:
    conn.execute(
        """
        UPDATE evolution_runs
        SET status = ?, proposal_path = ?, summary = ?,
            finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
        """,
        (status, proposal_path, summary, run_id),
    )
    conn.commit()


def list_evolution_runs(conn: sqlite3.Connection, agent_id: str | None = None) -> list[sqlite3.Row]:
    if agent_id:
        return conn.execute(
            """
            SELECT id, agent_id, hr_id, status, evidence_message_count,
                   proposal_path, summary, started_at, finished_at
            FROM evolution_runs WHERE agent_id = ? ORDER BY started_at DESC
            """,
            (agent_id,),
        ).fetchall()
    return conn.execute(
        """
        SELECT id, agent_id, hr_id, status, evidence_message_count,
               proposal_path, summary, started_at, finished_at
        FROM evolution_runs ORDER BY started_at DESC
        """
    ).fetchall()


def get_evolution_run(conn: sqlite3.Connection, run_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM evolution_runs WHERE id = ?", (run_id,)).fetchone()


def mark_evolution_applied(conn: sqlite3.Connection, run_id: str) -> None:
    conn.execute("UPDATE evolution_runs SET status = 'applied' WHERE id = ?", (run_id,))
    conn.commit()


def enqueue_pending_evolution(conn: sqlite3.Connection, session_id: str, agent_id: str, user_id: str) -> str:
    existing = conn.execute(
        """
        SELECT id FROM pending_evolutions
        WHERE session_id = ? AND agent_id = ? AND status = 'pending'
        """,
        (session_id, agent_id),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE pending_evolutions
            SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?
            """,
            (existing["id"],),
        )
        conn.commit()
        return existing["id"]
    pending_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO pending_evolutions (id, session_id, agent_id, user_id)
        VALUES (?, ?, ?, ?)
        """,
        (pending_id, session_id, agent_id, user_id),
    )
    conn.commit()
    return pending_id


def list_pending_evolutions(conn: sqlite3.Connection, status: str | None = None) -> list[sqlite3.Row]:
    if status:
        return conn.execute(
            """
            SELECT p.id, p.session_id, p.agent_id, p.user_id, p.status,
                   p.evolution_run_id, p.error, p.created_at, p.updated_at,
                   s.updated_at AS session_updated_at
            FROM pending_evolutions p
            JOIN sessions s ON s.id = p.session_id
            WHERE p.status = ?
            ORDER BY p.updated_at
            """,
            (status,),
        ).fetchall()
    return conn.execute(
        """
        SELECT p.id, p.session_id, p.agent_id, p.user_id, p.status,
               p.evolution_run_id, p.error, p.created_at, p.updated_at,
               s.updated_at AS session_updated_at
        FROM pending_evolutions p
        JOIN sessions s ON s.id = p.session_id
        ORDER BY p.updated_at
        """
    ).fetchall()


def mark_pending_running(conn: sqlite3.Connection, pending_id: str) -> None:
    conn.execute(
        """
        UPDATE pending_evolutions
        SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
        """,
        (pending_id,),
    )
    conn.commit()


def finish_pending_evolution(
    conn: sqlite3.Connection,
    pending_id: str,
    status: str,
    evolution_run_id: str | None = None,
    error: str = "",
) -> None:
    conn.execute(
        """
        UPDATE pending_evolutions
        SET status = ?, evolution_run_id = ?, error = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
        """,
        (status, evolution_run_id, error, pending_id),
    )
    conn.commit()


def create_hr_review(conn: sqlite3.Connection, department_id: str, hr_id: str) -> str:
    review_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO hr_reviews (id, department_id, hr_id, status)
        VALUES (?, ?, ?, 'proposed')
        """,
        (review_id, department_id, hr_id),
    )
    conn.commit()
    return review_id


def finish_hr_review(
    conn: sqlite3.Connection,
    review_id: str,
    status: str,
    proposal_path: str = "",
    summary: str = "",
) -> None:
    conn.execute(
        """
        UPDATE hr_reviews
        SET status = ?, proposal_path = ?, summary = ?,
            finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
        """,
        (status, proposal_path, summary, review_id),
    )
    conn.commit()


def list_hr_reviews(conn: sqlite3.Connection, department_id: str | None = None) -> list[sqlite3.Row]:
    if department_id:
        return conn.execute(
            """
            SELECT id, department_id, hr_id, status, proposal_path, summary, started_at, finished_at
            FROM hr_reviews WHERE department_id = ? ORDER BY started_at DESC
            """,
            (department_id,),
        ).fetchall()
    return conn.execute(
        """
        SELECT id, department_id, hr_id, status, proposal_path, summary, started_at, finished_at
        FROM hr_reviews ORDER BY started_at DESC
        """
    ).fetchall()
