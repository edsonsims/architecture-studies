import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const graph = {
  contracts: [],
  layered: ['contracts'],
  'hex-domain': [],
  'hex-application': ['hex-domain'],
  'hex-adapters': ['contracts', 'hex-domain', 'hex-application'],
  'event-driven': ['contracts'],
  demo: ['contracts', 'layered', 'hex-adapters', 'event-driven'],
  'http-api': ['contracts', 'layered', 'hex-adapters', 'event-driven'],
};
const nodeAllowed = new Set(['layered', 'hex-adapters', 'event-driven', 'demo', 'http-api']);
const external = { 'http-api': ['fastify'] };
function files(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]);
}

test('Workspace manifests and actual imports obey the declared dependency directions', () => {
  for (const [name, allowed] of Object.entries(graph)) {
    const base = resolve('packages', name);
    const manifest = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(),
      [...allowed.map(dependency => `@architecture-studies/${dependency}`), ...(external[name] ?? [])].sort(), name);
    for (const file of files(join(base, 'src')).filter(path => path.endsWith('.ts'))) {
      const source = readFileSync(file, 'utf8');
      // This small study permits static imports only. Project references also
      // enforce compilation boundaries; this checks the intended import graph.
      assert.doesNotMatch(source, /\b(?:require|import)\s*\(/, `Dynamic import needs an explicit boundary review: ${file}`);
      const imports = /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
      for (const match of source.matchAll(imports)) {
          const specifier = match[1];
          if (specifier.startsWith('.')) {
            assert.ok(resolve(dirname(file), specifier).startsWith(base + sep), `Cross-package relative import: ${file}`);
          } else if (specifier.startsWith('node:')) {
            assert.ok(nodeAllowed.has(name), `Node API leaked into ${name}: ${specifier}`);
          } else {
            assert.ok(allowed.some(dependency => specifier === `@architecture-studies/${dependency}`) || (external[name] ?? []).includes(specifier),
              `Forbidden dependency in ${name}: ${specifier}`);
          }
      }
    }
  }
});
