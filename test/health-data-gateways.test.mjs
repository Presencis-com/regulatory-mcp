import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio advertises and serves the exact local atlas rows', { timeout: 10000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    stderr: 'inherit',
  });
  const client = new Client({ name: 'health-data-gateway-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['list_health_data_gateways', 'get_health_data_gateway']) {
      const tool = tools.find(item => item.name === name);
      assert.equal(tool?.annotations.readOnlyHint, true, `${name} must be advertised as read-only`);
    }
    const list = args => client.callTool({ name: 'list_health_data_gateways', arguments: args });
    const get = args => client.callTool({ name: 'get_health_data_gateway', arguments: args });
    const payload = result => {
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const gateways = JSON.parse(readFileSync(new URL('../data/health-data-gateways.json', import.meta.url), 'utf8'));
    assert.deepEqual(payload(await list({})), { count: gateways.length, gateways });
    const finland = gateways.find(row => row.gateway_id === 'fi-findata');
    assert.deepEqual(payload(await list({ jurisdiction: 'Finland', spe_or_sde_required: true })), {
      count: 1, gateways: [finland],
    });
    assert.deepEqual(payload(await list({ jurisdiction: 'Finland', spe_or_sde_required: false })), {
      count: 0, gateways: [],
    });
    assert.deepEqual(payload(await get({ gateway_id: 'fi-findata' })), { gateway: finland });
    for (const [result, diagnostic] of [
      [await list({ jurisdiction: 'Elsewhere' }), /unknown jurisdiction/],
      [await list({ spe_or_sde_required: 'false' }), /invalid arguments/],
      [await get({ gateway_id: 'FI-FINDATA' }), /invalid arguments/],
      [await get({ gateway_id: 'unknown-id' }), /unknown gateway id/],
      [await get({ gateway_id: 'fi-findata', extra: true }), /invalid arguments/],
      [await get({}), /invalid arguments/],
    ]) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, diagnostic);
    }
  } finally {
    await client.close();
  }
});
