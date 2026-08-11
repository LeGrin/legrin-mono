# Production CI/CD

`.github/workflows/deploy.yml` runs tests and a production Docker build on a GitHub-hosted runner. A successful manual run, or a push to `master`, deploys the exact tracked revision on the repository-scoped self-hosted runner labelled `legrin-main` and `legrin-mono`.

The runner has no finance secrets in GitHub. Runtime credentials remain in `/opt/legrin-finance-pipeline/shared/.env` on the VPS. Its only passwordless root capability is `/usr/local/sbin/deploy-legrin-finance`, installed from `deploy/deploy-on-vps.sh`.

The deploy wrapper:

1. accepts only a 40-character Git commit SHA and a tar archive on stdin;
2. rejects absolute and parent-traversal archive paths;
3. builds a revision-tagged image;
4. starts an isolated, read-only container on `legrin_default` and `legrin-network`;
5. binds the service to `127.0.0.1:18088` for host health checks;
6. checks the real `/health` endpoint for up to three minutes;
7. detects an exited replacement immediately and restores the previous container if startup or health fails;
8. keeps the five most recent source releases.

The production container is named `legrin-finance-pipeline`. KITT reaches it over `legrin_default`; Nginx Proxy Manager reaches it over `legrin-network`.

## Live production topology

- Public base URL: `https://kitt.legrin-tech.net/finance`
- Host-only health endpoint: `http://127.0.0.1:18088/health`
- Runtime env: `/opt/legrin-finance-pipeline/shared/.env`, mode `0600`
- Persistent SQLite: `/opt/legrin-finance-pipeline/shared/data/finance.db`
- KITT skill: `/opt/kingdom_v2/instances/kitt/skills/kitt/finance-tracker/`

The Nginx location disables access logging so the Monobank path secret is not written to proxy access logs. `/api/*` remains protected by the bearer token, and an unauthenticated production request was verified to return `401`.

## Enable Monobank when the token is available

1. Set `MONOBANK_TOKEN` in `/opt/legrin-finance-pipeline/shared/.env` without changing the other values.
2. Register the already-public callback without printing the token or webhook secret:

```bash
sudo python3 /opt/legrin-finance-pipeline/current/deploy/register-monobank.py
```

The incoming webhook service does not need the Monobank token after registration. Keep the token in the VPS env for safe re-registration after a domain or secret change.

## Remaining Calendar requirement

Production health currently reports `calendar: false`. A Google API key cannot write to a private Calendar. Enable Calendar only after providing a dedicated service-account JSON or OAuth grant with edit access to the selected calendar.

## Initial production evidence

- CI/CD runs `31481186113` and `31481559386` both passed verify and deploy jobs.
- A synthetic one-cent Monobank event entered through public HTTPS, completed live KITT analysis, and was delivered through Telegram.
- The synthetic row was then changed to `Transfers`, so it is excluded from expense summaries.
- A second deployment preserved the SQLite ledger and replaced the container with revision `66ebdb2b938f91c13ba2589036b5aa9fc48a4b10`.
