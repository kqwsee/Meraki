from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

engine = create_engine(
    f"sqlite:///{settings.db_path.as_posix()}",
    connect_args={"check_same_thread": False, "timeout": 30},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _column_default_sql(column) -> str:
    default = column.default.arg if column.default is not None else None
    if callable(default):  # dict / list factories for JSON columns
        try:
            default = default(None)
        except TypeError:
            default = default()
    if default is None:
        return "NULL"
    if isinstance(default, bool):
        return "1" if default else "0"
    if isinstance(default, (int, float)):
        return str(default)
    if isinstance(default, (dict, list)):
        import json

        return "'" + json.dumps(default).replace("'", "''") + "'"
    return "'" + str(default).replace("'", "''") + "'"


def _add_missing_columns() -> None:
    """Lightweight forward migration: ALTER TABLE ADD COLUMN for columns added to models later."""
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {row[1] for row in conn.execute(text(f'PRAGMA table_info("{table.name}")'))}
            for column in table.columns:
                if column.name in existing:
                    continue
                col_type = column.type.compile(dialect=engine.dialect)
                conn.execute(
                    text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type} DEFAULT {_column_default_sql(column)}')
                )


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    if not settings.db_path.exists():
        # new database -> new memory namespace (see memory._wing)
        (settings.data_dir / "instance_id").unlink(missing_ok=True)
    Base.metadata.create_all(engine)
    _add_missing_columns()
    with engine.begin() as conn:
        # Full-text index over course material chunks (BM25 ranking for lecture/task context)
        conn.execute(
            text(
                "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5("
                "content, chunk_id UNINDEXED, course_id UNINDEXED, tokenize='unicode61 remove_diacritics 2')"
            )
        )
