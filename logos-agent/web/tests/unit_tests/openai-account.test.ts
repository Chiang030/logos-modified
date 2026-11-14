import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/store.ts";
import { Models } from "../../server/models.ts";
import { OpenAiAccount, type OpenAiDriver } from "../../server/openai-account.ts";
import type { OAuthCredential } from "../../../vscode-extension/src/auth/oauthCredential.ts";

test("administrator OAuth is owner-bound, encrypted, persistent, and confined to the official endpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-openai-"));
  const store = new Store(join(root,"db.sqlite")), models = new Models(store,root);
  const credential: OAuthCredential = {type:"oauth",access:"private-access-fixture",refresh:"private-refresh-fixture",clientId:"fixture-client",scopes:["chatgpt.tokens.use.direct"],expires:Date.now()+60_000};
  const driver: OpenAiDriver = {
    async loginOpenAiChatGPT(_device,interaction) {
      interaction.notify({type:"url",url:"https://auth.openai.com/authorize?state=fixture-state"});
      await interaction.manualCallbackUrl(); return credential;
    },
    async refreshOpenAiCredential(value) {return value;},
    authorizationResultFromManualInput(input,state,redirect) {
      const url=new URL(input);if(url.origin!==redirect.origin||url.pathname!==redirect.pathname||url.searchParams.get("state")!==state)throw new Error("Invalid state");
    },
  };
  const account = new OpenAiAccount(models,async()=>driver);
  t.after(async()=>{account.logout();store.close();await rm(root,{recursive:true,force:true});});
  const attempt = await account.begin("admin-a") as {id:string};
  assert.throws(()=>account.progress("admin-b",attempt.id),/不存在/);
  await assert.rejects(account.complete("admin-a",attempt.id,"http://127.0.0.1:1455/auth/callback?state=wrong"),/回调地址无效/);
  const complete=await account.complete("admin-a",attempt.id,"http://127.0.0.1:1455/auth/callback?state=fixture-state") as {connected:boolean};
  assert.equal(complete.connected,true);
  assert.equal(await account.accessToken(),credential.access);
  const stored=JSON.stringify(store.db.prepare("SELECT * FROM openai_account").all());
  assert.ok(!stored.includes(credential.access)&&!stored.includes(credential.refresh));
  const input={name:"ChatGPT",baseUrl:"https://api.openai.com/v1",protocol:"openai-responses",authType:"openai-chatgpt",models:["fixture-model"]};
  assert.throws(()=>models.save({...input,baseUrl:"https://elsewhere.invalid/v1"}),/官方 Responses/);
  assert.throws(()=>models.save({...input,apiKey:"replacement"}),/无需填写/);
  const connection=models.save(input);assert.equal(connection.hasKey,true);
  assert.ok(!JSON.stringify(models.list()).includes(credential.access));
  const reopened=new Store(join(root,"db.sqlite"));
  try {const restored=new Models(reopened,root);assert.equal(await restored.accessToken(connection.id),credential.access);}
  finally {reopened.close();}
  account.logout();assert.equal(models.get(connection.id).hasKey,false);
  await assert.rejects(models.accessToken(connection.id),/尚未登录/);
});

test("token rotation is serialized across service instances and logout cannot be undone by an in-flight refresh", async t => {
  const root=await mkdtemp(join(tmpdir(),"logos-refresh-"));
  const first=new Store(join(root,"db.sqlite")),second=new Store(join(root,"db.sqlite"));
  const a=new Models(first,root),b=new Models(second,root);
  let refreshes=0, release:(value:OAuthCredential)=>void=()=>{},started:()=>void=()=>{};
  let ready=new Promise<void>(resolve=>{started=resolve;});
  const expired:OAuthCredential={type:"oauth",access:"old-access",refresh:"rotating-refresh",clientId:"client",scopes:["chatgpt.tokens.use.direct"],expires:Date.now()-1};
  const renewed={...expired,access:"new-access",refresh:"new-refresh",expires:Date.now()+60_000};
  const driver:OpenAiDriver={
    async loginOpenAiChatGPT(_device,interaction){interaction.notify({type:"url",url:"https://auth.openai.com/authorize?state=fixture"});await interaction.manualCallbackUrl();return expired;},
    async refreshOpenAiCredential(){refreshes++;started();return await new Promise<OAuthCredential>(resolve=>{release=resolve;});},
    authorizationResultFromManualInput(){return {};},
  };
  const one=new OpenAiAccount(a,async()=>driver),two=new OpenAiAccount(b,async()=>driver);
  t.after(async()=>{one.logout();two.logout();first.close();second.close();await rm(root,{recursive:true,force:true});});
  const login=async()=>{const p=await one.begin("admin") as {id:string};await one.complete("admin",p.id,"http://127.0.0.1:1455/auth/callback?state=fixture");};
  await login();
  const pending=[one.accessToken(),two.accessToken(),one.accessToken()];
  await ready;release(renewed);
  assert.deepEqual(await Promise.all(pending),[renewed.access,renewed.access,renewed.access]);assert.equal(refreshes,1);
  ready=new Promise<void>(resolve=>{started=resolve;});
  await login();
  const refreshing=one.accessToken();const rejected=assert.rejects(refreshing,/尚未登录/);
  await ready;two.logout();release(renewed);await rejected;
  assert.equal(one.status().connected,false);assert.equal(two.status().connected,false);
});


test("model discovery accepts API IDs and ChatGPT subscription slugs while retaining the supported chat allowlist", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-openai-models-"));
  const store = new Store(join(root, "db.sqlite")), models = new Models(store, root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  t.mock.method(models.openAi, "accessToken", async () => "model-list-fixture-token");
  let payload: unknown;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer model-list-fixture-token");
    return Response.json(payload);
  });
  const cases = [
    { name: "API model IDs", body: { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }] }, expected: ["gpt-6.1-sol", "gpt-6-astra"] },
    { name: "subscription model slugs", body: { models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-astra" }, { slug: "codex-auto-review" }] }, expected: ["gpt-6.1-sol", "gpt-6-astra"] },
    { name: "mixed formats and duplicate models", body: { data: [{ id: "gpt-6.1-sol" }], models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-astra" }] }, expected: ["gpt-6.1-sol", "gpt-6-astra"] },
    { name: "unknown and malformed model records", body: { models: [null, {}, { slug: 42 }, { slug: "unsupported-model-fixture" }, { slug: "gpt-6.1-sol" }] }, expected: ["gpt-6.1-sol"] },
    { name: "empty model list", body: { models: [] }, expected: [] },
    { name: "non-array fields", body: { data: {}, models: "invalid" }, expected: [] },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      payload = entry.body;
      assert.deepEqual(await models.openAi.listModels(), entry.expected);
    });
  }
});
