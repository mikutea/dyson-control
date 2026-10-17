# Dyson Control

Build a complete, usable server manager. Keep one clear implementation for each operation.

- Keep the server, UI and Windows game adapter on the contracts in `shared/contracts.ts`.
- Everyday actions should be direct. Confirm operations that interrupt players or replace data; make backups and job records automatically.
- Use one administrator, one durable job queue and one game-operation mutex. Do not add compatibility frameworks, feature-gate layers or generic policy engines.
- Keep credentials, real saves, player data and deployment configuration out of source control.
- Do not operate the running production game while developing. Verify locally with fixture directories; bundle production changes for one reviewed deployment.
- Treat `.dsv`, `.server` and an existing `.moddsv` as one save set. Preserve a restorable copy before replacing it.
- Preserve unrelated files. Run checks that exercise the actual changed behavior.
- GSM is not part of this project.
