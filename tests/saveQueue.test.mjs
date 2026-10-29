import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

globalThis.window = { setTimeout, clearTimeout };
const source = readFileSync(new URL("../src/lib/saveQueue.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
}).outputText;
const { NoteSaveQueue } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("flush saves a pending edit before the debounce timer", async () => {
  const saved = [];
  const queue = new NoteSaveQueue(async (value) => { saved.push(value); });
  queue.schedule("latest edit", 10000);
  await queue.flush();
  assert.deepEqual(saved, ["latest edit"]);
});

test("an older in-flight save cannot overwrite a newer edit", async () => {
  const saved = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = new NoteSaveQueue(async (value) => {
    if (value === "first") await firstGate;
    saved.push(value);
  });
  queue.schedule("first", 10000);
  const first = queue.flush();
  queue.schedule("second", 10000);
  const second = queue.flush();
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(saved, ["first", "second"]);
});

test("a failed save stays pending and can be retried", async () => {
  let attempts = 0;
  const saved = [];
  const queue = new NoteSaveQueue(async (value) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary database error");
    saved.push(value);
  });
  queue.schedule("kept edit", 10000);
  await assert.rejects(queue.flush(), /temporary database error/);
  await queue.flush();
  assert.deepEqual(saved, ["kept edit"]);
});

test("a failed older save is not restored after a newer save", async () => {
  const saved = [];
  const queue = new NoteSaveQueue(async (value) => {
    if (value === "old") throw new Error("old save failed");
    saved.push(value);
  });
  queue.schedule("old", 10000);
  const old = queue.flush();
  queue.schedule("new", 10000);
  const newest = queue.flush();
  await assert.rejects(old, /old save failed/);
  await newest;
  await queue.flush();
  assert.deepEqual(saved, ["new"]);
});
