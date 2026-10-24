import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('TraysPage: custom unlisted products support (不在库自定义款)', async (t) => {
  const productsTs = fs.readFileSync(path.join(__dirname, '../src/data/products.ts'), 'utf8');
  const productsContextTsx = fs.readFileSync(path.join(__dirname, '../src/data/ProductsContext.tsx'), 'utf8');
  const traySyncTs = fs.readFileSync(path.join(__dirname, '../src/lib/traySync.ts'), 'utf8');
  const traysPageTsx = fs.readFileSync(path.join(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

  await t.test('data types support CustomProduct and Tray.customProducts', () => {
    assert.match(productsTs, /export interface CustomProduct \{/);
    assert.match(productsTs, /id:\s*string;/);
    assert.match(productsTs, /name:\s*string;/);
    assert.match(productsTs, /isCustom\?:\s*boolean;/);
    assert.match(productsTs, /customProducts\?:\s*Record<string,\s*CustomProduct>;/);
  });

  await t.test('traySync KEYED_FIELDS, mergeTray and diffTray track customProducts', () => {
    assert.match(traySyncTs, /'customProducts'/);
    assert.match(traySyncTs, /put\('自定义款',/);

    // Verify valStr safely stringifies object structures like { id, name }
    assert.match(traySyncTs, /function valStr\(/);
  });

  await t.test('useProductResolver prioritizes official product library and falls back to custom products', () => {
    // Check useProductResolver signature accepts customMap
    assert.match(productsContextTsx, /export function useProductResolver\(\s*pids:\s*string\[\],\s*customMap\?:/);

    // Check prioritization order in useProductResolver
    const realIdx = productsContextTsx.indexOf('const real = productMap.get(lower);');
    const customIdx = productsContextTsx.indexOf('if (customMap) {');
    assert.ok(realIdx > 0, 'Checks productMap first');
    assert.ok(customIdx > realIdx, 'Checks customMap after productMap');
    assert.match(productsContextTsx, /isCustom:\s*true/);
  });

  await t.test('TraysPage LookPicker supports entering style code, product name and multi-custom items', () => {
    // Check LookPicker signature and props
    assert.match(traysPageTsx, /function LookPicker\(\{[\s\S]*?initialCustomProducts[\s\S]*?onConfirm/);

    // Check customRows state and add handler
    assert.match(traysPageTsx, /const \[customRows,\s*setCustomRows\] = useState/);
    assert.match(traysPageTsx, /const \[customItems,\s*setCustomItems\] = useState/);
    assert.match(traysPageTsx, /const handleAddCustomRows = \(\) =>/);

    // Check UI panel for adding custom unlisted items
    assert.match(traysPageTsx, /添加不在库自定义款/);
    assert.match(traysPageTsx, /支持多款|支持一坑多款/);
    assert.match(traysPageTsx, /款号 如 ME26DW01/);
    assert.match(traysPageTsx, /商品名称 如 羊绒西装/);
    assert.match(traysPageTsx, /增加一款/);

    // Check 1-click helper when search has no match
    assert.match(traysPageTsx, /不在库？点此添加为自定义款/);

    // Check rendering custom items in candidates list with badges
    assert.match(traysPageTsx, /已添加不在库自定义款/);
    assert.match(traysPageTsx, /未入库/);
  });

  await t.test('addLooks stores custom items into tray.customProducts and passes to resolver', () => {
    // Check addLooks signature
    assert.match(traysPageTsx, /const addLooks = \([\s\S]*?customItems\?: Array<\{ id: string; name: string \}>/);
    assert.match(traysPageTsx, /nextCustom\[code\.toLowerCase\(\)\] = \{/);
    assert.match(traysPageTsx, /allCustomProducts[\s\S]*?useProductResolver\(allPids,\s*allCustomProducts\)/);
  });

  await t.test('Table view displays 未入库 badge for custom styles', () => {
    assert.match(traysPageTsx, /ps\.some\(\(p\) => p\.isCustom\)/);
    assert.match(traysPageTsx, /未入库/);
  });
});
