# Deploying Pip

This takes about 30–45 minutes the first time. You need:

- An AWS account you can deploy to (admin or PowerUser access)
- On your computer: [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Node.js 22, and this repo cloned

Commands below assume a terminal in the repo folder and an AWS CLI profile named `omag`. Use whatever profile you already have.

## 1. Turn on the model in Bedrock

1. In the AWS console, switch to the region you'll deploy in (us-east-1 or us-east-2 both work), then open **Amazon Bedrock**.
2. Go to **Model catalog** → **Claude Sonnet 5.5** (Anthropic). If it asks, submit Anthropic's one-time use-case form. Approval is usually immediate.
3. Go to **Cross-region inference** (or **Inference profiles**) and copy the **US** profile ID for Claude Sonnet 5.5. It looks like `us.anthropic.claude-sonnet-5-5…`. Use this exact ID below; the template's default is a placeholder.

To use an OpenAI model on Bedrock instead (e.g. GPT-5.6 Terra), copy its model ID instead. Nothing else changes.

## 2. Try it locally against the real model (optional, recommended)

```bash
cd backend
npm install
AWS_PROFILE=omag AWS_REGION=us-east-1 MODEL_ID=<profile id from step 1> npm run dev
```

Open http://localhost:8787 and ask a few questions. In a second terminal, run the evaluation questions:

```bash
cd backend
PIP_API=http://localhost:8787 npm run eval
```

Each line shows whether Pip cited the sections we expect (✓/✗) and what it actually cited. Set `VERBOSE=1` to see full answers. Locally, nothing is logged and there are no rate limits.

## 3. Deploy the backend

```bash
cd backend
sam build
sam deploy --guided --profile omag
```

Answer the prompts:

| Prompt | Answer |
|---|---|
| Stack Name | `pip-hr` |
| AWS Region | the region from step 1 |
| Parameter ModelId | the profile ID from step 1 |
| Parameter AllowedOrigins | `https://omag-web.github.io,http://localhost:8787` (add `https://ask.omag.org` later) |
| Parameter ContactEmail | who should get "Talk to OMAG" messages and error alerts |
| DailyLimitPerIp / DailyLimitGlobal / RetentionDays | press Enter for the defaults (60 / 600 / 730) |
| Allow SAM CLI IAM role creation | `y` |
| PipFunction Function Url has no authentication. Is this okay? | `y` (the app is public on purpose; the rate limits protect it) |
| Save arguments to configuration file | `y` |

When it finishes, copy the **ApiUrl** output. AWS also emails ContactEmail a subscription confirmation; click the link in it.

Check the deploy:

```bash
curl https://<ApiUrl>/health
```

It should return `"ok": true` and about 1,500 library sections.

## 4. Connect the web page

1. Edit `web/config.js` and set `apiUrl` to the ApiUrl, with no trailing slash.
2. Commit and push. GitHub Pages serves the live app at `https://omag-web.github.io/omag-hr/web/`.

To put it on an OMAG domain later (e.g. `ask.omag.org`), point the domain at GitHub Pages or CloudFront, add that origin to `AllowedOrigins`, and redeploy with `sam deploy`.

## 5. Set a spending alert

The global daily limit already caps spend at a few dollars a day. For a second safeguard:

**Billing → Budgets → Create budget → Cost budget**: monthly, $50, filtered to **Service = Amazon Bedrock** (and the Claude/OpenAI Marketplace line items if they show separately). Alert at 80%.

## Day-to-day

**Updating the statute library.** The *Refresh statute library* workflow runs monthly and whenever `knowledge/sources.json` changes. You can also run it from the repo's **Actions** tab. It commits a new `backend/data/library.json`, and **Pip only picks that up when you redeploy**:

```bash
cd backend && sam build && sam deploy --profile omag
```

To add a title, section range or CFR part, edit `knowledge/sources.json`. The `_why` notes explain each entry.

**Changing what Pip says or how it behaves.** Edit `backend/src/prompt.mjs`, run `npm test` and `npm run eval`, then redeploy.

**Switching models.** Run `sam deploy --parameter-overrides ModelId=<new id>`. Run the eval first, locally with `MODEL_ID=<new id> npm run dev`.

**Reading conversations.** DynamoDB → Tables → `pip-hr-PipTable-…` → Explore items. Each answered question is one item: `pk` = `CONV#<conversation>`, with question, answer, citations, rating, tokens and form of government. "Talk to OMAG" messages are under `pk` = `CONTACT#<date>`. Items delete themselves after `RetentionDays`.

**Errors.** CloudWatch → Log groups → `/aws/lambda/pip-hr-PipFunction-…`. ContactEmail gets an alarm if the function errors 5+ times in an hour.

**Taking it offline.** Set `DailyLimitGlobal` to 0 and redeploy (members see a "daily limit" message), or delete the stack with `sam delete`.
