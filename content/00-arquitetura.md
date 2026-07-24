---
title: Arquitetura do cluster
order: 0
---

# Arquitetura do lab HashiCorp

Este laboratório roda inteiramente na Azure (East US 2), numa única VNet
`10.20.0.0/16` dividida em 3 sub-redes, uma por "papel" (uma quarta,
`registry` — 10.20.3.0/24, o Harbor — existiu e foi desligada; ver
[Registry de imagens](09-harbor) pra essa história):

| Sub-rede       | CIDR          | O que roda lá |
|----------------|---------------|----------------|
| `control_plane`| 10.20.1.0/24  | Consul+Nomad+Vault (servers), Keycloak, Postgres do Keycloak |
| `data_plane`   | 10.20.2.0/24  | Consul+Nomad (clients), Traefik, forward-auth, APISIX+etcd, aplicações (loja, blog, tasks-app) |
| `monitoring`   | 10.20.4.0/24  | Prometheus, Loki, Tempo, Grafana, Promtail, node-exporter |

Imagens Docker construídas neste lab (loja, blog, tasks-api,
tasks-front, lab-docs) vêm do **GitHub Container Registry (ghcr.io)** —
não existe mais registry próprio dentro da VNet.

```mermaid
flowchart TB
    subgraph Internet
        User[Usuário / navegador]
        CF[Cloudflare DNS<br/>*.lab.evalabs.com.br<br/>modo DNS-only]
        GHCR[ghcr.io<br/>imagens Docker do lab]
    end

    subgraph Azure["Azure — VNet 10.20.0.0/16"]
        LB[Standard Load Balancer<br/>IP público único]

        subgraph CP["control_plane — 10.20.1.0/24"]
            C1[vm-control-01<br/>Consul+Nomad+Vault server]
            C2[vm-control-02<br/>Consul+Nomad+Vault server]
            C3[vm-control-03<br/>Consul+Nomad+Vault server]
        end

        subgraph DP["data_plane — 10.20.2.0/24"]
            W1[vm-worker-01<br/>Traefik, forward-auth,<br/>Keycloak, APISIX+etcd, apps]
            W2[vm-worker-02<br/>Traefik, APISIX, apps]
        end

        subgraph MON["monitoring — 10.20.4.0/24<br/>node pool dedicado do Nomad"]
            M1[vm-monitoring-01<br/>Prometheus, Loki, Tempo, Grafana]
        end
    end

    User -->|DNS resolve| CF
    CF -.->|aponta pro IP da LB| User
    User -->|HTTP Host: app.lab...| LB
    LB --> W1
    LB --> W2
    W1 <-.->|Consul catalog<br/>service discovery| C1
    W2 <-.-> C1
    W1 -->|pull imagens<br/>docker login com PAT read:packages| GHCR
    W2 -->|pull imagens| GHCR
    W1 -.->|workload identity JWT| C1
    C1 -.->|valida via Vault| C1
    DP -->|Promtail push logs<br/>OTLP traces| M1
    CP -->|Prometheus scrape<br/>métricas nativas| M1
    DP -->|Prometheus scrape| M1
```

A rota do `tasks-api` especificamente passa por uma peça a mais — um
API Gateway (APISIX) fazendo rate limiting antes do backend real:

```mermaid
flowchart LR
    U[Usuário] --> T[Traefik<br/>Host+PathPrefix /api]
    T --> A[APISIX<br/>rate limit 20req/60s]
    A -->|descoberta via DNS do Consul<br/>tasks-api.service.consul| API[tasks-api]
```

Ver [APISIX](13-apisix) pro porquê dessa peça existir e os bugs reais
que apareceram montando essa descoberta.

## Por que essa divisão

- **Control plane isolado dos workers**: os servers de Consul/Nomad/Vault
  não rodam aplicações — só coordenam o cluster. Se um worker cair ou ficar
  sobrecarregado, o cérebro do cluster continua saudável.
- **Registry fora da VNet por completo**: chegou a existir uma VM
  própria (Harbor) só pra isso — foi desligada depois de migrar pro
  ghcr.io, que resolve o mesmo problema (guardar imagem) sem exigir
  manter mais uma peça de infra de pé. Ver [Registry de
  imagens](09-harbor) pra essa migração completa, incluindo um
  vazamento de senha real que apareceu no meio do caminho.
