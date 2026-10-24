import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFilenameFromUploadUrl, deleteUploadedImage } from '../server/uploads.js';
import { extractReferencedImageFilenames } from '../server/trays-store.js';
import { deleteOssObject } from '../server/oss-client.js';

test('uploads: extractFilenameFromUploadUrl correctly parses diverse upload URLs', () => {
  assert.equal(extractFilenameFromUploadUrl('/uploads/me15fw033-123.jpg'), 'me15fw033-123.jpg');
  assert.equal(extractFilenameFromUploadUrl('uploads/0f14d7984485.png'), '0f14d7984485.png');
  assert.equal(
    extractFilenameFromUploadUrl('https://marius.oss-cn-shanghai.aliyuncs.com/trays/uploads/1e25781730f5.jpg'),
    '1e25781730f5.jpg'
  );
  assert.equal(
    extractFilenameFromUploadUrl('https://custom-cdn.com/trays/uploads/a0b81d7f744a.webp?x-oss-process=style/preview'),
    'a0b81d7f744a.webp'
  );
  assert.equal(extractFilenameFromUploadUrl('776bf02a6210.jpg'), '776bf02a6210.jpg');

  // Official catalog images or random external URLs should return null
  assert.equal(extractFilenameFromUploadUrl('https://img.guanmai.com/products/original/12345.jpg'), null);
  assert.equal(extractFilenameFromUploadUrl(''), null);
  assert.equal(extractFilenameFromUploadUrl(null), null);
});

test('trays-store: extractReferencedImageFilenames collects all user images across sections and looks', () => {
  const dummyTrays = [
    {
      id: 't-1',
      name: '货盘1',
      sections: [
        {
          id: 's-1',
          looks: [
            {
              id: 'l-1',
              pids: ['me15fw014', 'me15fw015'],
              cover: 'me15fw014',
              userImg: 'https://marius.oss-cn-shanghai.aliyuncs.com/trays/uploads/1e25781730f5.jpg',
              userImgs: {
                me15fw014: 'https://marius.oss-cn-shanghai.aliyuncs.com/trays/uploads/1e25781730f5.jpg',
                me15fw015: '/uploads/me15fw015_cover.png',
              },
            },
            {
              id: 'l-2',
              pids: ['me27fw005'],
              cover: 'me27fw005',
              // no userImg
            },
          ],
        },
      ],
    },
    {
      id: 't-2',
      name: '货盘2',
      sections: [
        {
          id: 's-2',
          looks: [
            {
              id: 'l-3',
              pids: ['me14fw046'],
              cover: 'me14fw046',
              userImg: '/uploads/776bf02a6210.jpg?v=1',
            },
          ],
        },
      ],
    },
  ];

  const referenced = extractReferencedImageFilenames(dummyTrays);
  assert.ok(referenced instanceof Set);
  assert.equal(referenced.size, 3);
  assert.ok(referenced.has('1e25781730f5.jpg'));
  assert.ok(referenced.has('me15fw015_cover.png'));
  assert.ok(referenced.has('776bf02a6210.jpg'));
  assert.ok(!referenced.has('unrelated.jpg'));
});

test('oss-client: deleteOssObject exported and handles null or empty input safely', async () => {
  assert.equal(typeof deleteOssObject, 'function');
  const resEmpty = await deleteOssObject('');
  assert.equal(resEmpty, false);
  const resNull = await deleteOssObject(null);
  assert.equal(resNull, false);
});
