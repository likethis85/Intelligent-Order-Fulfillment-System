import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const traysPagePath = path.resolve(__dirname, '../src/sections/TraysPage.tsx');

test('TraysPage: hover fabric quick preview is removed while click-to-query modal is preserved', async (t) => {
  const code = fs.readFileSync(traysPagePath, 'utf8');

  await t.test('FabricQuickTooltip component and hover state are completely removed', () => {
    assert.doesNotMatch(code, /FabricQuickTooltip/);
    assert.doesNotMatch(code, /const \[fabricTip, setFabricTip\]/);
    assert.doesNotMatch(code, /onHoverFabricQuick/);
    assert.doesNotMatch(code, /onLeaveFabricQuick/);
  });

  await t.test('FieldRenderCtx no longer has onHoverFabric or onLeaveFabric', () => {
    assert.doesNotMatch(code, /onHoverFabric\?:/);
    assert.doesNotMatch(code, /onLeaveFabric\?:/);
  });

  await t.test('FIELDS "面料情况" cell retains click-to-query handler', () => {
    assert.ok(code.includes('onClick={() => ctx.onPickFabric?.(ctx.pid)}'));
    assert.match(code, /title=\{hasAnyContent \? `编辑面料（\$\{pids\.map/);
  });

  await t.test('TraysPage aggregateRender binds onPickFabric to setFabricPicker', () => {
    assert.match(code, /onPickFabric: \(p\) => \{\s*setFabricPicker\(\{ sectionId: s\.id, lookId: l\.id, pid: p \}\);\s*\}/);
  });

  await t.test('TraysPage preserves fabricPicker modal and iframe query', () => {
    assert.match(code, /const \[fabricPicker, setFabricPicker\] = useState/);
    assert.match(code, /\{fabricPicker && \(\(\) => \{/);
    assert.match(code, /key="fabric-q-iframe"/);
    assert.match(code, /FABRIC_BASE/);
  });
});
