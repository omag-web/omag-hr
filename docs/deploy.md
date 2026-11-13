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

Once Pip has its own address on OMAG's domain (next section), the pages are served from AWS instead and GitHub Pages isn't needed.

### Pip's own web address (e.g. pip.omag.org)

Pip's pages can be served from AWS at an address on OMAG's domain. AWS stores the pages in a private S3 bucket and serves them over HTTPS through CloudFront. The deploy sets up the certificate and DNS records itself. This also lets the GitHub repo be private.

1. **Find the hosted zone ID.** In the AWS console, open **Route 53 → Hosted zones** and click `omag.org`. Copy the **Hosted zone ID** (it starts with `Z`). If `omag.org` isn't listed, the domain is in a different AWS account; leave the ID blank and see the note below.
2. **Run the deploy with the address.** On GitHub, go to **Actions → Deploy backend → Run workflow**. Enter the address (for example `pip.omag.org`) and the hosted zone ID, then click **Run workflow**. The first run takes 10–25 minutes, while AWS issues the certificate and sets up CloudFront.
3. **Check it.** Open `https://pip.omag.org/` and `https://pip.omag.org/admin/`. Sign in and ask Pip a question.
4. **Update links.** Change any links on omag.org, in emails or in Squarespace from `omag-web.github.io/omag-hr/web/` to the new address. New admin invitation emails use the new address automatically.

From then on, every change to `web/` publishes itself (the *Publish web pages* workflow). The API stays at its Lambda address; the new site is allowed to call it automatically.

**If the domain is in a different AWS account:** leave the hosted zone ID blank. While the deploy runs, open **Certificate Manager** (in us-east-1) in *this* account, click the certificate for your address, and copy the CNAME name and value under **Domains**. Have whoever manages the domain add that CNAME record. The deploy waits for it. When the deploy finishes, add a CNAME from your address to the **SiteDnsTarget** value (in CloudFormation → `pip-hr` → Outputs).

### Making the GitHub repo private

Do this only after the new address works (above).

1. **Publish the law library to AWS once.** Go to **Actions → Refresh statute library → Run workflow**. The log should end with "Published to s3://…". After that, the admin panel's **Check for updates now** under **Statute library** should say "Already up to date".
2. **Make it private.** On GitHub, go to **Settings → General → Danger Zone → Change repository visibility → Make private**.
3. **Turn off GitHub Pages.** Under **Settings → Pages**, unpublish the site if it's still listed. On GitHub's free plan, private repos can't use Pages anyway.

Nothing else changes: the deploy role trusts the repo by its ID, not its visibility. Private repos get 2,000 free GitHub Actions minutes a month, and Pip uses about 150 (the weekly answer check is most of it).

## 5. Set a spending alert

The global daily limit already caps spend at a few dollars a day. For a second safeguard:

**Billing → Budgets → Create budget → Cost budget**: monthly, $50, filtered to **Service = Amazon Bedrock** (and any OpenAI line items if they show separately). Alert at 80%.

## 6. Sign in to the admin panel

1. Check the AdminEmail inbox for **"You've been invited to Pip admin"**. It has a temporary password.
2. Open the **AdminUrl** (`https://omag-web.github.io/omag-hr/web/admin/`), sign in with your email and the temporary password, and choose your own password (12+ characters, upper- and lowercase letters and a number).
3. The temporary password expires after 7 days. If it does, ask another admin to resend it (below), or redeploy with a different AdminEmail.

**Adding another admin.** In the admin panel, open **Admins**, enter their email and click **Send invite**. The same page resends invites, emails a password-reset code, turns someone's access off (they're signed out within a minute) or removes them. You can't turn off or remove yourself, so there's always at least one admin. Changes are also possible in the AWS console (**Cognito** → User pools → `pip-hr-admins` → Users) if the panel is ever unavailable.

**Two-step sign-in (recommended for every admin).** Admins can read every member conversation, so a password alone shouldn't be enough. In the admin panel, open **Admins → Your sign-in → Set up two-step sign-in**, scan the code with an authenticator app (Microsoft Authenticator, Google Authenticator or Authy), and enter the 6-digit code. From then on you enter a code from the app after your password. The **Two-step** column shows who has it on. If someone loses their phone, another admin clicks **Reset two-step** next to their name, after confirming it's really them. Once every admin has it on, it can be made required: in `backend/template.yaml` change `MfaConfiguration: OPTIONAL` to `ON` (new admins are then asked to set it up at first sign-in).

## 7. Automatic deploys from GitHub (recommended)

After this one-time setup, merging a pull request that changes `backend/` deploys Pip automatically. GitHub runs the tests first and deploys only if they pass. You don't run `sam deploy` from your PC any more, so the office firewall doesn't matter.

1. **Check whether AWS already trusts GitHub** (some accounts have this from other projects):
   ```
   aws iam list-open-id-connect-providers --profile omag
   ```
   If the output mentions `token.actions.githubusercontent.com`, use the second command in step 2; otherwise use the first.
