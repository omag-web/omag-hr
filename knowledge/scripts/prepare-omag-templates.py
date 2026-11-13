#!/usr/bin/env python3
"""
Turns OMAG's sample documents into a Pip template pack (.zip) for the admin panel
(Document templates → Import a template pack).

  python3 knowledge/scripts/prepare-omag-templates.py <folder with OMAG's files> <output.zip>

Expected files in the folder (names as OMAG distributes them; .doc must be converted to .docx first,
e.g. `soffice --headless --convert-to docx file.doc`):
  Statutory+Town+OMAG+PERSONNEL+POLICIES*.docx
  Aldermanic*OMAG+PERSONNEL+POLICIES*.docx
  Statutory+Council+Manager+OMAG+PERSONNEL+POLICIES*.docx
  Strong+Mayor+OMAG+PERSONNEL+POLICIES*.docx
  *FMLA*.docx

What it does to each file:
  - removes OMAG's instructions page (it names staff and is written to the municipality, not employees)
  - turns every fill-in spot (___, [Name of Town], (insert pay period), Insert Date Here …) into a {{field}}
  - removes the [NOTE: …] paragraphs and puts them in the template's "before you adopt" notes instead
  - checks nothing fill-in-like is left behind, and fails loudly if a pattern no longer matches

The output files are OMAG's documents; keep them out of the public repository.
"""
import copy, glob, json, os, re, sys, zipfile
import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt

SRC, OUT = sys.argv[1], sys.argv[2]

# ---------------------------------------------------------------- helpers
def runs_replace(p, pattern, repl, flags=0):
    """Regex replace inside a paragraph, across runs, keeping the formatting of the run where each match starts."""
    runs = p.runs
    text = ''.join(r.text for r in runs)
    matches = list(re.finditer(pattern, text, flags))
    for m in reversed(matches):
        s, e = m.span()
        new = m.expand(repl)
        pos = 0
        spans = []
        for r in runs:
            spans.append((r, pos, pos + len(r.text)))
            pos += len(r.text)
        done = False
        for r, rs, re_ in spans:
            if not done and rs <= s < re_ or (not done and s == e == rs):
                r.text = r.text[:s - rs] + new + (r.text[e - rs:] if e <= re_ else '')
                done = True
                if e <= re_:
                    break
                continue
            if done and rs < e:
                r.text = r.text[e - rs:] if e < re_ else ''
                if e <= re_:
                    break
    return len(matches)

def body_paragraphs(d):
    return d.paragraphs

def remove(p):
    p._element.getparent().remove(p._element)

def remove_until(d, stop_regex):
    """Remove body elements from the top until the first paragraph matching stop_regex (kept)."""
    body = d.element.body
    for el in list(body):
        if el.tag.endswith('sectPr'):
            break
        txt = ''.join(t.text or '' for t in el.iter() if t.tag.endswith('}t'))
        if re.search(stop_regex, txt):
            return
        body.remove(el)
    raise SystemExit(f'Could not find {stop_regex!r}')

class Doc:
    def __init__(self, path, label):
        self.d = docx.Document(path)
        self.label = label
        self.notes = []
    def sub(self, pattern, repl, expect=1, flags=0, where=None):
        n = 0
        for p in self.d.paragraphs:
            if where and not re.search(where, p.text):
                continue
            n += runs_replace(p, pattern, repl, flags)
        if expect is not None and n != expect:
            raise SystemExit(f'{self.label}: expected {expect} match(es) for {pattern!r}, found {n}')
        return n
    def take_notes(self):
        for p in list(self.d.paragraphs):
            t = p.text.strip()
            if t.startswith('[NOTE'):
                self.notes.append(re.sub(r'^\[NOTE:\s*|\]$', '', t).strip())
                remove(p)
    def check_clean(self):
        left = []
        for p in self.d.paragraphs:
            t = p.text
            if re.fullmatch(r'\s*_{10,}\s*', t):          # horizontal separator lines are part of the design
                continue
            if re.search(r'_{2,}|\[Name of|\binsert\b|\(\s*_|\[i\.e\.|\(\?\)', t, re.I):
                if re.search(r'Print Employee Name|Employee Signature|^\s*_+\s*Date', t):
                    continue
                left.append(t[:120])
        if left:
            raise SystemExit(f'{self.label}: fill-in text left behind:\n  ' + '\n  '.join(left))
    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.d.save(path)

