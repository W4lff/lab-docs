---
title: Traefik
order: 6
---

# Traefik

Traefik é a porta de entrada HTTP do cluster — todo domínio
`*.lab.evalabs.com.br` chega nele primeiro, e ele decide pra qual
serviço encaminhar.

## Como está neste lab

- 2 réplicas (`count = 2`, `distinct_hosts = true`) — uma em cada
  worker. A Load Balancer da Azure já faz o balanceamento real entre as
  duas (health probe TCP na 80).
- **Provider `consulcatalog`** — nenhuma rota é escrita à mão; o Traefik
  monitora o catálogo do Consul e monta rotas a partir das tags de cada
  serviço registrado:
  ```
  --providers.consulcatalog=true
  --providers.consulcatalog.endpoint.address=127.0.0.1:8500
  --providers.consulcatalog.exposedByDefault=false
  ```
  `exposedByDefault=false` é importante: um serviço só vira rota se
  **explicitamente** tiver `traefik.enable=true` nas tags — sem isso,
  qualquer coisa registrada no Consul (inclusive infra interna) ficaria
  exposta por acidente.
- Entrypoints: `web` (`:80`, é o único usado por qualquer rota hoje) e
  `websecure` (`:443`, declarado mas **sem nenhuma rota apontando pra
  ele** — o TLS na Cloudflare está em modo *DNS only*, sem proxy, então
  não há terminação HTTPS de verdade acontecendo no lab hoje; o `:443`
  fica de pé com o certificado autoassinado padrão do Traefik, mas
  qualquer request nele cai em 404 por falta de router).
- Entrypoint de métricas **separado** (`:8180`), sem SSO, scrapeado
  direto pelo Prometheus via IP privado — não passa pelo fluxo normal de
  roteamento.
- **Middleware `forward-auth`**: aplicado via tag em toda rota que exige
  login (Vault UI, Portainer, Grafana, Prometheus, Nomad UI, o dashboard
  do próprio Traefik). Ver [Keycloak/SSO](07-keycloak-sso) pro detalhe de
  como esse middleware funciona.
- **Roteamento por path no mesmo domínio** (evita CORS): `tasks-app`
  usa `PathPrefix(`/api`)` + `stripprefix` pra rotear `/api/*` pra API e
  o resto pro front, ambos em `tasks.lab.evalabs.com.br`.

## Fazendo manualmente

Rodar o Traefik lendo rotas de um arquivo estático (sem Consul), só pra
entender o modelo de dados:

```yaml
# traefik.yml
entryPoints:
  web:
    address: ":80"
providers:
  file:
    filename: /etc/traefik/dynamic.yml
```

```yaml
# dynamic.yml
http:
  routers:
    minha-app:
      rule: "Host(`minha-app.lab.evalabs.com.br`)"
      service: minha-app
      middlewares: ["forward-auth"]
  services:
    minha-app:
      loadBalancer:
        servers:
          - url: "http://10.20.2.10:8080"
  middlewares:
    forward-auth:
      forwardAuth:
        address: "http://10.20.2.10:4181/"
        authResponseHeaders: ["X-Forwarded-User"]
```

```bash
traefik --configFile=traefik.yml
```

Testar uma rota direto (bypassando DNS/LB), simulando o Host header —
técnica usada o tempo todo neste lab pra debugar sem esperar propagação
de DNS:

```bash
curl -H "Host: minha-app.lab.evalabs.com.br" http://10.20.2.10/
```

Ver as rotas que o Traefik montou a partir do Consul, via API dele:

```bash
curl -s http://127.0.0.1:8080/api/http/routers | jq
curl -s http://127.0.0.1:8080/api/http/services | jq
```

A diferença do `consulcatalog` pro `file` provider: com Consul, subir um
job Nomad novo com as tags certas já cria a rota automaticamente — não
precisa editar nenhum arquivo de config do Traefik nem reiniciá-lo.
