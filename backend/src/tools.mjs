// The two tools Pip uses to research: search the library, then read sections.

export const TOOL_SPECS = [
  {
    toolSpec: {
      name: 'search_law',
      description: 'Search the statute library (Oklahoma Statutes for municipalities and federal employment regulations). Returns matching sections with id, citation, heading and a short excerpt. Use get_sections to read full text before citing.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keywords a statute would use, or a citation like "11 O.S. § 12-106" or "29 CFR 825.110".' },
            jurisdiction: { type: 'string', enum: ['OK', 'US', 'any'], description: 'OK = Oklahoma statutes, US = federal regulations, any = both (default).' }
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

const MAX_SECTION_CHARS = 9000;

/** Runs a tool call. Returns { result, status, ids } where ids are sections the model has now seen. */
export function runTool(name, input, library) {
  if (name === 'search_law') {
    const q = String(input?.query || '').slice(0, 300);
    const j = input?.jurisdiction === 'OK' || input?.jurisdiction === 'US' ? input.jurisdiction : undefined;
    const hits = library.search(q, { jurisdiction: j, limit: 8 });
    return {
      status: `Searching ${j === 'US' ? 'federal regulations' : j === 'OK' ? 'Oklahoma statutes' : 'the statute library'} for “${q}”`,
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
