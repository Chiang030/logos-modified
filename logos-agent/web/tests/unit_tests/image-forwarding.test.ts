import test from "node:test";
import assert from "node:assert/strict";
import { latestUserImageCount } from "../../server/broker.ts";

test("inline image guards inspect the latest user turn across provider protocols", () => {
  const url = "data:image/png;base64,fixture";
  for (const [protocol, key, image] of [
    ["openai-completions", "messages", {type:"image_url",image_url:{url}}],
    ["openai-responses", "input", {type:"input_image",image_url:url}],
    ["anthropic-messages", "messages", {type:"image",source:{type:"base64",data:"fixture"}}],
  ] as const) {
    assert.equal(latestUserImageCount({[key]:[{role:"user",content:[image]}]}, protocol), 1);
    assert.equal(latestUserImageCount({[key]:[{role:"user",content:[image,image]}]}, protocol), 2);
    assert.equal(latestUserImageCount({[key]:[{role:"user",content:[image]},{role:"assistant",content:"OK"},{role:"user",content:[{type:"text",text:"Image omitted"}]}]}, protocol), 0);
    assert.equal(latestUserImageCount({[key]:[{role:"user",content:"text only"}]}, protocol), 0);
    assert.equal(latestUserImageCount({[key]:[{role:"user",content:[{type:"image_url"}]}]}, protocol), 0);
  }
});
