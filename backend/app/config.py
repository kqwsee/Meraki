from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    data_dir: Path = BASE_DIR / "data"
    secret_key: str = "change-me-in-production"
    token_ttl_hours: int = 24 * 7
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # LLM provider: "claude_cli" (Claude subscription via headless `claude -p`) or "openai" (any OpenAI-compatible API)
    llm_provider: str = "claude_cli"
    # Two tiers: "fast" for dialogue, "smart" for course structuring and grading
    llm_model_fast: str = "haiku"
    llm_model_smart: str = "sonnet"
    llm_max_concurrency: int = 3
    llm_timeout_seconds: int = 300

    claude_cli_path: str = ""  # empty = auto-detect
    claude_effort: str = "low"

    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str = ""

    # Memory: "mempalace" (MCP subprocess) or "sqlite" (built-in fallback only)
    memory_backend: str = "mempalace"
    mempalace_command: str = ""  # empty = .venv/Scripts/mempalace-mcp(.exe)

    # Course material import: Wikimedia and others require a descriptive User-Agent with a URL/contact
    public_url: str = "http://localhost:5173"
    fetch_contact: str = ""

    # Integrity heuristics
    paste_flag_chars: int = 40
    burst_cpm_floor: int = 650
    burst_baseline_factor: float = 3.0

    @property
    def db_path(self) -> Path:
        return self.data_dir / "meraki.db"

    @property
    def palace_path(self) -> Path:
        return self.data_dir / "palace"


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
