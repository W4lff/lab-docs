# lab-docs

Documentação didática do lab HashiCorp: uma página por ferramenta usada
no cluster (Terraform, Ansible, Consul, Nomad, Vault, Traefik, Keycloak,
GitHub Actions, registry de imagens (Harbor→ghcr.io), Cloudflare, stack
de monitoramento, APISIX), sempre com "como está configurado neste lab"
**e** "como fazer manualmente" — pra nunca depender só da automação sem
entender o que ela faz por baixo.

Também serve como demonstração de aplicação real instrumentada com toda
a stack de observabilidade: métricas (`prom-client`), traces
(OpenTelemetry → Tempo, com `trace_id`/`span_id` injetados nos logs pra
correlação log↔trace no Grafana) e segredo vindo do Vault via workload
identity (mesmo padrão de loja/blog/tasks-app).

## Estrutura

- `content/*.md` — o conteúdo em si, um arquivo por tópico, com
  front-matter (`title`, `order`) lido pelo backend.
- `src/index.js` — Express: lista/renderiza páginas (markdown → HTML via
  `marked`), busca full-text simples, `/metrics` (Prometheus),
  `/api/vault-greeting` (segredo do Vault).
- `src/tracing.js` — OpenTelemetry, carregado via `node -r ./src/tracing.js`.
- `src/log.js` — logs estruturados em JSON com `trace_id`/`span_id` do
  span ativo.
- `site/` — front-end estático (sidebar, busca, renderização de
  diagramas Mermaid no navegador).
- `lab-docs.nomad.hcl` — `count = 2`, `distinct_hosts`, porta `8090`,
  roteado em `docs.lab.evalabs.com.br` (sem SSO — documentação é
  pública dentro do lab).
- `.github/workflows/deploy.yml` — dois jobs: `build` (runner hospedado
  pelo GitHub, push pro ghcr.io) e `deploy` (runner self-hosted, único
  que alcança a rede privada do Nomad).