def find(pattern):
    hits = [f for f in glob.glob(os.path.join(SRC, '*.docx')) if re.search(pattern, os.path.basename(f), re.I)]
    if len(hits) != 1:
        raise SystemExit(f'Expected one file matching {pattern!r} in {SRC}, found {hits}')
    return hits[0]

# ---------------------------------------------------------------- personnel policy handbooks
HANDBOOKS = {
    'town': find(r'^Statutory\+Town'),
    'aldermanic': find(r'^Aldermanic'),
    'cm': find(r'Council\+Manager'),
    'strong': find(r'^Strong\+Mayor'),
}
build = os.path.join(os.path.dirname(OUT) or '.', 'pip-template-build')
handbook_notes = None
for variant, path in HANDBOOKS.items():
    doc = Doc(path, f'handbook/{variant}')
    remove_until(doc.d, r'Insert (Town|City) Logo')
    doc.sub(r'Insert (Town|City) Logo', '{{municipality_name}}')
    doc.sub(r'Approved by \(?(Town|City)\)? on', 'Approved by {{municipality_name}} on')
    # OMAG centered this line with spaces and tabs; a real name makes it wrap. Center it properly.
    for p in doc.d.paragraphs:
        if 'Approved by {{municipality_name}} on' in p.text:
            for r in p.runs:
                r.text = r.text.replace('\t', '').lstrip(' ') if r is p.runs[0] else r.text.replace('\t', '')
            p.text and runs_replace(p, r'^\s+', '')
            p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.left_indent = p.paragraph_format.first_line_indent = None
    doc.sub(r'Insert Date Here', '{{approval_date}}')
    doc.sub(r'\[Name of (Town|City)\]', '{{municipality_name}}')
    # Town: "approval of ____ [i.e. Town Clerk, …]". City versions hard-code "the City Manager", even the
    # Aldermanic and Strong-Mayor ones, which have no city manager; make it a question in all four.
    if variant == 'town':
        doc.sub(r'_{5,}\s*\[i\.e\.[^\]]*\]', 'the {{records_approver}}')
    else:
        doc.sub(r'approval of the City Manager', 'approval of the {{records_approver}}')
    doc.sub(r'\(Insert Name or Title Here\)', '{{harassment_report_to}}')
    if variant == 'aldermanic':
        # "Insert appeal procedure established by City ordinance or if no procedure has been established by
        # ordinance, then use:" + the 11 O.S. § 9-118 text → the member's ordinance text, or the statute text.
        ps = doc.d.paragraphs
        i = next(k for k, x in enumerate(ps) if x.text.startswith('Insert appeal procedure'))
        statute = next(x for x in ps[i + 1:] if x.text.strip())
        if not statute.text.startswith('The officer or employee may appeal'):
            raise SystemExit('aldermanic: appeal paragraph moved')
        runs_replace(ps[i], r'^.*$', '{{#appeal_procedure}}')
        for t in ('{{appeal_procedure}}', '{{/appeal_procedure}}', '{{^appeal_procedure}}'):
            statute.insert_paragraph_before(t, style=statute.style)
        after = statute._element.getnext()
        closing = copy.deepcopy(statute._element)
        statute._element.addnext(closing)
        from docx.text.paragraph import Paragraph
        cp = Paragraph(closing, statute._parent)
        for r in cp.runs[1:]:
            r._element.getparent().remove(r._element)
        cp.runs[0].text = '{{/appeal_procedure}}'
    doc.sub(r'increments of\s+workweeks', 'increments of {{exempt_suspension_increment}} workweeks')
    doc.sub(r'_{2,} \(_\) or more consecutive days', '{{no_call_days | words}} ({{no_call_days}}) or more consecutive days')
    doc.sub(r'\(insert pay period\)', '{{pay_period}}')
    doc.sub(r'\(insert pay date\)', '{{pay_day}}')
    doc.sub(r'_{2,} days prior to the pay date', '{{payroll_lead_days}} days prior to the pay date')
    doc.sub(r'\(biweekly or monthly\)', '{{pay_period}}')
    doc.sub(r'\(_+ ?p\.m\.\)', '{{check_ready_time}}')
    doc.sub(r'\(_{5,}\)', '{{retirement_plan}}')
    # Sick leave
    doc.sub(r'_{2,} \(_\) months of service with the', '{{sick_wait_months | words}} ({{sick_wait_months}}) months of service with the')
    doc.sub(r'_{2,} hours \(_ weeks?\) of Sick Leave', '{{sick_first_hours}} hours of Sick Leave')
    doc.sub(r'_{2,} \(_{1,}\) continuous months', '{{sick_after_months | words}} ({{sick_after_months}}) continuous months')
    doc.sub(r'_{2,} hours \(_{1,} weeks?\) of sick leave', '{{sick_after_hours}} hours of sick leave')
    doc.sub(r'no more than _{2,} hours of sick leave', 'no more than {{sick_max_hours}} hours of sick leave')
    # Personal leave
    doc.sub(r'at least _{2,} \(_\) months', 'at least {{personal_wait_months | words}} ({{personal_wait_months}}) months')
    doc.sub(r'with _{2,} \(_\) months of service', 'with {{personal_wait_months | words}} ({{personal_wait_months}}) months of service')
    doc.sub(r'_{2,} hours \(_{1,} days\) of personal leave', '{{personal_hours}} hours of personal leave')
    doc.sub(r'during the next _{2,} months', 'during the next {{personal_period_months}} months')
    doc.sub(r'maximum of _{2,} hours of Personal Leave', 'maximum of {{personal_max_hours}} hours of Personal Leave')
    # Vacation
    doc.sub(r'_{2,} days', '{{vacation_days_years_1_4}} days', where=r'First\s*[–-]\s*Fourth')
    doc.sub(r'_{2,} days', '{{vacation_days_years_5_9}} days', where=r'Fifth\s*[–-]\s*Ninth')
    doc.sub(r'_{2,} days', '{{vacation_days_year_10}} days', where=r'^\s*Tenth Anniversary')
    # Some versions relied on spacing (not a page break) to put the table of contents on page 2.
    # If nothing breaks the page between the title page and the TOC, add a break at the line above the TOC.
    ps = doc.d.paragraphs
    start = next(k for k, x in enumerate(ps) if '{{approval_date}}' in x.text)
    toc = next(k for k, x in enumerate(ps) if x.text.strip() == 'TABLE OF CONTENTS')
    between = ''.join(x._element.xml for x in ps[start:toc + 1])
    if not re.search(r'w:type="page"|w:pageBreakBefore|<w:sectPr', between):
        target = toc
        for k in range(toc - 1, start, -1):
            if ps[k].text.strip():
                if re.fullmatch(r'\s*_{10,}\s*', ps[k].text):
                    target = k
                break
        ps[target].paragraph_format.page_break_before = True
    doc.take_notes()
    doc.check_clean()
    doc.save(os.path.join(build, 'personnel-policies', f'{variant}.docx'))
    if handbook_notes is None:
        handbook_notes = doc.notes
    print(f'handbook/{variant}: ok, {len(doc.notes)} notes')

