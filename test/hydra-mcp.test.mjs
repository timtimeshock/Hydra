import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { MCPClient } from '../lib/hydra-mcp.mjs';

const PIPED_STDIO_SUPPORTED = (() => {
  try {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return !(r.error && String(r.error?.code || '') === 'EPERM');
  } catch {
    return false;
  }
})();

test('MCPClient starts and communicates via JSON-RPC with a mock server', {
  timeout: 15_000,
  skip: PIPED_STDIO_SUPPORTED ? false : 'Environment forbids piped stdio (child_process pipe EPERM)',
}, async () => {
  // Use node as a mock MCP server that echoes JSON-RPC
  const script = `
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            const response = { jsonrpc: '2.0', id: msg.id, result: { echo: msg.method, params: msg.params } };
            process.stdout.write(JSON.stringify(response) + '\\n');
          }
        } catch {}
      }
    });
  `;

  const client = new MCPClient(process.execPath, ['-e', script]);

  // Start should call initialize and get a response
  const initResult = await client.start();
  assert.ok(initResult, 'Start should return init result');
  assert.equal(initResult.echo, 'initialize');
  assert.equal(initResult.params.clientInfo.name, 'hydra');

  // isAlive should be true
  assert.ok(client.isAlive());
  assert.ok(client.uptimeMs() >= 0);

  // Call a tool
  const toolResult = await client.callTool('test-tool', { prompt: 'hello' });
  assert.ok(toolResult);
  assert.equal(toolResult.echo, 'tools/call');
  assert.equal(toolResult.params.name, 'test-tool');
  assert.equal(toolResult.params.arguments.prompt, 'hello');

  // List tools
  const listResult = await client.listTools();
  assert.equal(listResult.echo, 'tools/list');

  // Close
  await client.close();
  assert.ok(!client.isAlive());
});

test('MCPClient handles process exit gracefully', {
  timeout: 10_000,
  skip: PIPED_STDIO_SUPPORTED ? false : 'Environment forbids piped stdio (child_process pipe EPERM)',
}, async () => {
  const client = new MCPClient(process.execPath, ['-e', 'process.exit(0)']);

  // Start will fail because process exits immediately after init request
  try {
    await client.start();
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('exited') || err.message.includes('timed out') || err.message.includes('MCP'));
  }

  assert.ok(!client.isAlive());
});

test('MCPClient rejects calls when not started', async () => {
  const client = new MCPClient('nonexistent', []);

  try {
    await client.call('test', {});
    assert.fail('Should have thrown');
  } catch (err) {
    assert.match(err.message, /not started/i);
  }
});
