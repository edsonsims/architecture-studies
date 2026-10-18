# Working in this repository

- Prefer TypeScript/Node.js for architecture studies and Python for later AI/evaluation work. Do not expand the C# material unless the owner explicitly requests it.
- Preserve the existing Git history and original files under `DesignPatternStudy/`. They are a historical archive, outside the new build and test scope.
- Architecture variants must run the same practical workflow through genuinely different boundaries and use-case paths. Keep a common observable contract and meaningful failure/transition tests; avoid empty scaffolds and renamed copies of one implementation.
- Keep demos local and deterministic apart from generated IDs. Use synthetic supplied text and no network services, credentials, real OCR claims, or fabricated outcomes.
- Preserve domain/application import directions. Keep the dependency test and TypeScript project references aligned with actual imports.
- For code changes, run `npm ci`, `npm test`, and `npm run demo` on a supported Node release. State the runtime/platform tested and distinguish local checks from remote CI results.
- Disclose AI assistance accurately. Automated review is not owner review. Do not mark exercises, research, integrations, deployment, or production use as completed without evidence.