2. **Create the deploy role.** From the `omag-hr` folder:
   ```
   aws cloudformation deploy --template-file deploy/github-deploy-role.yaml --stack-name pip-hr-github-deploy --capabilities CAPABILITY_NAMED_IAM --profile omag --region us-east-1
   ```
   or, if the provider already exists:
   ```
   aws cloudformation deploy --template-file deploy/github-deploy-role.yaml --stack-name pip-hr-github-deploy --capabilities CAPABILITY_NAMED_IAM --parameter-overrides CreateGitHubOidcProvider=false --profile omag --region us-east-1
   ```
   This creates a role that only the `main` branch of `omag-web/omag-hr` can use. No AWS keys are stored in GitHub.
3. **Run the first deploy.** On GitHub: **Actions** → **Deploy backend** → **Run workflow** → **Run workflow**. A green check (about 5 minutes) means Pip is deployed. A red ✗: click it, then click the step with the ✗ to see why.

From then on it runs by itself after every merge that touches `backend/`. It keeps the settings you chose with `sam deploy --guided` (it reads them from the stack), so it never resets emails or limits. To change one of those settings later, run `sam deploy --guided` from your PC as before, on the hotspot if needed. The automatic deploy keeps whatever you set.

## 8. Load OMAG's document templates (one time)

Members build OMAG's personnel policy, FMLA policy and acknowledgment receipt from OMAG's real Word files. The prepared files come as one template pack, `omag-templates.zip`. It's kept out of this public repository because it's OMAG's documents.

1. Admin panel → **Document templates** → **Import a template pack** → choose `omag-templates.zip`.
2. Open each template, read the questions and notes, and click **Test with sample answers** to download a test copy.
3. Templates import switched on. To hold one back until it's reviewed, untick **Members can use it**.

When OMAG revises a template, either edit the Word file (keep the `{{fields}}`) and click **Replace** next to that form of government, or rebuild the whole pack from OMAG's original files:

```
python3 knowledge/scripts/prepare-omag-templates.py <folder with OMAG's .docx files> omag-templates.zip
```

The script removes OMAG's instructions page, turns every blank into a field, moves the `[NOTE]`s into the notes, and stops with an error if a blank it expects has moved. Convert the FMLA `.doc` to `.docx` first (open it in Word → Save As → Word Document).

Use **Download all (backup)** before big changes. It downloads every template, with its files and questions, as a pack you can import again.

## Day-to-day

Most changes are made in the admin panel and take effect within a minute, with no redeploy:

| To… | Go to |
|---|---|
| Change how Pip answers (tone, standing rules, when to send members to OMAG) | **Instructions**: edit the draft, try it in the preview, then **Publish**. Every published version is kept; **Version history → Load into draft** rolls back. |
| Give Pip OMAG guidance to cite (memos, FAQs, sample policies, web pages) | **OMAG documents**: upload a PDF, Word (.docx) or text file, or add a web page by its address. Pip re-reads web pages daily and keeps the last good copy if a site is down. Switch an item off to stop Pip using it without deleting it. Scanned PDFs need OCR first; pages that only show their content with JavaScript can't be read (save them as PDF instead). |
| See usage: questions over time, topics, most-cited laws, busy hours, municipalities, helpful rate, response time, cost; download everything as CSV | **Analytics** (set the Bedrock token prices under **Settings** to see a cost estimate) |
| Read what members asked, and see 👎 answers | **Conversations** |
| Read "Talk to OMAG" messages | **Talk to OMAG** (also emailed to ContactEmail) |
| Change the welcome text, starter questions, disclaimer, phone, privacy notice, model, backup model or daily limits | **Settings** |
| Add, remove or re-invite admins | **Admins** |
| Add or update a document members can build (personnel policy, FMLA policy…) | **Document templates**: upload a Word file with `{{fields}}`, write the questions, test it, switch it on. The page explains the field syntax. |
| See or search the statute library, check that its source addresses still work, or change them | **Statute library**: **Check links**, then **Edit sources on GitHub** (steps are on the page) |

Some things are built into the code and can't be changed in the panel: Pip identifies itself as an AI assistant, reads the actual sections before citing them, drops citations it didn't read, and never presents itself as legal counsel.

**Privacy.** The AI runs inside OMAG's AWS account through Amazon Bedrock. Members' questions aren't sent to OpenAI or used to train models. Pip itself saves conversations (for **RetentionDays**, default 2 years) so admins can review them, so it also guards against personal details:
- The member page warns before sending a message that looks like it contains a Social Security, card, bank account or driver's license number, a birth date, an email address or a phone number, and offers to remove them.
- The server removes ID numbers, account numbers and birth dates again before anything reaches the AI or the logs. This also covers "Talk to OMAG" messages.
- Pip never repeats personal details back and refers to people by role.
- Names and medical details can't be detected reliably by pattern, so the page asks members to leave them out.
- The **Privacy** link under the message box opens a plain-language notice: what's kept, how it's used, how long, and a button to clear conversations saved in that browser. Edit it under **Settings → Privacy notice**, where `{retention}` and `{phone}` fill in automatically. Have OMAG Legal review it.

