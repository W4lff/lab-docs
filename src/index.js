const express = require("express");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const client = require("prom-client");
const { log } = require("./log");

const PORT = process.env.PORT || 8090;
const CONTENT_DIR = path.join(__dirname, "..", "content");
const SITE_DIR = path.join(__dirname, "..", "site");

client.collectDefaultMetrics();

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duração das requisições HTTP",
  labelNames: ["method", "route", "status"],
});
const pageViews = new client.Counter({
  name: "lab_docs_page_views_total",
  help: "Visualizações de página por slug",
  labelNames: ["slug"],
});
const searchQueries = new client.Counter({
  name: "lab_docs_search_queries_total",
  help: "Buscas realizadas no conteúdo",
});
const searchDuration = new client.Histogram({
  name: "lab_docs_search_duration_seconds",
  help: "Duração de cada busca no conteúdo",
});

function loadDocs() {
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(CONTENT_DIR, file), "utf-8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let title = file;
      let order = 999;
      let body = raw;
      if (fm) {
        body = fm[2];
        const titleMatch = fm[1].match(/title:\s*(.+)/);
        const orderMatch = fm[1].match(/order:\s*(\d+)/);
        if (titleMatch) title = titleMatch[1].trim();
        if (orderMatch) order = parseInt(orderMatch[1], 10);
      }
      const slug = file.replace(/^\d+-/, "").replace(/\.md$/, "");
      return { slug, title, order, body };
    })
    .sort((a, b) => a.order - b.order);
}

const docs = loadDocs();
log(`conteúdo carregado: ${docs.length} páginas`);

const app = express();

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.path, status: res.statusCode });
    log("request completed", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
    });
  });
  next();
});

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

// Segredo vindo do Vault (workload identity), renderizado pelo Nomad em
// /local/vault-data.json — mesmo padrão demonstrado em loja/blog.
app.get("/api/vault-greeting", (_req, res) => {
  try {
    const data = fs.readFileSync("/local/vault-data.json", "utf-8");
    res.type("application/json").send(data);
  } catch (err) {
    res.status(503).json({ error: "segredo ainda não renderizado" });
  }
});

app.get("/api/docs", (_req, res) => {
  res.json(docs.map(({ slug, title, order }) => ({ slug, title, order })));
});

app.get("/api/docs/:slug", (req, res) => {
  const doc = docs.find((d) => d.slug === req.params.slug);
  if (!doc) return res.status(404).json({ error: "não encontrado" });
  pageViews.inc({ slug: doc.slug });
  log("page view", { slug: doc.slug });
  res.json({ slug: doc.slug, title: doc.title, html: marked.parse(doc.body) });
});

app.get("/api/search", (req, res) => {
  const end = searchDuration.startTimer();
  searchQueries.inc();
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) {
    end();
    return res.json([]);
  }
  const results = [];
  for (const doc of docs) {
    const lower = doc.body.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const snippet = doc.body.slice(start, idx + 100).replace(/\s+/g, " ");
      results.push({ slug: doc.slug, title: doc.title, snippet: `…${snippet}…` });
    }
  }
  end();
  log("search", { query: q, results: results.length });
  res.json(results);
});

app.use(express.static(SITE_DIR));

app.listen(PORT, () => log(`lab-docs ouvindo na porta ${PORT}`));
