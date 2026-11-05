import { test } from "node:test";
import assert from "node:assert/strict";
import { createDataUriMask, maskDataUris, unmaskDataUris } from "./dataUris";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

test("masking hides every data URI and unmasking puts each back where the rewrite left it", () => {
  const mask = createDataUriMask();
  const text = `![a](${PNG}) and [ref]: <${GIF}> and src="${PNG}"`;
  const masked = maskDataUris(mask, text);
  assert.doesNotMatch(masked, /data:/);
  assert.equal(mask.map.size, 3);
  assert.deepEqual(unmaskDataUris(mask, masked.replace(" and ", " plus ")), { ok: true, text: text.replace(" and ", " plus ") });
});

test("a sentinel the rewrite dropped is fine", () => {
  const mask = createDataUriMask();
  maskDataUris(mask, `![a](${PNG})`);
  assert.deepEqual(unmaskDataUris(mask, "No image now."), { ok: true, text: "No image now." });
});

test("unmasking fails closed on a repeated, foreign or torn sentinel", () => {
  const mask = createDataUriMask();
  const masked = maskDataUris(mask, `![a](${PNG})`);
  const token = [...mask.map.keys()][0];
  assert.equal(unmaskDataUris(mask, masked + masked).ok, false);
  const other = createDataUriMask();
  maskDataUris(other, `![b](${GIF})`);
  assert.equal(unmaskDataUris(mask, [...other.map.keys()][0]).ok, false);
  assert.equal(unmaskDataUris(mask, token.slice(0, -1)).ok, false);
});

test("each mask gets its own nonce", () => {
  assert.notEqual(createDataUriMask().nonce, createDataUriMask().nonce);
  assert.match(createDataUriMask().nonce, /^[0-9a-f]{8}$/);
});
