import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const traysPagePath = path.resolve(__dirname, '../src/sections/TraysPage.tsx');
const productsPath = path.resolve(__dirname, '../src/data/products.ts');
const traySyncPath = path.resolve(__dirname, '../src/lib/traySync.ts');

test('TraysPage: style code cell background and font color customization', async (t) => {
  const code = fs.readFileSync(traysPagePath, 'utf8');
  const productsCode = fs.readFileSync(productsPath, 'utf8');
  const syncCode = fs.readFileSync(traySyncPath, 'utf8');

  await t.test('data types support codeBgColor and codeFgColor', () => {
    assert.match(productsCode, /codeBgColor\?: 'yellow' \| 'blue' \| 'none' \| string;/);
    assert.match(productsCode, /codeFgColor\?: 'red' \| 'black' \| string;/);
    assert.match(productsCode, /codeBgColorByLook\?: Record<string, 'yellow' \| 'blue' \| 'none' \| string>;/);
    assert.match(productsCode, /codeFgColorByLook\?: Record<string, 'red' \| 'black' \| string>;/);
  });

  await t.test('traySync diff and KEYED_FIELDS track code colors', () => {
    assert.ok(syncCode.includes("'codeBgColorByLook'"));
    assert.ok(syncCode.includes("'codeFgColorByLook'"));
    assert.ok(syncCode.includes("put('款号背景色',"));
    assert.ok(syncCode.includes("put('款号字体色',"));
  });

  await t.test('defines CodeColorPicker/CodeColorPickerDialog component with yellow, blue, and red options', () => {
    assert.match(code, /function CodeColorPicker(Dialog)?\(/);
    assert.ok(code.includes('格子背景颜色'));
    assert.ok(code.includes('字体颜色'));
    assert.ok(code.includes('黄色'));
    assert.ok(code.includes('蓝色'));
    assert.ok(code.includes('红色'));
    assert.ok(code.includes('默认无色'));
  });

  await t.test('FieldRenderCtx includes codeBgColor and codeFgColor callbacks', () => {
    assert.match(code, /codeBgColor\?: string;/);
    assert.match(code, /codeFgColor\?: string;/);
    assert.match(code, /onSaveCodeBgColor\?: \(color: string\) => void;/);
    assert.match(code, /onSaveCodeFgColor\?: \(color: string\) => void;/);
  });

  await t.test('table cell binds background color class and passes color props', () => {
    assert.ok(code.includes("const isCodeRow = f.label === '款号';"));
    assert.ok(code.includes("!bg-[#fef08a] dark:!bg-[#854d0e]/40"));
    assert.ok(code.includes("!bg-[#bae6fd] dark:!bg-[#075985]/40"));
    assert.ok(code.includes("${cell} ${codeBgCls}"));
  });

  await t.test('Excel export supports custom code background and font colors', () => {
    assert.ok(code.includes("f.dataStyle === 'codeBlue' || f.label === '款号'"));
    assert.ok(code.includes("argb: 'FFFFFF00'"));
    assert.ok(code.includes("argb: 'FF04B0F1'"));
    assert.ok(code.includes("argb: fontColor"));
  });

  await t.test('component includes setCodeBgColor and setCodeFgColor state setters', () => {
    assert.ok(code.includes("const setCodeBgColor = (_sectionId: string, lookId: string, color: string) => {"));
    assert.ok(code.includes("const setCodeFgColor = (_sectionId: string, lookId: string, color: string) => {"));
  });
});
