import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync(new URL('../app/src/lib/tvContextMenu.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { bindContextMenu } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

// v32.1 appends a listener on every onContextMenu call, then combines all
// listeners' returned items when the menu opens. Registering [] does not clear it.
function accumulatingWidget() {
  const listeners = [];
  return {
    onContextMenu(provider) { listeners.push(provider); },
    open(time = 1000, price = 20000.25) { return listeners.flatMap(provider => provider(time, price)); },
    get registrations() { return listeners.length; },
  };
}

function provider(quantity, account = 'Sim101', symbol = 'NQ SEP26', calls = []) {
  return (time, price) => ['BUY', 'SELL'].map(action => ({
    position: 'top',
    text: `${account} ${symbol} ${action} @ ${price} x${quantity}`,
    click: () => calls.push({ action, quantity, account, symbol, time, price }),
  }));
}

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log(`PASS ${name}`);
}

test('the widget fixture reproduces SDK accumulation including no-op registrations', () => {
  const widget = accumulatingWidget();
  widget.onContextMenu(provider(1));
  widget.onContextMenu(() => []);
  widget.onContextMenu(provider(2));
  assert.equal(widget.open().length, 4);
});

test('repeated quantity changes expose exactly two current items with one SDK registration', () => {
  const widget = accumulatingWidget();
  const clicks = [];
  for (let quantity = 1; quantity <= 100; quantity++) {
    bindContextMenu(widget, provider(quantity, 'Sim101', 'NQ SEP26', clicks));
    const items = widget.open(1234, 20123.75);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.text), [
      `Sim101 NQ SEP26 BUY @ 20123.75 x${quantity}`,
      `Sim101 NQ SEP26 SELL @ 20123.75 x${quantity}`,
    ]);
    assert.equal(widget.registrations, 1);
  }
  widget.open(1234, 20123.75)[0].click();
  assert.deepEqual(clicks, [{ action: 'BUY', quantity: 100, account: 'Sim101', symbol: 'NQ SEP26', time: 1234, price: 20123.75 }]);
});

test('cleanup empties the menu without adding another SDK listener and is idempotent', () => {
  const widget = accumulatingWidget();
  const cleanup = bindContextMenu(widget, provider(5));
  assert.equal(widget.open().length, 2);
  cleanup();
  assert.deepEqual(widget.open(), []);
  cleanup();
  assert.deepEqual(widget.open(), []);
  assert.equal(widget.registrations, 1);
});

test('late cleanup from a replaced binding preserves the latest account and symbol', () => {
  const widget = accumulatingWidget();
  let obsoleteInvocations = 0;
  const cleanupOld = bindContextMenu(widget, () => {
    obsoleteInvocations++;
    return provider(1)();
  });
  const clicks = [];
  const cleanupCurrent = bindContextMenu(widget, provider(3, 'Sim202', 'ES SEP26', clicks));
  cleanupOld();
  const items = widget.open(4321, 6500.5);
  assert.equal(items.length, 2);
  assert.equal(items[1].text, 'Sim202 ES SEP26 SELL @ 6500.5 x3');
  items[1].click();
  assert.deepEqual(clicks, [{ action: 'SELL', quantity: 3, account: 'Sim202', symbol: 'ES SEP26', time: 4321, price: 6500.5 }]);
  assert.equal(obsoleteInvocations, 0);
  cleanupCurrent();
  assert.deepEqual(widget.open(), []);
  assert.equal(widget.registrations, 1);
});

test('binding the same provider twice gives each cleanup a separate ownership token', () => {
  const widget = accumulatingWidget();
  const sameProvider = provider(7);
  const firstCleanup = bindContextMenu(widget, sameProvider);
  const secondCleanup = bindContextMenu(widget, sameProvider);
  firstCleanup();
  assert.equal(widget.open().length, 2);
  secondCleanup();
  assert.deepEqual(widget.open(), []);
  assert.equal(widget.registrations, 1);
});

test('two widgets retain separate providers and cleanup state', () => {
  const first = accumulatingWidget();
  const second = accumulatingWidget();
  const cleanupFirst = bindContextMenu(first, provider(2, 'Sim101', 'NQ SEP26'));
  bindContextMenu(second, provider(9, 'Sim202', 'ES SEP26'));
  assert.equal(first.open()[0].text, 'Sim101 NQ SEP26 BUY @ 20000.25 x2');
  assert.equal(second.open()[0].text, 'Sim202 ES SEP26 BUY @ 20000.25 x9');
  cleanupFirst();
  assert.deepEqual(first.open(), []);
  assert.equal(second.open().length, 2);
  assert.equal(first.registrations, 1);
  assert.equal(second.registrations, 1);
});

test('cleanup then rebind reuses the original SDK listener through repeated effect lifecycles', () => {
  const widget = accumulatingWidget();
  let previousCleanup = () => {};
  for (const quantity of [1, 5, 3, 8, 2]) {
    previousCleanup();
    assert.deepEqual(widget.open(), []);
    const cleanup = bindContextMenu(widget, provider(quantity));
    previousCleanup();
    assert.equal(widget.open().length, 2);
    assert.equal(widget.open()[0].text, `Sim101 NQ SEP26 BUY @ 20000.25 x${quantity}`);
    assert.equal(widget.registrations, 1);
    previousCleanup = cleanup;
  }
  previousCleanup();
  assert.deepEqual(widget.open(), []);
});

console.log(`PASS ${passed} context-menu tests`);
