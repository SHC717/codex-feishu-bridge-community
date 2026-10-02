"""Minimum read-only Codex metadata, with explicit per-device path and schema gates."""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

REQUIRED_COLUMNS = {
    "threads": {"id", "cwd", "project_id", "updated_at", "updated_at_ms", "archived", "thread_source", "source"},
    "thread_spawn_edges": {"child_thread_id"},
}

def validate_schema(connection):
    for table, required in REQUIRED_COLUMNS.items():
        present = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        if not required.issubset(present):
            raise ValueError(f"unsupported_codex_schema:{table}")
    # Also require the JSON support used by the exclusion predicates.
    if connection.execute("SELECT json_valid('{}')").fetchone()[0] != 1:
        raise ValueError("sqlite_json_unavailable")

def list_user_threads(database, validate_only=False):
    database = Path(database)
    if not database.is_absolute() or not database.is_file():
        raise ValueError("explicit_existing_database_required")
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        validate_schema(connection)
        if validate_only:
            return {"compatible": True, "readOnly": True}
        connection.row_factory = sqlite3.Row
        rows = connection.execute("""
            SELECT t.id, t.cwd, t.project_id, t.updated_at, t.updated_at_ms
            FROM threads AS t
            WHERE t.archived = 0
              AND lower(trim(coalesce(t.thread_source, ''), '" '))
                    NOT IN ('subagent', 'guardian_review', 'ambient_suggestions')
              AND lower(trim(coalesce(t.source, ''), '" '))
                    NOT IN ('subagent', 'guardian_review')
              AND CASE WHEN json_valid(t.source) THEN
                    json_type(t.source, '$.subagent') IS NULL
                    AND json_type(t.source, '$.subAgent') IS NULL
                  ELSE 1 END
              AND NOT EXISTS (SELECT 1 FROM thread_spawn_edges AS edge WHERE edge.child_thread_id = t.id)
            ORDER BY coalesce(t.updated_at_ms, t.updated_at * 1000) DESC, t.id
        """).fetchall()
        threads = [dict(row) for row in rows]
        return {"count": len(threads), "threads": threads}
    finally:
        connection.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default=os.environ.get("CODEX_FEISHU_DATABASE"))
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    if not args.database:
        parser.error("explicit local database configuration required")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        json.dump(list_user_threads(args.database, args.validate), sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
    except (ValueError, sqlite3.Error) as error:
        code = "metadata_incompatible" if isinstance(error, ValueError) and str(error).startswith(("unsupported_codex_schema:", "sqlite_json_unavailable")) else "metadata_unavailable"
        sys.stderr.write("CFB_FAILURE:" + code + "\n")
        sys.exit(1)
