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
7. restores the previous container automatically if startup or health fails;
8. keeps the five most recent source releases.

The production container is named `legrin-finance-pipeline`. KITT reaches it over `legrin_default`; Nginx Proxy Manager reaches it over `legrin-network`.
