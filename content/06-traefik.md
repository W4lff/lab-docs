---
title: Traefik
order: 6
---

# Traefik

Traefik é a porta de entrada HTTP(S) do cluster — todo domínio
`*.lab.evalabs.com.br` chega nele (depois de passar pelo HAProxy, ver
[Arquitetura](00-arquitetura)), e ele decide pra qual serviço encaminhar.

## Como está neste lab

- 2 réplicas (`count = 2`, `distinct_hosts = true`) — uma em cada
  worker. A VM de **HAProxy** na borda faz o balanceamento TCP entre as
  duas (`tcp-check`); antes disso era o Load Balancer da Azure — ver
  [Arquitetura](00-arquitetura) pra essa troca.
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
- Entrypoints: `web` (`:80`) e `websecure` (`:443`, com certificado real
  **Let's Encrypt**, wildcard, via desafio **DNS-01** contra a
  Cloudflare). `web` tem um **redirect global pra `websecure`**:
  ```
  --entrypoints.web.http.redirections.entryPoint.to=websecure
  --entrypoints.web.http.redirections.entryPoint.scheme=https
  ```
  Sem isso, uma requisição batendo em `http://` roda a sessão inteira
  do SSO em HTTP puro — e como o oauth2-proxy marca os cookies (sessão +
  CSRF) como `Secure` por padrão, o navegador se recusa a devolvê-los
  numa conexão sem TLS. O sintoma é `"CSRF cookie ... was not found"` no
  callback, parecendo bug de permissão/grupo — mas é só a sessão nunca
  ter sido HTTPS desde o início.
- Entrypoint de métricas **separado** (`:8180`), sem SSO, scrapeado
  direto pelo Prometheus via IP privado — não passa pelo fluxo normal de
  roteamento.
- **Middleware `oauth2-proxy`** (não mais `forward-auth`, ver
  [Keycloak/SSO](07-keycloak-sso) pro porquê da troca e o RBAC por
  grupo): aplicado via tag em toda rota administrativa (Vault UI,
  Portainer, Grafana, Prometheus, Nomad UI).
- **Roteamento por path no mesmo domínio** (evita CORS): `tasks-app`
  usa `PathPrefix(`/api`)` + `stripprefix` pra rotear `/api/*` pra API e
  o resto pro front, ambos em `tasks.lab.evalabs.com.br`.

### Bug real: certificado não persistia entre redeploys

O volume do certificado ACME estava declarado como
`"traefik_acme:/letsencrypt"` — sem `/` na frente, isso vira uma pasta
**relativa** dentro do diretório efêmero da alocação (Nomad + driver
Docker), não um volume Docker de verdade. Resultado: toda vez que o
Traefik era recriado (redeploy por qualquer motivo), as 2 réplicas
perdiam o certificado e pediam o wildcard de novo do zero — o que já
queimou a cota semanal de certificado duplicado da Let's Encrypt
(5 por 168h) num único dia de redeploys seguidos, deixando o site com
certificado autoassinado por horas até a cota liberar de novo.

Corrigido trocando pra um **caminho absoluto no host**
(`/opt/traefik-acme:/letsencrypt`). Como as réplicas usam
`distinct_hosts = true` com só 2 workers, cada uma sempre volta pro
mesmo nó físico — então o certificado persiste de verdade entre
redeploys a partir de agora. Mesma classe de bug encontrada antes no
Portainer (mesmo padrão de volume sem `/` na frente, perdendo dados a
cada redeploy) — regra geral pra esse lab: **sempre caminho absoluto no
host quando precisar de persistência de verdade**.

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
      middlewares: ["oauth2-proxy"]
  services:
    minha-app:
      loadBalancer:
        servers:
          - url: "http://10.20.2.10:8080"
  middlewares:
    oauth2-proxy:
      forwardAuth:
        # Endereço fixo ("/"), não a URL pública — a checagem do
        # oauth2-proxy sempre bate nesse path fixo, independente da rota
        # real que está sendo protegida.
        address: "http://10.20.2.10:4183/"
        authResponseHeaders: ["X-Auth-Request-Email", "X-Auth-Request-User"]
        trustForwardHeader: true
```

```bash
traefik --configFile=traefik.yml
```

Testar uma rota direto (bypassando DNS/HAProxy), simulando o Host
header — técnica usada o tempo todo neste lab pra debugar sem esperar
propagação de DNS:

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
