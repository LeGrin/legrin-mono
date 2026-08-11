#!/usr/bin/env python3
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


env_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/legrin-finance-pipeline/shared/.env")
env = load_env(env_path)
token = env.get("MONOBANK_TOKEN", "")
base_url = env.get("PUBLIC_BASE_URL", "").rstrip("/")
webhook_secret = env.get("WEBHOOK_SHARED_SECRET", "")
if not token:
    raise SystemExit("MONOBANK_TOKEN is not configured")
if not base_url or not webhook_secret:
    raise SystemExit("PUBLIC_BASE_URL or WEBHOOK_SHARED_SECRET is not configured")

webhook_url = f"{base_url}/webhooks/monobank/{urllib.parse.quote(webhook_secret, safe='')}"
request = urllib.request.Request(
    "https://api.monobank.ua/personal/webhook",
    data=json.dumps({"webHookUrl": webhook_url}).encode(),
    headers={
        "Content-Type": "application/json",
        "User-Agent": "LeGrin-Finance-Pipeline/2.0",
        "X-Token": token,
    },
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read(1000).decode(errors="replace")
        print(f"monobank_webhook_registration=ok status={response.status} response={body}")
except urllib.error.HTTPError as error:
    body = error.read(1000).decode(errors="replace")
    raise SystemExit(f"Monobank returned HTTP {error.code}: {body}") from error

