import test from 'node:test';
import assert from 'node:assert/strict';

import { httpStatus } from '../server.mjs';

// Codes for a named thing that does not exist must map to 404.
const NOT_FOUND = [
  'PROJECT_NOT_FOUND',
  'REVISION_NOT_FOUND',
  'STYLE_NOT_FOUND',
  'EXPORT_NOT_FOUND',
  'SECTION_NOT_FOUND',
  'COMMENT_NOT_FOUND',
  'BUILD_NOT_FOUND',
  'BRAND_NOT_FOUND',
  'RECIPE_NOT_FOUND',
  'RUN_NOT_FOUND',
  'UNKNOWN_TOOL',
  // pre-existing 404 codes must keep working
  'JOB_NOT_FOUND',
  'PROCESS_NOT_FOUND',
  'ROUTE_NOT_FOUND',
];

// About a local file path the caller sent in the body — must stay 400.
const STAYS_400 = ['FILE_NOT_FOUND', 'MUSIC_NOT_FOUND', 'LUT_NOT_FOUND'];

test('named-thing-not-found codes give 404', () => {
  for (const code of NOT_FOUND) {
    assert.equal(httpStatus(code), 404, `${code} should be 404`);
  }
});

test('local file path codes stay 400', () => {
  for (const code of STAYS_400) {
    assert.equal(httpStatus(code), 400, `${code} should stay 400`);
  }
});

test('existing non-400 mappings do not change', () => {
  assert.equal(httpStatus('METHOD_NOT_ALLOWED'), 405);
  assert.equal(httpStatus('BODY_TOO_LARGE'), 413);
  assert.equal(httpStatus('CAPTURE_ACTIVE'), 409);
  assert.equal(httpStatus('OUTPUT_EXISTS'), 409);
  assert.equal(httpStatus('REVISION_CONFLICT'), 409);
  assert.equal(httpStatus('ENGINE_BUSY'), 409);
  assert.equal(httpStatus('PROJECT_BUSY'), 409);
});

test('any other code still gives 400', () => {
  assert.equal(httpStatus('SOME_UNKNOWN_CODE'), 400);
});