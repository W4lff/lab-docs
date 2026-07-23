---
title: Keycloak / SSO
order: 7
---

# Keycloak e Single Sign-On

Keycloak dá login único (SSO) pras ferramentas administrativas do lab —
Vault UI, Nomad UI, Portainer, Grafana, Prometheus, o dashboard do
Traefik. Ninguém acessa essas UIs sem antes autenticar via OIDC.

## Como está neste lab

- Keycloak roda como job Nomad (`count = 2`), com Postgres dedicado
  (porta própria, pra não colidir com o Postgres do `tasks-app`).
- Realm `lab`, client `traefik-forward-auth` (client OIDC confidencial —
  tem client secret, guardado como variável do job, nunca em texto no
  repo).
- O SSO **não** é feito pelo Keycloak sozinho — é o
  **`traefik-forward-auth`** (thomseddon/traefik-forward-auth) quem faz
  a ponte: ele é um middleware do Traefik (`forwardAuth`) que intercepta
  toda requisição pras rotas protegidas, checa se existe uma sessão
  válida (cookie), e se não existir, redireciona pro Keycloak.
  ```
  PROVIDERS_OIDC_ISSUER_URL = http://keycloak.lab.evalabs.com.br/realms/lab
  PROVIDERS_OIDC_CLIENT_ID  = traefik-forward-auth
  AUTH_HOST                 = auth.lab.evalabs.com.br
  COOKIE_DOMAIN             = lab.evalabs.com.br
  ```
- **O detalhe mais sutil de todo o lab**: o próprio router
  `auth.lab.evalabs.com.br` (onde o forward-auth atende o callback
  `/_oauth` do OIDC) também precisa ter o middleware `forward-auth`
  aplicado a si mesmo. Sem isso, o Traefik não injeta os headers
  `X-Forwarded-Uri`/`X-Forwarded-Method` naquela chamada específica, e o
  forward-auth não reconhece a requisição como o callback esperado —
  trata como visita nova, reinicia o login, e gera um loop infinito de
  redirecionamento depois que o usuário loga no Keycloak.
- O forward-auth está **fixo** (`constraint` de nó) no `vm-worker-01`,
  com o middleware apontando pro **IP privado direto** dele
  (`http://10.20.2.10:4181/`) — não pro hostname público. Se apontasse
  pro domínio público, a chamada interna Traefik→forward-auth passaria
  *de novo* pelo Traefik público, e essa segunda passagem reescreveria
  os headers `X-Forwarded-*` com dados da chamada interna, apagando o
  host/URI originais que o usuário realmente pediu.

## Fazendo manualmente

Criar o realm e o client via `kcadm` (CLI administrativo do Keycloak):

```bash
# dentro do container/VM do Keycloak
kcadm.sh config credentials --server http://localhost:8082 \
  --realm master --user admin --password <senha-admin>

kcadm.sh create realms -s realm=lab -s enabled=true

kcadm.sh create clients -r lab \
  -s clientId=traefik-forward-auth \
  -s enabled=true \
  -s publicClient=false \
  -s 'redirectUris=["http://auth.lab.evalabs.com.br/_oauth"]' \
  -s secret=<gerar-um-secret-forte>
```

Testar manualmente o fluxo OIDC (authorization code), sem o
forward-auth no meio — útil pra entender o que ele automatiza:

```bash
# 1. Abrir no navegador (ou seguir com curl -L) essa URL:
http://keycloak.lab.evalabs.com.br/realms/lab/protocol/openid-connect/auth?client_id=traefik-forward-auth&redirect_uri=http://auth.lab.evalabs.com.br/_oauth&response_type=code&scope=openid+profile+email

# 2. Depois do login, o Keycloak redireciona pra redirect_uri com ?code=...
# 3. Trocar o code por um token:
curl -X POST http://keycloak.lab.evalabs.com.br/realms/lab/protocol/openid-connect/token \
  -d "grant_type=authorization_code" \
  -d "client_id=traefik-forward-auth" \
  -d "client_secret=<secret>" \
  -d "code=<code-recebido>" \
  -d "redirect_uri=http://auth.lab.evalabs.com.br/_oauth"
```

Rodar o forward-auth manualmente, fora do Nomad, só pra testar:

```bash
docker run -p 4181:4181 \
  -e PROVIDERS_OIDC_ISSUER_URL=http://keycloak.lab.evalabs.com.br/realms/lab \
  -e PROVIDERS_OIDC_CLIENT_ID=traefik-forward-auth \
  -e PROVIDERS_OIDC_CLIENT_SECRET=<secret> \
  -e SECRET=<qualquer-string-aleatoria> \
  -e AUTH_HOST=auth.lab.evalabs.com.br \
  -e COOKIE_DOMAIN=lab.evalabs.com.br \
  thomseddon/traefik-forward-auth:2
```

Debugar um loop de redirecionamento (o bug mais custoso deste lab):
checar se a rota do próprio `auth-host` tem o middleware de forward-auth
aplicado nela mesma, e se o `forwardauth.address` do middleware é um IP
privado direto (não passa pelo domínio público de novo).
