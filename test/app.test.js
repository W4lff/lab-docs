const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { app } = require("../src/index");

test("GET /healthz retorna status ok", async () => {
  const res = await request(app).get("/healthz");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, "ok");
});

test("GET /api/docs lista as páginas carregadas", async () => {
  const res = await request(app).get("/api/docs");
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  assert.ok(res.body.every((p) => p.slug && p.title));
});

test("GET /api/docs/:slug inexistente retorna 404", async () => {
  const res = await request(app).get("/api/docs/pagina-que-nao-existe");
  assert.strictEqual(res.status, 404);
});

test("GET /api/search sem query retorna lista vazia", async () => {
  const res = await request(app).get("/api/search");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test("GET /api/vault-greeting sem segredo renderizado retorna 503", async () => {
  const res = await request(app).get("/api/vault-greeting");
  assert.strictEqual(res.status, 503);
});
