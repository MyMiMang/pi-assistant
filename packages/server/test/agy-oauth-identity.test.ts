import assert from "node:assert/strict";
import { test } from "node:test";
import { googleAgyIdentity } from "../src/cli-agents/agy-oauth-identity.ts";

test("refresh and verified provider identity are separate, with no redirected requests", async () => {
 const urls: string[] = [];
 const mock: typeof fetch = async (input, init) => {
  urls.push(String(input));
  assert.equal(init?.redirect, "error");
  if (urls.length === 1) {
   const form = init?.body as URLSearchParams;
   assert.equal(form.get("grant_type"), "refresh_token");
   assert.equal(form.get("client_id"), "authorized-fixture-client");
   return Response.json({access_token:"synthetic-access",token_type:"Bearer"});
  }
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-access");
  return Response.json({sub:"B",email:"b@fixture.test",email_verified:true});
 };
 assert.deepEqual(await googleAgyIdentity({id:"authorized-fixture-client"},mock)("synthetic-material",AbortSignal.timeout(1000)),{subject:"B",email:"b@fixture.test"});
 assert.deepEqual(urls,["https://oauth2.googleapis.com/token","https://openidconnect.googleapis.com/v1/userinfo"]);
});

test("invalid grant never reaches identity endpoint; unauthorized client is not treated as an invalid account", async () => {
 let calls=0;
 const verify = (error:string) => googleAgyIdentity({id:"fixture"},async () => {calls++; return Response.json({error},{status:400});});
 const signal=AbortSignal.timeout(1000);
 assert.equal(await verify("invalid_grant")("synthetic-material",signal),null);
 assert.equal(calls,1);
 await assert.rejects(verify("invalid_client")("synthetic-material",signal),/oauth_refresh_unavailable/);
 assert.equal(calls,2);
});
