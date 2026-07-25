---
title: Keycloak / SSO
order: 7
---

# Keycloak e Single Sign-On

Keycloak dá login único (SSO) pras ferramentas administrativas do lab —
Vault UI, Nomad UI, Portainer, Grafana, Prometheus. Ninguém acessa
essas UIs sem antes autenticar via OIDC, e **quem vê o quê depende do
grupo do usuário no Keycloak** (RBAC de verdade, não só "autenticou ou
não" — ver seção própria abaixo).

## Como está neste lab

- Keycloak roda como job Nomad (`count = 2`, cluster Infinispan de
  verdade via JDBC_PING — ver bug abaixo), com Postgres dedicado (porta
  própria, pra não colidir com o Postgres do `tasks-app`).
- Realm `lab`, client `oauth2-proxy` (confidencial — client secret
  guardado como variável do job, nunca em texto no repo), mais um
  client scope `groups` (mapeia o grupo Keycloak do usuário pro claim
  `groups` do token — o oauth2-proxy pede esse escopo quando alguma
  instância usa `--allowed-group`, ver abaixo).
- O SSO **não** é feito pelo Keycloak sozinho — é o
  **[oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy)** quem
  faz a ponte: middleware `forwardAuth` do Traefik que intercepta toda
  requisição pras rotas protegidas, checa sessão válida (cookie), e
  redireciona pro Keycloak se não houver.
- **Duas instâncias, um nível de acesso cada** (mesmo job, dois
  `group`s Nomad, ver [APISIX](13-apisix)): `all` (qualquer usuário
  autenticado — hoje só o Grafana usa) e `devops`
  (`--allowed-group=devops` — Nomad UI, Vault UI, Portainer,
  Prometheus). Adicionar um grupo novo (ex: `qa`, vendo só um subconjunto
  diferente de ferramentas) é: criar o grupo no Keycloak + copiar um
  `group` deste job trocando `--allowed-group` + apontar o middleware
  das rotas certas pra essa nova instância — sem tocar nas que já
  funcionam.
- Cada instância tem seu próprio **auth-host** dedicado
  (`auth-dev.lab.evalabs.com.br`, `auth-devops.lab.evalabs.com.br`) só
  pro callback OIDC — **fixos** (`constraint` de nó) no `vm-worker-01`,
  com o middleware apontando pro **IP privado direto** dele, não pro
  hostname público (senão a chamada interna Traefik→oauth2-proxy
  passaria *de novo* pelo Traefik público, reescrevendo os headers
  `X-Forwarded-*` com dados da chamada interna).

## Bug real: o auth-host NÃO pode levar o próprio middleware

Contra-intuitivo, e o oposto do que a ferramenta anterior
(thomseddon/traefik-forward-auth) exigia: aqui, o router do auth-host
(`auth-dev.lab.evalabs.com.br`) **não** leva o middleware `forwardAuth`
da própria instância.

O motivo: a checagem `forwardAuth` do Traefik sempre bate num endereço
**fixo** (configurado como `http://10.20.2.10:4183/`, sempre `/`,
nunca o path real da requisição). Se o `/oauth2/callback` de verdade
passasse por essa checagem primeiro, o oauth2-proxy nunca veria o
`code`/`state` reais — só saberia que bateu em `/`, sem sessão, e
mandaria logar de novo. Resultado: um loop infinito de redirecionamento
pro Keycloak, a cada tentativa com um `state` novo, nunca completando.
O `/oauth2/callback` precisa chegar **direto** no oauth2-proxy, sem
middleware no meio — só assim ele processa o código de autorização de
verdade.

## Bug real: ~50% dos logins falhavam sem clustering de verdade

Depois de habilitar HTTPS em todas as rotas (`entrypoints=web,websecure`),
o login SSO passou a falhar de forma aleatória com
`"Code not valid"` no forward-auth. A causa não tinha nada a ver com
HTTPS em si:

- O Keycloak roda com `count = 2` (uma réplica por worker).
- A sticky session que já existia no Traefik
  (`loadbalancer.sticky.cookie`) protege as chamadas do **navegador**
  (GET `/auth`, POST `/login-actions/...`) — o cliente sempre cai na
  mesma réplica.
- Mas a **troca do código de autorização por token** é uma chamada
  **servidor-a-servidor** do forward-auth direto pro Keycloak, sem
  cookie nenhum — cai round-robin em qualquer réplica.
- Sem cache Infinispan clusterizado entre as 2 réplicas, o código de
  autorização gerado na réplica A simplesmente não existe pra réplica
  B. Se a troca cair na réplica errada: `"Code not valid"`. Ao acaso,
  ~50% das tentativas.

Sticky session não resolve isso, porque a chamada vulnerável nunca
teve cookie pra começo de conversa. A correção de verdade foi
clusterizar o Keycloak com Infinispan de fato, usando **JDBC_PING**
(descoberta de membros do cluster via uma tabela no próprio Postgres
que o Keycloak já usa — sem precisar de multicast/UDP, que não existe
entre VMs Azure em subnets diferentes):

```hcl
args = [
  "start-dev",
  "--http-port=8082",
  "--cache=ispn",
  "--cache-stack=jdbc-ping",
]
```

Precisa também de uma faixa de porta TCP liberada entre os workers pro
JGroups trocar estado (`7800-7850` na NSG, ver [Terraform](01-terraform)).
Confirmação de que o cluster formou de verdade sai no log do próprio
Keycloak:

```
ISPN000094: Received new cluster view for channel ISPN: [...] (2) [vm-worker-01-xxxx, vm-worker-02-xxxx]
```

Com "(2)" membros na view, uma réplica enxerga o código de autorização
gerado pela outra — o `"Code not valid"` aleatório para de acontecer.

Outro efeito colateral do HTTPS: o client OIDC (na época,
`traefik-forward-auth`; hoje `oauth2-proxy`, ver abaixo) só tinha o
`redirect_uri` em `http://` cadastrado. Assim que o auth-host passou a
responder em `https://` também, a ferramenta passou a gerar o
`redirect_uri` com `https://` — e o Keycloak rejeitava com
`"Invalid parameter: redirect_uri"` por não bater com a lista. Corrigido
adicionando a variante `https://` ao client via Admin API.

Isso foi descoberto e corrigido ainda com o forward-auth (thomseddon/
traefik-forward-auth), retirado depois em favor do oauth2-proxy (ver
seção "RBAC por grupo" abaixo) — mas o risco de fundo (troca de código
por token é uma chamada servidor-a-servidor, sem sticky session) é
idêntico com qualquer ferramenta nessa posição. O clustering via
JDBC_PING continua sendo o que resolve de verdade, não o proxy em si.

## Bug real: Keycloak rejeitava o escopo "groups" (`invalid_scope`)

Ao configurar a instância `devops` do oauth2-proxy com
`--allowed-group=devops`, todo login pra essas rotas quebrava com
`error=invalid_scope&error_description=Invalid+scopes: ...+groups` —
o oauth2-proxy, ao usar `--allowed-group`, automaticamente pede o
escopo OIDC `groups` na autorização (`scope=openid+email+profile+groups`).
Só que existir um *protocol mapper* de grupo direto no client não é
suficiente — o Keycloak precisa de um **client scope** com esse nome
exato existindo no realm, senão rejeita o pedido de escopo inteiro
como inválido (não só ignora o pedaço desconhecido).

Correção: criar um client scope chamado `groups`, colocar o mapper
`oidc-group-membership-mapper` nele (não direto no client), e atribuir
esse scope como *default* no client `oauth2-proxy` (não *optional* —
senão precisaria ser pedido explicitamente de novo em algum lugar).

## RBAC por grupo (dev / devops)

Substituímos o forward-auth pelo **oauth2-proxy** especificamente
porque precisávamos de RBAC de verdade: dev enxerga as aplicações e o
Grafana, devops enxerga tudo (+ Nomad UI, Vault UI, Portainer,
Prometheus). O forward-auth só sabia checar "autenticou ou não" — sem
ler grupo/role nenhum do token — então qualquer separação por perfil
teria que ser uma lista de e-mail fixa por rota (e olhe lá: a versão
instalada nem suporta whitelist por rota, só `--rule.<nome>.action`,
descoberto rodando `--help` direto no binário antes de tentar
configurar isso — a documentação online descrevia um recurso que essa
versão não tem).

`oauth2-proxy` lê o claim `groups` do token (`--oidc-groups-claim`,
default já é `"groups"`) e filtra com `--allowed-group`. Cada nível de
acesso é uma instância separada — mesmo job Nomad, `group`s diferentes
(`all`, `devops`), cada uma com seu próprio `--allowed-group` (ou sem
nenhum, pra "qualquer autenticado"). Ver [APISIX](13-apisix) pra como
cada rota aponta pro middleware certo.

## Fazendo manualmente

Criar o realm, o client scope `groups` (com o mapper de grupo) e o
client via `kcadm`:

```bash
# dentro do container/VM do Keycloak
kcadm.sh config credentials --server http://localhost:8082 \
  --realm master --user admin --password <senha-admin>

kcadm.sh create realms -s realm=lab -s enabled=true

kcadm.sh create client-scopes -r lab \
  -s name=groups -s protocol=openid-connect

kcadm.sh create clients -r lab \
  -s clientId=oauth2-proxy \
  -s enabled=true \
  -s publicClient=false \
  -s 'redirectUris=["https://auth-dev.lab.evalabs.com.br/oauth2/callback","https://auth-devops.lab.evalabs.com.br/oauth2/callback"]' \
  -s 'defaultClientScopes+=["groups"]' \
  -s secret=<gerar-um-secret-forte>

kcadm.sh create groups -r lab -s name=devops
kcadm.sh create groups -r lab -s name=dev
```

Testar manualmente o fluxo OIDC (authorization code), sem o
oauth2-proxy no meio — útil pra entender o que ele automatiza:

```bash
# 1. Abrir no navegador (ou seguir com curl -L) essa URL:
http://keycloak.lab.evalabs.com.br/realms/lab/protocol/openid-connect/auth?client_id=oauth2-proxy&redirect_uri=https://auth-dev.lab.evalabs.com.br/oauth2/callback&response_type=code&scope=openid+profile+email

# 2. Depois do login, o Keycloak redireciona pra redirect_uri com ?code=...
# 3. Trocar o code por um token:
curl -X POST http://keycloak.lab.evalabs.com.br/realms/lab/protocol/openid-connect/token \
  -d "grant_type=authorization_code" \
  -d "client_id=oauth2-proxy" \
  -d "client_secret=<secret>" \
  -d "code=<code-recebido>" \
  -d "redirect_uri=https://auth-dev.lab.evalabs.com.br/oauth2/callback"
```

Rodar o oauth2-proxy manualmente, fora do Nomad, só pra testar:

```bash
docker run -p 4183:4183 \
  quay.io/oauth2-proxy/oauth2-proxy:latest \
  --http-address=0.0.0.0:4183 \
  --upstream=static://202 \
  --provider=oidc \
  --oidc-issuer-url=http://keycloak.lab.evalabs.com.br/realms/lab \
  --client-id=oauth2-proxy \
  --client-secret=<secret> \
  --cookie-secret=<32 bytes, base64> \
  --redirect-url=https://auth-dev.lab.evalabs.com.br/oauth2/callback \
  --email-domain=* \
  --cookie-domain=.lab.evalabs.com.br \
  --set-xauthrequest=true \
  --reverse-proxy=true
```

Debugar um loop de redirecionamento infinito: checar se a rota do
próprio `auth-host` está levando o middleware `forwardAuth` **nela
mesma** — com oauth2-proxy, ela **não pode** (diferente do
forward-auth antigo, que exigia o oposto — ver bug acima). Debugar um
`invalid_scope`: confirmar que existe um client scope chamado
`groups` de verdade no realm, não só um protocol mapper solto no
client.
