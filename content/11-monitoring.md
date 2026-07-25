---
title: Monitoramento — Prometheus, Loki, Tempo, Grafana
order: 11
---

# Stack de monitoramento

Prometheus (métricas), Loki (logs), Tempo (traces) e Grafana (a UI que
junta os três) rodam isolados num node pool dedicado do Nomad
(`monitoring`), pra nunca competir por CPU/disco com as aplicações.
Ver [Nomad](04-nomad) pra entender node pools, e
[Arquitetura](00-arquitetura) pro porquê da VM separada.

## Prometheus

- Scrape estático (sem Consul DNS, IPs privados fixos) de: Consul
  (`/v1/agent/metrics?format=prometheus`), Nomad
  (`/v1/metrics?format=prometheus` — precisa de `telemetry {
  prometheus_metrics = true }` no `.hcl` do Nomad, que **não** vem
  habilitado por padrão), Vault (`/v1/sys/metrics?format=prometheus`),
  Traefik (entrypoint dedicado `:8180`, sem SSO), `node_exporter` (CPU/
  memória/disco de cada VM), e o `/metrics` de cada aplicação
  instrumentada (`tasks-api`, `loja`, `blog` — via
  `nginx-prometheus-exporter`).
- Roda como usuário **root dentro do container**
  (`user = "0:0"` no `task`, não dentro do `config{}` do driver docker —
  erro fácil de cometer) — motivo: volumes Docker nomeados nascem
  `root:root`, e a imagem oficial do Prometheus roda como usuário
  não-root por padrão; sem isso, ele não consegue escrever no próprio
  diretório de dados (`/prometheus`).
- `scrape_interval` global (não configurado explicitamente, então usa o
  padrão do Prometheus): **1 minuto** — importante saber isso ao
  escrever queries `rate(métrica[1m])`, porque com só 1 scrape por
  minuto essa janela raramente tem as 2 amostras necessárias pro
  `rate()` calcular algo; o padrão usado nos dashboards deste lab é
  `[5m]`.
- Exposto publicamente em `prometheus.lab.evalabs.com.br`, atrás do SSO.

## Loki

- Recebe logs só via push do **Promtail** (job `type = "system"`, roda
  em todo client Nomad automaticamente, inclusive o de monitoramento —
  por isso precisa do node pool especial `all`, não `monitoring`).
  Promtail lê containers via `docker_sd_configs` (Docker socket), sem
  precisar trocar o logging driver do Docker em nenhuma VM.
- Sem rota pública própria — só é consultado via Grafana.
- Também roda como root (mesmo motivo do Prometheus).
- **Porta gRPC**: por padrão `9095` — igual à do Tempo. Como todo job
  usa `network_mode = "host"` no mesmo nó, os dois colidiriam; a porta
  do Loki foi movida pra `9096` via flag
  `-server.grpc-listen-port=9096`.

## Tempo

- Recebe traces via **OTLP** (HTTP `:4318` e gRPC `:4317`) de qualquer
  aplicação instrumentada com OpenTelemetry.
- **Bug sutil que já apareceu aqui**: por padrão, os receivers OTLP do
  Tempo escutam só em `127.0.0.1`, inacessíveis de qualquer outra VM —
  precisa declarar `endpoint: 0.0.0.0:4318` / `0.0.0.0:4317`
  explicitamente no config, senão nenhuma aplicação rodando nos workers
  consegue mandar trace nenhum (falha silenciosa: a aplicação não
  trava, só nunca aparece trace nenhum no Tempo).
- **Schema de config muda entre versões majors** — a versão usada aqui
  (v3.0.0) removeu as chaves de topo `ingester` e `compactor` que
  existiam em versões anteriores (a compactação agora é
  `backend_scheduler`/`backend_worker`); um config copiado de exemplos
  antigos falha com `field ingester not found in type app.Config`.
- Sem rota pública — só consultado via Grafana (painel de tipo
  `traces`, usando TraceQL).

## Grafana

- 3 datasources provisionados automaticamente (arquivo `.yaml`, não
  clique manual): Prometheus, Loki, Tempo — todos com `uid` fixo
  (`prometheus`, `loki`, `tempo`) pra dashboards versionados no repo
  poderem referenciar sem depender de UID gerado.
- Datasource do Tempo com `tracesToLogsV2` apontando pro Loki — permite
  ir de um trace direto pros logs daquele mesmo período/serviço.
- Senha do admin vem do **Vault** (`role = "nomad-grafana"`, mesmo
  mecanismo de workload identity usado por qualquer app do lab).
