const assert = require('node:assert/strict');
const test = require('node:test');
const { packInventory } = require('../verify-package-inventory.cjs');

const inventory = { name: '@codexstar/bug-hunter', size: 10, unpackedSize: 20, files: [{ path: 'SKILL.md' }] };

test('packInventory reads the npm <= 11 array shape', () => {
  assert.equal(packInventory([inventory]), inventory);
});

test('packInventory reads the npm 12 object keyed by package name', () => {
  assert.equal(packInventory({ '@codexstar/bug-hunter': inventory }), inventory);
});

test('packInventory rejects output without exactly one file inventory', () => {
  for (const parsed of [null, [], {}, [{}], { a: inventory, b: inventory }, 'text']) {
    assert.throws(() => packInventory(parsed), /did not return a file inventory/);
  }
});
