---
title: Camada de aplicações
order: 12
---

# Como uma aplicação deste lab é montada

Toda aplicação do lab (loja, blog, tasks-app, e esta própria
documentação) segue o mesmo padrão de repositório e o mesmo conjunto de
integrações — depois de entender uma, as outras são variação do mesmo
molde.

## O molde

1. **Repositório próprio no GitHub**, um por aplicação (não um monorepo)
   — cada um com seu próprio runner self-hosted (ver [GitHub
   Actions](08-github-actions)).
2. **Um `Dockerfile`** por serviço da aplicação (algumas têm só 1
   serviço — ex: `loja`, um site estático; outras têm vários — ex:
   `tasks-app`: front + API + banco).
3. **Um `.nomad.hcl` por serviço**, com o padrão:
   - `network_mode = "host"` (ver [Nomad](04-nomad) pro porquê).
   - `count = 2` + `constraint { distinct_hosts = true }` pra serviços
     stateless (uma réplica por worker).
   - `count = 1`, sem `distinct_hosts`, pra serviços com estado (banco de
     dados) — não faz sentido nem é seguro escalar um Postgres sozinho
     assim.
   - Bloco `vault { role = "nomad-<nome-do-job>" }` sempre que a
     aplicação precisa de algum segredo — nunca senha em texto no job
     nem no código.
   - Bloco `service {}` com as tags `traefik.*` que decidem o roteamento
     (ver [Traefik](06-traefik)).
4. **Pipeline `.github/workflows/deploy.yml`**: builda a(s) imagem(ns),
   dá push pro Harbor (ou pula essa etapa se a imagem for pública), roda
   `nomad job run` de cada `.nomad.hcl`.

## Exemplo comentado (o padrão do `tasks-api`)

```hcl
job "tasks-api" {
  datacenters = ["dc1"]
  group "tasks-api" {
    count = 2
    constraint { distinct_hosts = true }

    task "api" {
      driver = "docker"
      config {
        image        = "registry.lab.evalabs.com.br/library/tasks-api:${var.image_tag}"
        network_mode = "host"
      }

      # Autenticação Vault via workload identity — ver Vault e Nomad
      vault { role = "nomad-tasks-api" }

      # Descoberta do banco via Consul (pode estar em qualquer worker) +
      # segredo do Vault, no mesmo template
      template {
        data = <<-EOF
          {{ range service "tasks-db" }}
          PGHOST={{ .Address }}
          PGPORT={{ .Port }}
          {{ end }}
          {{ with secret "secret/data/tasks" }}
          PGPASSWORD={{ .Data.data.db_password }}
          {{ end }}
        EOF
        destination = "secrets/api.env"
        env         = true
      }

      service {
        name = "tasks-api"
        tags = [
          "traefik.enable=true",
          "traefik.http.routers.tasks-api.rule=Host(`tasks.lab.evalabs.com.br`) && PathPrefix(`/api`)",
          "traefik.http.middlewares.tasks-api-stripprefix.stripprefix.prefixes=/api",
          "traefik.http.services.tasks-api.loadbalancer.server.port=3000",
        ]
      }
    }
  }
}
```

## Padrões de portas (pra não colidir, já que é tudo `network_mode = "host"`)

| App / serviço      | Porta |
|---------------------|-------|
| Traefik (web)        | 80    |
| Traefik (dashboard/api interno) | 8080 |
| Keycloak             | 8082  |
| Portainer            | 9000  |
| forward-auth         | 4181  |
| Postgres (Keycloak)  | 5432  |
| loja                 | 8081  |
| blog                 | 8083  |
| tasks-front          | 8085  |
| tasks-api            | 3000  |
| tasks-db (Postgres)  | 5433  |
| Traefik (métricas)   | 8180  |
| loja (exporter nginx)| 9113  |
| blog (exporter nginx)| 9114  |
| lab-docs             | 8090  |

Toda porta nova precisa checar essa tabela antes de escolher um número
— o erro mais comum ao criar uma aplicação nova neste lab é reusar uma
porta já ocupada por outro serviço e o container simplesmente não subir
(bind: address already in use).

## Fazendo manualmente (sem CI, direto por SSH)

Testar um job antes de commitar (é o que se faz neste lab o tempo todo
antes de dar `git push`, pra não gastar um ciclo de CI só pra descobrir
um erro de sintaxe):

```bash
scp meu-job.nomad.hcl azureuser@<control-plane>:/tmp/
ssh azureuser@<control-plane> 'cd /tmp && nomad job validate meu-job.nomad.hcl'
ssh azureuser@<control-plane> 'cd /tmp && nomad job run -detach meu-job.nomad.hcl'
```

Acompanhar o deploy e ver logs:

```bash
ssh azureuser@<control-plane> 'nomad job status meu-job'
ssh azureuser@<control-plane> 'nomad alloc logs <alloc-id>'
ssh azureuser@<control-plane> 'nomad alloc logs -stderr <alloc-id>'
```

Gerar tráfego real pra testar (usado o tempo todo pra popular
métricas/logs/traces antes de validar um dashboard novo):

```bash
curl -H "Host: minha-app.lab.evalabs.com.br" http://<ip-da-lb>/
```
