import test from "node:test";
import assert from "node:assert/strict";
import { projectFileLink } from "../../ui/file-links.ts";

const project = { id: "project", absolutePath: "/home/user/workspace/机翼" };
test("generated links resolve encoded names, line anchors and actual server paths", () => {
  for (const href of ["models/机翼.step", "./models/机翼.step", "models/%E6%9C%BA%E7%BF%BC.step", "/workspace/models/机翼.step", "/home/user/workspace/机翼/models/机翼.step", "file:///home/user/workspace/%E6%9C%BA%E7%BF%BC/models/%E6%9C%BA%E7%BF%BC.step#L12"]) {
    assert.equal(projectFileLink(href, project), "models/机翼.step");
  }
  assert.equal(projectFileLink("models/100%.step", project), "models/100%.step");
  assert.equal(projectFileLink("part%2520name.step", project), "part%20name.step");
});
test("links cannot reinterpret outside paths, traversal, unsupported schemes or empty names", () => {
  for (const href of ["/tmp/file.step", "/home/user/workspace/机翼-other/a.step", "../file.step", "%2E%2E/file.step", "models/%2E%2E/a.step", "file://otherhost/a.step", "javascript:alert(1)", "sandbox:/mnt/data/a.step", "//example/a.step", "a\\b.step", "a%00.step", "", "./"]) {
    assert.throws(() => projectFileLink(href, project), Error, href);
  }
});
