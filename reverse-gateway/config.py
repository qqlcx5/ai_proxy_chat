import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

REVERSE_BASE_URL = os.environ["REVERSE_API_URL"].removesuffix("/chat/completions")
REVERSE_API_KEY = os.environ["REVERSE_API_KEY"]
REVERSE_MODEL = os.getenv("REVERSE_API_MODEL", "gpt-5.2")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "8000"))
DEBUG = os.getenv("DEBUG_MODE", "false").lower() == "true"
MAX_TOOL_ROUNDS = int(os.getenv("MAX_TOOL_ROUNDS", "5"))
EXEC_TIMEOUT = int(os.getenv("EXEC_TIMEOUT", "30"))
WORKSPACE = Path(os.getenv("WORKSPACE", str(Path.cwd())))

# Copy .env to project dir if not exists
ENV_PATH = Path(__file__).parent / ".env"
if not ENV_PATH.exists():
    parent_env = Path(__file__).parent.parent / ".env"
    if parent_env.exists():
        import shutil
        shutil.copy(parent_env, ENV_PATH)
        load_dotenv(ENV_PATH, override=True)
        REVERSE_BASE_URL = os.environ["REVERSE_API_URL"].removesuffix("/chat/completions")
        REVERSE_API_KEY = os.environ["REVERSE_API_KEY"]
        REVERSE_MODEL = os.getenv("REVERSE_API_MODEL", "gpt-5.2")
