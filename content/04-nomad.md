---
title: Nomad
order: 4
---

# Nomad

Nomad é o orquestrador — o "Kubernetes" deste lab. É ele quem decide em
qual VM cada container roda, reagenda se um cair, e escala réplicas.

## Como está neste lab

- 3 servers (`control_plane`), `bootstrap_expect = 3`.
- Clients: workers (pool `default`, implícito) + monitoring (pool
  `monitoring`, explícito).
- **Node pools** — o mecanismo real de isolamento usado aqui:
  ```hcl
  # nomad-client.hcl, só na VM de monitoramento
  client {
    enabled   = true
    node_pool = "monitoring"
  }
  ```
  Um job que declara `node_pool = "monitoring"` só agenda nesse nó. Jobs
  que **não** declaram `node_pool` (todas as aplicações: loja, blog,
  tasks-app) ficam implicitamente presos ao pool `default` — nunca
  competem por recurso com Prometheus/Loki/Tempo/Grafana, e vice-versa.
  Existe ainda um pool especial, `all`, que cobre todo client
  independente do pool — usado pelos jobs `type = "system"` (Promtail,
  node-exporter) que precisam rodar em **todo** nó, incluindo o de
  monitoramento.

  > Por que não usar `constraint` em vez de `node_pool`? Um `constraint`
  > só *direciona* um job pra determinado nó — não impede que outros
  > jobs (sem esse constraint) também caiam lá. Só `node_pool` garante
  > isolamento nas duas direções.

- **Autenticação com Vault via workload identity** — o mecanismo real
  usado neste Nomad (2.0.4), não o método "clássico" com token
  compartilhado:
  ```hcl
  # nomad-server.hcl
  vault {
    enabled          = true
    address          = "http://127.0.0.1:8200"
    create_from_role = "nomad-cluster"
    token            = "<token clássico — ainda exigido pra habilitar a feature>"
    default_identity {
      aud = ["vault.io"]
      ttl = "1h"
    }
  }
  ```
  Na prática: cada **task** que declara um bloco `vault { role = "..." }`
  recebe do próprio Nomad um JWT assinado (workload identity), e é esse
  JWT — não o token clássico do server — que o Vault valida (via um auth
  method JWT, path fixo `jwt-nomad`; ver [Vault](05-vault)) pra decidir
  quais secrets aquela task específica pode ler.
- Jobs usam `network_mode = "host"` (não a rede em bridge/CNI padrão do
  Nomad) — escolha deliberada pra não precisar instalar plugins CNI;
  como consequência, toda porta usada por container vira uma porta
  "real" ocupada na VM, e por isso cada app precisa de uma porta própria
  sem colisão (documentado app a app em [Camada de
  aplicações](12-apps)).
- `constraint { distinct_hosts = true }` é o padrão em todo job com
  `count > 1` — garante 1 réplica por worker (alta disponibilidade real,
  não 2 réplicas acidentalmente no mesmo host).

## Fazendo manualmente

Rodar o Nomad em modo dev (sem cluster, só pra testar um job):

```bash
sudo nomad agent -dev
```

Validar e subir um job (o comando que o GitHub Actions roda em CI):

```bash
nomad job validate meu-job.nomad.hcl
nomad job run meu-job.nomad.hcl
nomad job status meu-job
nomad alloc logs <alloc-id>
nomad alloc logs -stderr <alloc-id>
```

Um job mínimo, de propósito:

```hcl
job "hello" {
  datacenters = ["dc1"]
  group "hello" {
    task "hello" {
      driver = "docker"
      config {
        image        = "nginx:alpine"
        network_mode = "host"
      }
      service {
        name = "hello"
        port = "80"
      }
    }
  }
}
```

Criar um node pool e ver quem está nele (o que o Ansible faz declarando
`node_pool` no `client{}` — não existe comando manual separado, o pool é
criado implicitamente na primeira vez que aparece em algum client ou
job):

```bash
nomad node pool list
nomad node status         # mostra a coluna "Node Pool" de cada client
```

Forçar um job pra um node pool específico:

```hcl
job "meu-job" {
  node_pool = "monitoring"
  # ...
}
```

Debugar por que um job não agenda em lugar nenhum (o comando mais usado
neste lab pra descobrir problemas de constraint/recursos/node pool):

```bash
nomad job status meu-job     # olhar a seção "Placement Failure"
```
