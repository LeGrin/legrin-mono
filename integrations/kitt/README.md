# KITT installation

1. Copy `finance-tracker/` into `kingdom_v2/instances/kitt/skills/kitt/finance-tracker/`.
2. Add to the KITT container environment:

```yaml
FINANCE_API_URL: http://legrin-finance-pipeline:8088
FINANCE_API_TOKEN: ${FINANCE_INTERNAL_API_TOKEN}
```

3. Ensure both containers use the external `legrin_default` network.
4. Restart KITT and verify the skill is discovered.

Do not commit `FINANCE_INTERNAL_API_TOKEN`. It must equal the pipeline `INTERNAL_API_TOKEN` through the VPS secret store or `.env`.