# ---------------------------------------------------------------- acknowledgment receipt (last page of the handbook)
for variant, path in (('town', HANDBOOKS['town']), ('all', HANDBOOKS['cm'])):
    doc = Doc(path, f'receipt/{variant}')
    remove_until(doc.d, r'^Employee Personnel Policy Receipt and Acknowledg')
    first = doc.d.paragraphs[0]
    # The heading carries the page break that started this page in the handbook; drop it.
    for br in first._element.xpath('.//w:br[@w:type="page"] | .//w:lastRenderedPageBreak'):
        br.getparent().remove(br)
    title = first.insert_paragraph_before()
    run = title.add_run('{{municipality_name}}')
    run.bold = True
    run.font.size = Pt(14)
    title.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_after = Pt(12)
    doc.check_clean()
    doc.save(os.path.join(build, 'acknowledgment-receipt', f'{variant}.docx'))
    print(f'receipt/{variant}: ok')

# ---------------------------------------------------------------- FMLA policy
fm = Doc(find(r'FMLA'), 'fmla')
remove_until(fm.d, r'^TO:')
fm.sub(r'(FROM:\s*).*$', r'\1{{issued_by}}')
fm.sub(r'^(DATE:\s*)$', r'\1{{issue_date}}')
fm.sub(r'(FMLA 12-Month Period:\s+)The 12-month period is measured forward.*$', r'\1{{fmla_12_month_method}}')
fm.sub(r'\bThe City\b', 'The {{unit}}', expect=None)
fm.sub(r'\bCity (employment|department)', r'{{unit}} \1', expect=2)
fm.take_notes()
fm.check_clean()
fm.save(os.path.join(build, 'fmla-policy', 'all.docx'))
print('fmla: ok')

