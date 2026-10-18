# AI assistance

The TypeScript and Python services, tests, build configuration, client and documentation were drafted with OpenAI Codex assistance. A separate agent reviewed the implementation and exercised adversarial cases; this was an automated review, not a human review by the owner.

Local verification uses Node.js 24.19.0, TypeScript 7.0.2 and Python 3.12.14 on macOS arm64. The Node suite includes shared contracts, real HTTP/SQLite integration and fast-check state/restart sequences. The Python suite starts real Uvicorn processes against temporary SQLite files. The cross-service suite exercises both APIs and process restart; separate client boundary tests use real HTTP and the command-line client. Check the latest GitHub Actions result for the committed revision; a workflow file alone is not evidence of a successful remote run.

Original tracked C# sources were preserved without changes. They were not rebuilt, migrated, or counted as newly tested work.

The owner has not yet recorded a walkthrough or completed the exercises. The services inspect supplied text and demonstrate local persistence. There is no OCR or model inference in this repository. Restart and concurrency checks have the specific scope described in README and the comparison guide; they are not production, power-loss or distributed-delivery validation.
