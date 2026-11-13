# Pip — OMAG's HR Assistant

**Pip** is a member-facing HR assistant for Oklahoma municipalities, replacing OMAG's "Oklahoma Municipal HR Assistant" CustomGPT. Members ask employment-law questions and get answers grounded in Oklahoma statutes (Title 11 and others) and federal regulations. Every legal point links to the actual section text. Pip also generates documents (personnel handbook, FMLA policy, acknowledgment receipt) from OMAG's templates.

**Status:** Live. Q&A with verified citations, plus an admin panel where OMAG staff edit Pip's instructions, upload OMAG guidance documents, read conversations and change settings without redeploying. See [`docs/deploy.md`](docs/deploy.md).

**Name:** "Pip" is a working name, set in one place in each front end (`const BOT = 'Pip'`). Its icon is a single gold dot (the "pip") in a chat bubble, in OMAG navy and gold. Always show the name with the descriptor "OMAG's HR assistant" and an **AI** label, so members don't mistake it for OMAG staff.

## What's in the repo

| Path | What it is |
|---|---|
| [`web/`](web/) | **The live app.** One page that streams answers from the backend. Set the API address in `web/config.js`. |
| [`web/admin/`](web/admin/) | **The admin panel** for OMAG staff (sign-in required): analytics, instructions, document templates, OMAG documents, conversations, "Talk to OMAG" messages, settings, statute library, admins. |
| [`backend/`](backend/) | **The API.** AWS Lambda + OpenAI GPT-5.6 on Amazon Bedrock + DynamoDB, deployed with AWS SAM (`template.yaml`). The model is one setting (`ModelId`); Claude works too. |
| [`backend/data/library.json`](backend/data/) | **The statute library** Pip searches: ~1,500 sections. Generated; don't edit by hand. |
| [`knowledge/`](knowledge/) | What goes in the library (`sources.json`) and the scripts that build it from the Oklahoma Legislature and eCFR. |
| [`prototype/`](prototype/index.html) | The original clickable prototype with scripted answers, kept as a demo. |
| [`docs/`](docs/) | [`deploy.md`](docs/deploy.md) (how to deploy and run it), [`scope.md`](docs/scope.md) (plan and decisions), [`system-prompt.md`](docs/system-prompt.md) (the CustomGPT's original instructions). |
| [`assets/`](assets/) | Pip's icon: `pip-icon.svg` (navy tile, for light backgrounds), `pip-mark-on-dark.svg` (no tile, for navy backgrounds), `pip-icon-512.png`. |

## How it works

1. A member asks a question in `web/`. The page sends the conversation and the selected form of government to `POST /chat`.
2. The Lambda gives OpenAI GPT-5.6 Terra (through Amazon Bedrock) Pip's system prompt (`backend/src/prompt.mjs`) and two tools: `search_law`, a keyword search over the library, and `get_sections`, which reads full text.
3. GPT researches, then writes an answer that cites sections as `[[11-12-106]]`. The answer streams back word by word.
4. The backend keeps only citations to sections GPT actually read. The page turns them into chips that open the section text (`GET /source`).
5. Members can build OMAG's documents (personnel policy, FMLA policy, acknowledgment receipt). They answer a few questions, the backend fills OMAG's real Word file with docxtemplater, and they download it. Pip offers the right document in chat when a member asks for one. Templates and their questions are managed in the admin panel.
6. OMAG documents uploaded in the admin panel, and web pages added there (re-read daily), are split into sections and searched alongside the statutes; Pip cites them as "OMAG". The editable part of Pip's instructions and the site settings live in DynamoDB.
7. Each answered question is logged to DynamoDB with its citations and token use. Thumbs up/down (`/feedback`) and "Talk to OMAG" (`/contact`, emailed via SNS) are stored with it.

No accounts: conversation history lives in the member's browser. IP addresses are hashed and used only for the daily limits.

## Run it locally

```bash
cd backend
npm install
npm test                 # 47 tests, no AWS needed
npm run dev:mock         # http://localhost:8787 with a scripted stand-in model
                         # admin panel at http://localhost:8787/admin/ (no sign-in locally)
```

To use the real model locally, see [`docs/deploy.md`](docs/deploy.md#2-try-it-locally-against-the-real-model-optional-recommended).

## The statute library

The **Refresh statute library** GitHub Action (`.github/workflows/library.yml`) runs monthly, whenever `knowledge/` changes, and on demand. It downloads the current Oklahoma titles and CFR parts, splits them into sections, and commits `backend/data/library.json`. The deployed backend picks up the new version from GitHub Pages within a day, no redeploy needed.

Current coverage: Title 11 (forms of government, officers, charter cities, general powers, liability, fire/police bargaining), the Open Meeting Act, Title 40 (labor), military leave, the Governmental Tort Claims Act and Open Records Act, medical marijuana employment provisions, Title 85A (workers' comp), and 29 C.F.R. Parts 825 (FMLA), 553 and 541 (FLSA), 785 (hours worked), 1630 (ADA), plus 49 C.F.R. Parts 382 and 40 (DOT testing).

## Prototype

Open `prototype/index.html` in a browser, or visit `/prototype/` on GitHub Pages. Its answers are scripted; it's kept for demos.