- **Monitoring isolado por node pool do Nomad** (não uma VM solta
  "invisível" pro Nomad): Prometheus/Loki ingerem dado o tempo todo — se
  dividissem host com as aplicações, competiriam por CPU/disco com elas.
  Um *node pool* dedicado (`monitoring`) garante isolamento de verdade:
  jobs desse pool só agendam nesse nó, e as aplicações (que não declaram
  `node_pool`, ficando implícitas no pool `default`) nunca são agendadas
  lá. Veja [Nomad](04-nomad) pra entender node pools.

## Fluxo de uma requisição

1. Usuário acessa `https://algumacoisa.lab.evalabs.com.br`.
2. DNS (Cloudflare, registro wildcard `*.lab`, modo **DNS only** — sem
   proxy/CDN da Cloudflare no meio) resolve direto pro IP público do
   **Load Balancer** da Azure.
3. A LB distribui entre os 2 workers (health probe TCP na porta 80).
4. **Traefik**, rodando em cada worker, recebe a requisição, olha o
   `Host` header, e decide pra qual serviço rotear — a lista de rotas vem
   dinamicamente do **Consul catalog** (provider `consulcatalog`), não de
   arquivo estático. Uma rota específica (`tasks.lab.../api/*`) passa
   primeiro pelo **APISIX** (rate limiting) antes de chegar no backend
   real — ver [APISIX](13-apisix).
5. Se a rota exige SSO (Vault UI, Portainer, Grafana, Nomad UI, o próprio
   dashboard do Traefik), o middleware `forward-auth` intercepta antes e
   redireciona pro **Keycloak** se não houver sessão válida.
6. O serviço final (rodando como job Nomad) responde. Se ele precisa de
   segredo (senha de banco, chave de API), ele nunca tem a senha em texto
   — um `template` no job Nomad busca o valor do **Vault** em tempo de
   execução, autenticado via **workload identity** (um JWT assinado pelo
   próprio Nomad).
7. Em paralelo, **Promtail** (rodando em todo client Nomad) está lendo os
   logs de todo container via Docker socket e empurrando pro **Loki**; se
   a aplicação está instrumentada com OpenTelemetry, ela manda traces
   direto pro **Tempo**; o **Prometheus** faz scrape de métricas
   (Consul/Nomad/Vault/Traefik nativas + `/metrics` de cada app) a cada 1
   minuto.

## Como as peças se conectam (dependência)

```mermaid
flowchart LR
    Terraform -->|provisiona VMs, rede, NSGs| Azure
    Terraform -->|dispara| Ansible
    Ansible -->|instala e configura| Consul
    Ansible -->|instala e configura| Nomad
    Ansible -->|instala e configura| Vault
    Nomad -->|descobre serviços via| Consul
    Nomad -->|autentica tasks via workload identity em| Vault
    Traefik -->|lê rotas dinâmicas de| Consul
    APISIX -->|descoberta via DNS| Consul
    Traefik -->|rota /api| APISIX
    APISIX -->|rate limit + forward| Apps
    GHAhosted[GitHub Actions<br/>runner hospedado] -->|docker build+push| GHCR[ghcr.io]
    GHAself[GitHub Actions<br/>runner self-hosted] -->|nomad job run| Nomad
    Nomad -->|pull image de<br/>docker login via Ansible| GHCR
    Apps -->|buscam segredo via template Nomad em| Vault
    Apps -->|registram-se em| Consul
    Prometheus -->|scrape| Consul
    Prometheus -->|scrape| Nomad
    Prometheus -->|scrape| Vault
    Prometheus -->|scrape| Traefik
    Prometheus -->|scrape| Apps
    Apps -.->|traces OTLP| Tempo
    Promtail -.->|logs| Loki
    Grafana -->|consulta| Prometheus
    Grafana -->|consulta| Loki
    Grafana -->|consulta| Tempo
```

Cada peça tem sua própria página nesta documentação, com o que ela faz
neste lab especificamente e **como fazer a mesma coisa manualmente**
(sem Terraform/Ansible/CI), pra nunca depender só da automação sem
entender o que ela faz por baixo.
