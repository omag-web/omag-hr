// The two tools Pip uses to research: search the library, then read sections.

export const TOOL_SPECS = [
  {
    toolSpec: {
      name: 'search_law',
      description: 'Search the library: Oklahoma Statutes for municipalities, federal employment regulations, and OMAG guidance documents. Returns matching sections with id, citation, heading and a short excerpt. Use get_sections to read full text before citing.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keywords a statute would use, or a citation like "11 O.S. § 12-106" or "29 CFR 825.110".' },
            jurisdiction: { type: 'string', enum: ['OK', 'US', 'OMAG', 'any'], description: 'OK = Oklahoma statutes, US = federal regulations, OMAG = OMAG guidance documents, any = all (default).' }
          },
          required: ['query']
        }
      }
    }
  },
  {
    toolSpec: {
      name: 'get_sections',
      description: 'Read the full text of up to 6 sections by library id (e.g. "11-12-106", "29-CFR-825.110").',
      inputSchema: {
        json: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 6 } },
          required: ['ids']
        }
      }
    }
  }
];

/** Offered only when OMAG has document templates turned on. */
export const OFFER_DOCUMENT_SPEC = {
  toolSpec: {
    name: 'offer_document',
    description: 'Show the member a button to build one of OMAG’s document templates (a filled-in Word file). Use it when the member asks you to create, draft, write or update a policy or document that matches a template, or when one would clearly help. Do not write the document text yourself when a template exists. You may pass answers the member already told you.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          template_id: { type: 'string', description: 'The template id from the list in your instructions.' },
          prefill: { type: 'object', description: 'Optional answers the member already gave, keyed by field name (e.g. {"municipality_name": "Town of Ada"}). Only include facts the member stated.', additionalProperties: { type: ['string', 'number', 'boolean'] } }
        },
        required: ['template_id']
      }
    }
  }
};

const MAX_SECTION_CHARS = 9000;

/** Runs a tool call. Returns { result, status, ids } where ids are sections the model has now seen. */
export function runTool(name, input, library, ctx = {}) {
  if (name === 'offer_document') {
    const t = (ctx.templates || []).find((x) => x.id === String(input?.template_id || ''));
    if (!t) return { status: 'Finding a document template', ids: [], result: { error: 'No template with that id. Use an id from the list.' } };
    const keys = new Set(t.fields.map((f) => f.key));
    const prefill = {};
    for (const [k, v] of Object.entries(input?.prefill && typeof input.prefill === 'object' ? input.prefill : {})) {
      if (keys.has(k) && ['string', 'number', 'boolean'].includes(typeof v)) prefill[k] = typeof v === 'string' ? v.slice(0, 500) : v;
    }
    ctx.offers?.push({ templateId: t.id, title: t.title, prefill });
    return {
      status: `Getting the ${t.title} ready`, ids: [],
      result: { shown: true, title: t.title, message: 'A “Build this document” button is now shown below your answer. Briefly tell the member what the document is and that they’ll answer a few questions, then download the Word file. Mention anything they should decide first. Don’t repeat the questions.' }
    };
  }
  if (name === 'search_law') {
    const q = String(input?.query || '').slice(0, 300);
    const j = ['OK', 'US', 'OMAG'].includes(input?.jurisdiction) ? input.jurisdiction : undefined;
    const hits = library.search(q, { jurisdiction: j, limit: 8 });
    return {
      status: `Searching ${j === 'US' ? 'federal regulations' : j === 'OK' ? 'Oklahoma statutes' : j === 'OMAG' ? 'OMAG guidance' : 'the library'} for “${q}”`,
      ids: [],
      result: hits.length
        ? { results: hits.map((s) => ({ id: s.id, cite: s.cite, heading: s.heading, excerpt: s.text.slice(0, 280).replace(/\s+/g, ' ') + (s.text.length > 280 ? '…' : '') })) }
        : { results: [], message: 'No matching sections. Try different words or a citation.' }
    };
  }
  if (name === 'get_sections') {
    const ids = (Array.isArray(input?.ids) ? input.ids : []).slice(0, 6);
    const found = [];
    const missing = [];
    for (const raw of ids) {
      const s = library.get(raw);
      if (s) found.push(s); else missing.push(String(raw));
    }
    return {
      status: found.length ? `Reading ${found.map((s) => s.cite).join(', ')}` : 'Looking up sections',
      ids: found.map((s) => s.id),
      result: {
        sections: found.map((s) => ({
          id: s.id, cite: s.cite, heading: s.heading, source: s.source,
          text: s.text.length > MAX_SECTION_CHARS ? s.text.slice(0, MAX_SECTION_CHARS) + '\n[…truncated]' : s.text
        })),
        ...(missing.length ? { not_found: missing } : {})
      }
    };
  }
  return { status: 'Working', ids: [], result: { error: `Unknown tool ${name}` } };
}
