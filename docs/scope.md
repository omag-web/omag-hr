# Scope and plan

Assistant name: **Pip** (working name), shown as "Pip · OMAG's HR assistant" with an AI label on every answer.

Working notes for replacing the "Oklahoma Municipal HR Assistant" CustomGPT with a custom-built, member-facing tool. Figures and model details are as of November 2026.

## Goals

1. Answer Oklahoma municipal HR and employment-law questions from **cited** sources (Title 11 and other Oklahoma statutes, federal regulations, OMAG guidance), tailored to the member's **form of government**.
2. Generate documents from OMAG's templates, filled in with the member's details, as `.docx` and PDF.
3. Run as a full-page chat on an OMAG domain, not a corner widget and not inside ChatGPT, so members don't need a ChatGPT account.
4. Give OMAG usage and quality analytics.

## What the CustomGPT contains

About 150,000 words (~200K tokens) of knowledge plus a one-page system prompt ([`system-prompt.md`](system-prompt.md)).

| File | Size | Role in the new build |
|---|---|---|
| OML *Handbook for City and Town Officials* 2025 (PDF) | 313 pp, ~114K words | Retrieved per question. Only the governance and personnel chapters matter. **© Oklahoma Municipal League. Get OML's permission before using it in a member-facing tool.** |
| OMAG personnel policy templates: Statutory Town, Aldermanic, Strong Mayor, Council-Manager (.docx) | ~7K words each | **Document generation.** Fill-in-the-blank templates keyed to each form's Title 11 authority sections. |
| OMAG sample FMLA employee & family member policy (.doc) | ~5K words | Document generation. Convert to .docx. |
| OML conference deck, "Small Town HR" (.pptx) | ~4.6K words | Background only. The prompt says not to cite training materials. |

These source files aren't committed here. They contain copyrighted material and staff contact details. Keep them in a private S3 bucket.

### Gap: no statute text

The GPT has no statute text, so it cites Title 11, Title 40, etc. from model memory. The new build needs a curated library, and this is the biggest content task:

- **Title 11:** form-of-government articles (9, 10, 11, 12, 13) plus personnel-related sections
- **Title 40** (labor), **Title 51** (Governmental Tort Claims Act), **Title 85A** (workers' comp), **Title 63** (medical marijuana employment provisions)
- **29 C.F.R. Part 825** (FMLA), **Part 553** (FLSA for public agencies), **Part 1630** (ADA), **49 C.F.R. Parts 40 / 382** (DOT drug & alcohol testing)
- Refresh after each legislative session

## Architecture

```
Browser (full-page chat, static site on S3/CloudFront or Vercel)
   │  POST /chat (streaming)
   ▼
API Gateway + Lambda ── Bedrock Converse API ── Claude Sonnet (model ID in config)
   │                      │
   │                      └─ always loaded (prompt-cached): system prompt,
   │                         member's form-of-government template, FMLA policy
   ├─ retrieval: statute library + OML handbook chunks (S3 Vectors)
   ├─ document generation: docx templates → .docx / PDF (docx-templater)
   └─ DynamoDB: conversations, events, topic tags, daily rollups
```

Decisions:

- **Model:** Claude Sonnet via Amazon Bedrock, so data stays in OMAG's AWS account and bills through AWS. OpenAI GPT models are also on Bedrock. Keep the model ID in an environment variable and use the Converse API so switching is a config change. Test answers against both before launch.
- **Retrieval:** use **S3 Vectors** or keep the corpus small enough to load with caching. **Avoid Bedrock Knowledge Bases on OpenSearch Serverless**: its idle minimum costs more than the model at this volume.
- **Model lifecycle:** check the chosen model's Bedrock model card for its end-of-life floor and notice period. Subscribe to AWS Health / EventBridge deprecation notices.
- **Evaluation:** keep 30–50 real member questions with known-good answers as a script. Rerun it whenever the prompt, sources or model change.

## Accounts and identity: none

No user accounts, so there's nothing to maintain.

- **Conversation history:** keyed to a random **browser ID** stored in the browser, not to IP address. A city hall shares one IP, so IP-keyed history would expose one employee's conversations to another.
- **City and form of government:** a "Your city" picker on first visit, filled from OMAG's member roster and remembered by the browser. It drives form-specific answers and city-level analytics. City is self-reported, so treat it as directional.
- **IP:** truncated or hashed, used only for rate limiting.
- **Open access tradeoff:** anyone with the link can use it. Mitigate with AWS WAF rate limits, a bot check (WAF CAPTCHA or Turnstile), a daily spend cap and an AWS Budgets alert. If abuse appears, add a shared **member access code** that rotates yearly.

> The prototype has a "Form of government" dropdown in the header and no profile. In the live build, the city picker fills it in from the member roster, and members can still change it.

## Analytics

Log from day one; build the dashboard in ~1–2 weeks after the core.

- **Per conversation:** browser ID, selected city, form of government, timestamps, message count, latency, model, tokens, cost
- **Per answer:** citations given and clicked, thumbs up/down, answered vs. couldn't answer
- **Events:** documents generated (by template), downloads, uploads, "Talk to OMAG" escalations
- **Topic tag:** a cheap model call after each conversation (FMLA, FLSA, discipline, hiring, ADA, drug testing, governance authority, other)

The dashboard is an admin-only page with charts from a nightly DynamoDB rollup. It covers usage, cities, topics over time, quality (thumbs-down by topic, unanswered questions, escalations, review queue), documents generated and cost. CloudWatch handles errors and latency.

## Cost estimate

Volume: ~1,300 conversations over 2 years (~54/month). Assumes ~6 exchanges per conversation, ~90K input and ~5K output tokens.

| Model (Bedrock, US) | Per conversation | Per month | 2 years |
|---|---|---|---|
| Claude Sonnet 5.5 ($2.20 / $11 per M tokens) | ~$0.25 | ~$14 | ~$330 |
| GPT-5.6 Terra ($2.20 / $13.20) | ~$0.26 | ~$14 | ~$345 |
| Claude Opus 5.5 ($4 / $20) | ~$0.46 | ~$25 | ~$600 |

Lambda, API Gateway, S3, CloudFront and DynamoDB add a few dollars a month at most. Prompt caching lowers input cost further. Set a ~$50/month budget alert.

Rejected alternatives: **Glean** (internal-employee search, ~100-seat minimum around $60K/yr) and **ScoutOS** (fine for prototyping, but no native document generation and opaque pricing above the starter tier).

## Phases

1. **Statute Q&A with citations:** system prompt, statute library, retrieval, streaming chat UI, city picker, logging.
2. **Document generation:** the four personnel templates + FMLA policy + acknowledgment receipt as fillable .docx.
3. **Analytics dashboard and hardening:** WAF, budget alerts, evaluation script, review queue.

## Open decisions

- [ ] OML permission to use the 2025 Handbook in a public, member-facing tool
- [ ] Retention period for transcripts (e.g. 12–24 months, keep anonymized stats), and whether logs are subject to records-retention or open-records requirements; check with OMAG Legal
- [ ] Who at OMAG can read transcripts vs. only summary numbers
- [ ] Terms-of-use line telling users conversations are logged to improve the service
- [ ] Domain (e.g. `ask.omag.org`) and whether to also embed it full-height on omag.org
- [ ] Charter cities: no OMAG template; start from Council-Manager and flag sections to check against the charter?