# ---------------------------------------------------------------- question definitions
def num(key, label, help='', group=''):
    return {'key': key, 'type': 'number', 'label': label, 'help': help, 'group': group}

ABOUT, RECORDS, ATTEND, PAY, BENEFITS, SICK, PERSONAL, VAC = (
    'About your municipality', 'Personnel records', 'Discipline and attendance', 'Pay',
    'Retirement', 'Sick leave', 'Personal leave', 'Vacation')

handbook_fields = [
    {'key': 'municipality_name', 'type': 'text', 'label': 'Official name of your municipality', 'required': True, 'prefill': 'municipality', 'group': ABOUT,
     'help': 'As it should appear in the policy, e.g. “Town of Ada” or “City of Guthrie”.'},
    {'key': 'approval_date', 'type': 'date', 'label': 'Date the governing body approved this policy', 'group': ABOUT,
     'help': 'Leave blank if it hasn’t been approved yet. It prints as a blank line to fill in after the vote.'},
    {'key': 'records_approver', 'type': 'text', 'label': 'Who approves access to personnel records?', 'prefill': 'clerk', 'group': RECORDS,
     'help': 'A position, not a person, e.g. Town Clerk, City Clerk, City Manager, Town Administrator or Human Resources Director. It prints as “… with the approval of the City Clerk.”'},
    {'key': 'exempt_suspension_increment', 'type': 'text', 'label': 'Unpaid suspensions of exempt (salaried) employees are in increments of … workweeks', 'default': 'full', 'group': ATTEND,
     'help': 'OMAG’s sample uses full workweeks. Unpaid suspensions of exempt employees must follow the FLSA salary-basis rules (29 C.F.R. § 541.602(b)(5)). Talk to your municipal attorney before changing this.'},
    {'key': 'harassment_report_to', 'type': 'text', 'label': 'Who should employees report harassment to?', 'group': ATTEND,
     'help': 'A position, e.g. the Human Resources Director, City Manager or Town Clerk. Pick someone outside the usual chain of command if you can, and name a backup in your own procedures.'},
    {'key': 'appeal_procedure', 'type': 'textarea', 'label': 'Appeal procedure from your city ordinance (if you have one)', 'group': ATTEND,
     'help': 'Paste the appeal procedure your City Council adopted by ordinance. Leave blank to use the state-law procedure (11 O.S. § 9-118): a written appeal to the City Council within ten (10) days.'},
    num('no_call_days', 'Days absent without notice before an employee is considered to have resigned', 'Enter a number, e.g. 3. It prints as “three (3)”.', ATTEND),
    {'key': 'pay_period', 'type': 'select', 'label': 'How often are employees paid?', 'group': PAY, 'default': 'biweekly',
     'options': [{'value': 'weekly', 'label': 'Weekly', 'text': 'weekly'}, {'value': 'biweekly', 'label': 'Every two weeks (biweekly)', 'text': 'biweekly'},
                 {'value': 'semimonthly', 'label': 'Twice a month (semimonthly)', 'text': 'semimonthly'}, {'value': 'monthly', 'label': 'Monthly', 'text': 'monthly'}]},
    {'key': 'pay_day', 'type': 'text', 'label': 'When are employees paid for a pay period?', 'group': PAY,
     'help': 'Finishes the sentence “Employees are paid for a given pay period on …”, e.g. “the Friday following the end of the pay period”.'},
    num('payroll_lead_days', 'How many days before payday must payroll be processed?', '', PAY),
    {'key': 'check_ready_time', 'type': 'text', 'label': 'What time are paychecks ready on payday?', 'group': PAY, 'help': 'e.g. 3:00 p.m.'},
    {'key': 'retirement_plan', 'type': 'text', 'label': 'Which retirement plan does your municipality pay into?', 'group': BENEFITS,
     'help': 'e.g. the Oklahoma Municipal Retirement Fund (OkMRF). Leave blank if none.'},
    num('sick_wait_months', 'Months of service before an employee can use sick leave', 'It prints as words and numerals, e.g. “three (3)”.', SICK),
    num('sick_first_hours', 'Sick leave hours for the six months after that', '', SICK),
    num('sick_after_months', 'Months of continuous service before the regular sick leave rate starts', '', SICK),
    num('sick_after_hours', 'Sick leave hours earned per six months after that', '', SICK),
    num('sick_max_hours', 'Most sick leave hours an employee can accumulate', '', SICK),
    num('personal_wait_months', 'Months of service before an employee earns personal leave', '', PERSONAL),
    num('personal_hours', 'Personal leave hours earned', '', PERSONAL),
    num('personal_period_months', '… to use during the next how many months?', '', PERSONAL),
    num('personal_max_hours', 'Most personal leave hours an employee with 12+ months of service earns', '', PERSONAL),
    num('vacation_days_years_1_4', 'Vacation days per year: 1st through 4th anniversary', '', VAC),
    num('vacation_days_years_5_9', 'Vacation days per year: 5th through 9th anniversary', '', VAC),
    num('vacation_days_year_10', 'Vacation days per year: 10th anniversary and after', '', VAC),
]