- **Dashboard provisionado como código** (`provider: type: file`,
  arquivo `.json` versionado no repo) — não é import manual pela UI, o
  que significa que sobrevive a qualquer redeploy.

### Bug real: loop de OOM kill com 256MB

O job nasceu com `memory = 256` — parecia suficiente num primeiro
teste, mas o Grafana (imagem `latest`) já usa **~200MB parado**, sem
tráfego nenhum, só com SQLite + todos os feature toggles habilitados
por padrão. Margem quase zero significava que qualquer pico (um
dashboard carregando, uma migration de schema) estourava o limite e o
Nomad matava e reiniciava o container — de novo, e de novo. Sintoma pro
usuário: **"Bad Gateway"** aparecendo no meio de uma sessão (Traefik
sem backend saudável durante o restart) e painéis com **"No data"**
(a query caiu exatamente na janela de reinício). `docker stats` e
`docker inspect --format '{{.RestartCount}}'` confirmaram o loop.
Corrigido subindo pra `memory = 768`.

### Bug real: painel de Traces sempre "No data found in response"

Mesmo com o Tempo saudável e cheio de dados (confirmado consultando a
API dele direto), o painel de Traces do Grafana nunca mostrava nada.
O log do Grafana explicava:

```
grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:3200"}.
Err: ... "error reading server preface: http2: failed reading the frame
payload: http2: frame too large, note that the frame header looked like
an HTTP/1.1 header"
```

O datasource do Tempo, por padrão, tenta abrir uma conexão **gRPC**
direto no Tempo pra fazer streaming search — só que este lab só expõe
a porta HTTP do Tempo (`3200`), sem `grpc_listen_port` configurado no
`server:`. Corrigido desabilitando o streaming no datasource, forçando
a busca via HTTP normal (que já funcionava o tempo todo):

```yaml
jsonData:
  streamingEnabled:
    search: false
```

## O que uma aplicação precisa fazer pra aparecer na stack

1. **Métricas**: expor `/metrics` (formato Prometheus — no Node.js,
   biblioteca `prom-client`) e adicionar um `job_name` no
   `prometheus.yml` do repo `monitoring-stack` apontando pro IP:porta
   dela.
2. **Logs**: nada a fazer — o Promtail já lê o `stdout`/`stderr` de
   **todo** container via Docker socket automaticamente. Só vale a pena
   logar em JSON estruturado se quiser correlacionar com traces (ver
   abaixo).
3. **Traces**: instrumentar com OpenTelemetry (no Node.js, o pacote
   `@opentelemetry/auto-instrumentations-node` cobre HTTP/Express/pg
   sem precisar tocar no código da aplicação — só um arquivo
   `tracing.js` carregado via `node -r ./tracing.js index.js`), e
   configurar `OTEL_EXPORTER_OTLP_ENDPOINT=http://10.20.4.10:4318`
   (IP fixo da VM de monitoramento) no job Nomad.

## Fazendo manualmente

Rodar Prometheus com um scrape config mínimo:

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: minha-app
    static_configs:
      - targets: ["10.20.2.10:3000"]
```

```bash
prometheus --config.file=prometheus.yml --storage.tsdb.path=/tmp/prom-data
# UI em http://localhost:9090, testar em /targets se o scrape está "up"
```

Consultar uma métrica direto pela API HTTP (sem abrir a UI):

```bash
curl -s "http://localhost:9090/api/v1/query?query=up" | jq
```

Rodar Loki + Promtail localmente, mandando log de um arquivo:

```bash
loki -config.file=loki-local-config.yaml &
# promtail-config.yaml aponta scrape_configs pro arquivo de log
promtail -config.file=promtail-config.yaml
```

```bash
curl -G "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={job="minha-app"}'
```

Rodar Tempo e mandar um trace manualmente via OTLP/HTTP (sem nenhuma
aplicação real, só pra ver o pipeline funcionar):

```bash
tempo -config.file=tempo.yaml &

curl -X POST http://localhost:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[]}'   # payload vazio só testa se o endpoint aceita
```

```bash
curl -s "http://localhost:3200/api/search?tags=service.name%3Dminha-app"
```

Instrumentar manualmente uma aplicação Node com OpenTelemetry, sem
depender de nenhum framework de auto-config:

```js
// tracing.js
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");

new NodeSDK({
  traceExporter: new OTLPTraceExporter(), // lê OTEL_EXPORTER_OTLP_ENDPOINT do ambiente
  instrumentations: [getNodeAutoInstrumentations()],
}).start();
```

```bash
OTEL_SERVICE_NAME=minha-app \
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.20.4.10:4318 \
node -r ./tracing.js index.js
```