To keep conversations for less time, rerun `sam deploy --guided` and lower **RetentionDays**.

**Updating the statute library.** The *Refresh statute library* workflow runs monthly and whenever `knowledge/sources.json` changes. You can also run it from the repo's **Actions** tab. It commits a new `backend/data/library.json` and uploads it to Pip's data bucket in AWS. The backend checks for a newer library once a day and switches to it automatically (or click **Check for updates now** under **Statute library** in the admin panel). A download that looks incomplete is ignored, and Pip keeps using the library it has.

To add a title, section range or CFR part, edit `knowledge/sources.json`. The `_why` notes explain each entry.

**Changing the built-in rules.** The locked part of Pip's instructions is in `backend/src/prompt.mjs`. Edit it, run `npm test` and `npm run eval`, then redeploy. The default text of the editable part (`DEFAULT_GUIDANCE`) is in the same file; it's only used until someone publishes from the admin panel.

**Switching models.** Pick one under **Settings → AI model**, then ask a few questions in the Instructions preview. To try a model locally first: `MODEL_ID=<new id> npm run dev` and `npm run eval`.

**Raw data.** Conversations are in DynamoDB (`pip-hr-PipTable-…`) and delete themselves after `RetentionDays`. Uploaded OMAG documents and the refreshed library are in the S3 bucket `pip-hr-databucket-…`.

**403 Forbidden from the API URL.** The function's resource policy needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; the template adds both. In the Lambda console → the function → **Configuration → Permissions → Resource-based policy statements**, you should see two statements allowing `*`. Also check that the page's origin is listed in `AllowedOrigins` (a CORS error shows in the browser console, not as a 403).

**Errors.** CloudWatch → Log groups → `/aws/lambda/pip-hr-PipFunction-…`.

## Keeping Pip healthy

**Alarm emails** go to ContactEmail. (The first time, AWS sends a "Subscription Confirmation" email. Click its link, or no alarms arrive.) Each alarm and what to do:

| Alarm | What it means | What to do |
|---|---|---|
| **Pip is down** | The /health check failed from several places for 1.5 minutes | Check the Lambda log for errors. If the last deploy caused it, revert that PR on GitHub (it redeploys) |
| **Errors** | 5+ failed requests in an hour | Read the Lambda log |
| **Throttled** | AWS refused to run Pip because too many requests were running at once | Usually a burst; if it repeats, ask AWS for a higher Lambda concurrency limit |
| **Slow answers** | An answer took over 4 minutes | Pip stops researching at about 3 minutes and answers with what it has. If this repeats, the model is slow that day |
| **Daily limit reached** | The everyone-per-day limit was hit and members were turned away | Raise it under **Settings** if the use is real |
| **Backup model in use** | The main model failed 3+ times in an hour and Pip switched to the backup | Check the AWS Health dashboard for Bedrock. If the main model was retired, pick a new one under **Settings → AI model** |

**Backup model.** If the main AI model is busy, down or retired, Pip retries that answer with the backup model (**Settings → Backup model**, default GPT-5.6 Luna) instead of showing members an error. Choose "None" to turn this off.

**Weekly answer check.** Every Monday the *Check Pip's answers* workflow asks the 40 questions in `backend/eval/questions.json` using a private copy of Pip. It checks that each answer cites the right laws, never repeats a Social Security number, says it's an AI when asked, and stays on HR. It fails if fewer than 80% pass, and GitHub emails repo watchers. Open the run to see a table of which questions went wrong. Run it by hand from **Actions** after changing the instructions or model. Each run costs about $1–2. To add a question, copy an entry in the file; the ids are the ones shown in Pip's citations (for example `11-12-106` or `29-CFR-825.110`).

**Library safety checks.** If any law listed under `required` in `knowledge/sources.json` goes missing, the library rebuild fails and Pip keeps the current library. That can happen, for example, if the Legislature changes its PDF layout. If the *Refresh statute library* run fails, open it: the log names the missing sections. Oklahoma laws usually take effect July 1 and November 1, and the monthly rebuild picks them up.

**Package updates.** On Mondays, Dependabot opens pull requests when Pip's packages or GitHub Actions have updates; security fixes arrive sooner. Each PR runs the tests. Merge it if they pass, and it deploys automatically.

**Deleted or overwritten files.** The S3 bucket keeps old versions of uploaded OMAG documents and templates for 90 days. DynamoDB has point-in-time recovery for 35 days. Ask whoever manages AWS to restore either if needed.

**Taking it offline.** In the admin panel, set **Settings → Questions per day, everyone** to 0 (members see a "daily limit" message), or delete the stack with `sam delete`.