notes_handbook = [
    'Your governing body must approve the Employee Personnel Policy before you give it to employees, and each employee should sign and date the Receipt and Acknowledgement page.',
    'The General Policies and Provisions section refers to a Charter. If your municipality hasn’t adopted a charter, delete those references.',
] + handbook_notes + [
    'Have your municipal attorney or OMAG Legal Services review the finished policy before it’s adopted. OMAG: 1-800-234-9461.'
]

fmla_fields = [
    {'key': 'issued_by', 'type': 'text', 'label': 'Who is the policy from?', 'group': 'About the policy',
     'help': 'Shown on the “FROM” line, e.g. City Manager, Human Resources Director, Town Clerk or Board of Trustees.'},
    {'key': 'issue_date', 'type': 'date', 'label': 'Date of the policy', 'prefill': 'today', 'group': 'About the policy'},
    {'key': 'fmla_12_month_method', 'type': 'select', 'label': 'How will you measure the FMLA 12-month period?', 'default': 'forward', 'group': 'FMLA 12-month period',
     'help': 'Employers may choose any one of these four methods (29 C.F.R. § 825.200(b)) but must apply it to all employees. OMAG’s sample uses “measured forward”. Changing methods requires 60 days’ notice to employees.',
     'options': [
        {'value': 'forward', 'label': 'Measured forward from the date an employee’s first FMLA leave begins (OMAG’s sample)',
         'text': 'The 12-month period is measured forward from the date an employee’s first FMLA leave begins.  Example: If an employee’s FMLA 12-month period begins on June 9 it will run until the following June 8. (§ 825.200(b)(3)).'},
        {'value': 'rolling', 'label': 'A “rolling” period measured backward from each date leave is used',
         'text': 'The 12-month period is a “rolling” 12-month period measured backward from the date an employee uses any FMLA leave. Each time an employee takes FMLA leave, the remaining entitlement is the balance of the 12 weeks not used during the immediately preceding 12 months. (§ 825.200(b)(4)).'},
        {'value': 'calendar', 'label': 'The calendar year (January 1 – December 31)',
         'text': 'The 12-month period is the calendar year, January 1 through December 31. (§ 825.200(b)(1)).'},
        {'value': 'fiscal', 'label': 'The fiscal year (July 1 – June 30)',
         'text': 'The 12-month period is the fiscal year, July 1 through June 30. (§ 825.200(b)(2)).'}]},
]
notes_fmla = [
    'This policy template is meant to provide general guidelines and should be used as a reference. It may not take into account all relevant ordinances, charters, policies, practices or organizational structure particular to your municipality.',
    'Have your municipal attorney review it before distribution to make sure it reflects the laws, policies, procedures and practices adopted by your governing body.',
    'Section VII.A lets employees substitute sick leave, vacation, compensatory time and donated sick leave. Remove any your municipality doesn’t offer.',
    'OMAG’s Municipal Liability Protection Plan includes defense-only coverage for FMLA claims (Coverage L). Call OMAG at 1-800-234-9461 with questions.',
] + fm.notes

