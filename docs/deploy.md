# Deploying Pip

This takes about 30–45 minutes the first time. You need:

- An AWS account you can deploy to (admin or PowerUser access)
- On your computer: [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Node.js 22, and this repo cloned

Commands below assume a terminal in the repo folder and an AWS CLI profile named `omag`. Use whatever profile you already have.

## 1. Turn on the model in Bedrock

Pip uses **OpenAI GPT-5.6 Terra** through Amazon Bedrock, so you don't need an OpenAI account or key, and usage bills through AWS.

1. In the AWS console, switch to **US East (N. Virginia)**, **US East (Ohio)** or **US West (Oregon)**, then open **Amazon Bedrock**.
2. Open **Playground**, choose **Select model**, pick **US OpenAI GPT-5.6 Terra**, and send a test message. If the console asks you to enable access or accept OpenAI's terms, do that.
3. The model ID to use below is `us.openai.gpt-5.6-terra`. That's the template's default. The `us.` prefix keeps requests inside US regions.

Other options:
- `us.openai.gpt-5.6-sol` is the strongest model, but costs more and is only in N. Virginia and Ohio.
- `us.openai.gpt-5.6-luna` is the cheapest and fastest.
- A Claude profile ID also works, with no code change.

## 2. Try it locally against the real model (optional, recommended)

```bash
cd backend
npm install
AWS_PROFILE=omag AWS_REGION=us-east-1 MODEL_ID=us.openai.gpt-5.6-terra npm run dev
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
| Parameter ModelId | press Enter for `us.openai.gpt-5.6-terra` |
| Parameter AllowedOrigins | `https://omag-web.github.io,http://localhost:8787` (add `https://ask.omag.org` later) |
| Parameter ContactEmail | who should get "Talk to OMAG" messages and error alerts |
| DailyLimitPerIp / DailyLimitGlobal / RetentionDays | press Enter for the defaults (60 / 600 / 730). After the first deploy, change limits in the admin panel instead. |
| Parameter AdminEmail | your OMAG email. You'll get an invite to the admin panel. |
| Parameter LibraryUrl | press Enter for the default (the library published on GitHub Pages) |
| Allow SAM CLI IAM role creation | `y` |
| PipFunction Function Url has no authentication. Is this okay? | `y` (the app is public on purpose; the rate limits protect it) |
| Save arguments to configuration file | `y` |

When it finishes, copy the **ApiUrl** and **AdminUrl** outputs. AWS also emails ContactEmail a subscription confirmation; click the link in it.

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

**Billing → Budgets → Create budget → Cost budget**: monthly, $50, filtered to **Service = Amazon Bedrock** (and any OpenAI line items if they show separately). Alert at 80%.

## 6. Sign in to the admin panel

1. Check the AdminEmail inbox for **"You've been invited to Pip admin"**. It has a temporary password.
2. Open the **AdminUrl** (`https://omag-web.github.io/omag-hr/web/admin/`), sign in with your email and the temporary password, and choose your own password (12+ characters, upper- and lowercase letters and a number).
3. The temporary password expires after 7 days. If it does, ask another admin to resend it (below), or redeploy with a different AdminEmail.

**Adding another admin.** AWS console → **Cognito** → User pools → `pip-hr-admins` → **Users → Create user**: choose *Send an email invitation*, enter their email as both the username and the email, tick *Mark email address as verified*, and choose *Generate a password*. To remove someone, select them and **Delete user** (or **Disable**). To resend an invite, open the user → **Actions → Reset password**.

## Day-to-day

Most changes are made in the admin panel and take effect within a minute, with no redeploy:

| To… | Go to |
|---|---|
| Change how Pip answers (tone, standing rules, when to send members to OMAG) | **Instructions**: edit the draft, try it in the preview, then **Publish**. Every published version is kept; **Version history → Load into draft** rolls back. |
| Give Pip OMAG guidance to cite (memos, FAQs, sample policies) | **OMAG documents**: upload a PDF, Word (.docx) or text file. Switch a document off to stop Pip using it without deleting it. Scanned PDFs need OCR first. |
| See usage: questions over time, topics, most-cited laws, busy hours, municipalities, helpful rate, response time, cost; download everything as CSV | **Analytics** (set the Bedrock token prices under **Settings** to see a cost estimate) |
| Read what members asked, and see 👎 answers | **Conversations** |
| Read "Talk to OMAG" messages | **Talk to OMAG** (also emailed to ContactEmail) |
| Change the welcome text, starter questions, disclaimer, phone, model or daily limits | **Settings** |
| See or search the statute library | **Statute library** |

Some things are built into the code and can't be changed in the panel: Pip identifies itself as an AI assistant, reads the actual sections before citing them, drops citations it didn't read, and never presents itself as legal counsel.

**Updating the statute library.** The *Refresh statute library* workflow runs monthly and whenever `knowledge/sources.json` changes. You can also run it from the repo's **Actions** tab. It commits a new `backend/data/library.json`, and GitHub Pages publishes it. The backend checks for a newer library once a day and switches to it automatically (or click **Check for updates now** under **Statute library** in the admin panel). A download that looks incomplete is ignored, and Pip keeps using the library it has.

To add a title, section range or CFR part, edit `knowledge/sources.json`. The `_why` notes explain each entry.

**Changing the built-in rules.** The locked part of Pip's instructions is in `backend/src/prompt.mjs`. Edit it, run `npm test` and `npm run eval`, then redeploy. The default text of the editable part (`DEFAULT_GUIDANCE`) is in the same file; it's only used until someone publishes from the admin panel.

**Switching models.** Pick one under **Settings → AI model**, then ask a few questions in the Instructions preview. To try a model locally first: `MODEL_ID=<new id> npm run dev` and `npm run eval`.

**Raw data.** Conversations are in DynamoDB (`pip-hr-PipTable-…`) and delete themselves after `RetentionDays`. Uploaded OMAG documents and the refreshed library are in the S3 bucket `pip-hr-databucket-…`.

**403 Forbidden from the API URL.** The function's resource policy needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; the template adds both. In the Lambda console → the function → **Configuration → Permissions → Resource-based policy statements**, you should see two statements allowing `*`. Also check that the page's origin is listed in `AllowedOrigins` (a CORS error shows in the browser console, not as a 403).

**Errors.** CloudWatch → Log groups → `/aws/lambda/pip-hr-PipFunction-…`. ContactEmail gets an alarm if the function errors 5+ times in an hour.

**Taking it offline.** In the admin panel, set **Settings → Questions per day, everyone** to 0 (members see a "daily limit" message), or delete the stack with `sam delete`.
