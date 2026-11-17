# @presencis/regulatory-mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the public Presencis regulatory corpus. It answers from a bundled JSON snapshot. It does not open network connections and it does not write files.

Tools:

- `list_frameworks` — optional exact `jurisdiction` or `sector`
- `get_framework` — exact `id`
- `find_crosswalk` — `source_id`, optional `target_id`
- `search_compliance_qa` — `query`, optional `regulation` and `limit`
- `map_sector_obligations` — exact `sector`

Question hits cite `https://presencis.com/questions/<slug>/`.

## Run from a checkout

Node.js 22 or newer.

```bash
npm install
export PRESENCIS_CORPUS_ROOT=/path/to/corpus
export CROSSWALKS_DATA=/path/to/regulatory-crosswalks/data
npm run sync
npm run build
node dist/index.js
```

`npm test` builds and runs the stdio JSON-RPC checks.

## Clients

The same `npx` configuration works for Claude Desktop, Cursor, and Antigravity:

```json
{
  "mcpServers": {
    "presencis-regulatory": {
      "command": "npx",
      "args": ["-y", "@presencis/regulatory-mcp"]
    }
  }
}
```

For a local checkout build, point `command` at `node` and `args` at the absolute path of `dist/index.js`.

## Related Documentation

- [Presencis Regulatory Corpus](https://presencis.com/regulations/) · [Compliance Q&A](https://presencis.com/questions/)
- [Aegis Regulatory Readiness](https://presencis.com/solutions/aegis/) · [Vigil Estate Visibility](https://presencis.com/solutions/vigil/)
- [Sovereign AI OS](https://presencis.com/solutions/sovereign-ai-os/) · [Forge Prover](https://presencis.com/solutions/forge-prover/) · [Edge Mend](https://presencis.com/solutions/edge-mend/)

Apache-2.0.