manifest = {
    'format': 'pip-templates', 'version': 1,
    'templates': [
        {'id': 'personnel-policies', 'order': 1, 'enabled': True, 'title': 'Employee Personnel Policy',
         'description': 'OMAG’s sample personnel policy handbook for your form of government, with your pay, leave and benefit details filled in.',
         'notes': notes_handbook, 'fields': handbook_fields,
         'variants': {v: {'file': f'personnel-policies/{v}.docx', 'filename': os.path.basename(p)} for v, p in HANDBOOKS.items()}},
        {'id': 'fmla-policy', 'order': 2, 'enabled': True, 'title': 'FMLA Leave Policy',
         'description': 'OMAG’s sample Employee and Family Member FMLA policy, set up for your municipality.',
         'notes': notes_fmla, 'fields': fmla_fields,
         'variants': {'all': {'file': 'fmla-policy/all.docx', 'filename': 'OMAG SAMPLE FMLA EMPLOYEE FAMILY MEMBER POLICY.docx'}}},
        {'id': 'acknowledgment-receipt', 'order': 3, 'enabled': True, 'title': 'Personnel Policy Receipt and Acknowledgement',
         'description': 'The signature page each employee signs to acknowledge the personnel policy.',
         'notes': ['Each employee should sign and date this page when they receive the personnel policy. Keep the signed page in their personnel file.'],
         'fields': [handbook_fields[0]],
         'variants': {'town': {'file': 'acknowledgment-receipt/town.docx', 'filename': 'Receipt (Town).docx'},
                      'all': {'file': 'acknowledgment-receipt/all.docx', 'filename': 'Receipt (City).docx'}}},
    ]
}

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False))
    for t in manifest['templates']:
        for v in t['variants'].values():
            z.write(os.path.join(build, v['file']), v['file'])
print('wrote', OUT)
