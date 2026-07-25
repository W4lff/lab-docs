---
title: APISIX (API Gateway)
order: 13
---

# APISIX — API Gateway centralizando todas as rotas

Começou como rate limiting numa API específica (`tasks-api`) e depois
virou o padrão do lab inteiro: **todo tráfego HTTP, sem exceção,
passa pelo APISIX antes do backend real** — as 4 aplicações públicas
(tasks-api, loja, blog, lab-docs) e as 6 ferramentas administrativas
atrás de SSO (grafana, portainer, prometheus, keycloak, vault-ui,
nomad-ui). O único trabalho que continua só no Traefik é o que não faz
sentido delegar: TLS/Let's Encrypt, o roteamento por `Host()`, e o
middleware de SSO (oauth2-proxy) — ver a seção "SSO continua no Traefik, não
no APISIX" mais abaixo.

Avaliamos três ferramentas pra isso — KrakenD, Kong e APISIX — e
escolhemos o **Apache APISIX**. Vale registrar o porquê, porque a
decisão não foi só gosto.

## Por que APISIX, não KrakenD nem Kong

- **KrakenD** foi descartado primeiro: ele é feito pra compor endpoints
  conhecidos e fixos (API composition), roteando por **path**, não por
  domínio — e não tem descoberta dinâmica via Consul. Colocá-lo na
  borda do lab exigiria reescrever config estática a cada deploy novo e
  fingir roteamento por Host na marra. Como camada extra na frente de
  *uma* API já conhecida ele funcionaria, mas sem a vantagem de
  descoberta automática que o resto do lab já tem.
- **Kong** também foi considerado: roteia por Host nativamente, mas a
  integração com Consul é indireta (via DNS, sem módulo nativo), e o
  modo tradicional exige um banco próprio (Postgres) — mais uma peça de
  infra pra manter.
- **APISIX** tem um módulo de descoberta dedicado a Consul
  (`discovery.consul`) e roteia por Host — no papel, o encaixe perfeito
  com o resto do lab (tudo aqui já gira em torno de "o serviço se
  registra no Consul e a peça de borda descobre sozinha"). Na prática,
  esse módulo específico tem um bug real com o jeito que o Nomad
  registra serviços neste lab (ver abaixo) — então o mecanismo de
  descoberta usado de fato acabou sendo outro, mas a escolha da
  ferramenta continua certa pelos outros motivos (licença 100% Apache,
  sem separação OSS/Enterprise; `etcd` como store, mais leve que um
  Postgres dedicado).

## Arquitetura

```
Internet → Traefik (TLS, Host(), oauth2-proxy quando exigido)
              → APISIX (descoberta via DNS do Consul, rate limit só no tasks-api)
                  → backend real
```

Traefik continua sendo o único ponto de entrada público do lab. A
única mudança, app por app: a tag que antes apontava direto pro
serviço real agora aponta pro `apisix` — o serviço original perde suas
próprias tags de Traefik e mantém só o registro simples no Consul
(nome + porta nativa + health check), que é o que o APISIX descobre
via DNS.

Todos os 10 roteadores (`tasks-api`, `loja`, `blog`, `lab-docs`,
`grafana`, `portainer`, `prometheus`, `keycloak`, `vault-ui`,
`nomad-ui`) vivem como **tags de um único serviço Consul**: o próprio
`apisix`. Isso é o que permite ao Traefik encontrar 10 rotas distintas
apontando pro mesmo backend (porta 9081) — e foi também a origem de um
bug real, ver abaixo.

## Como está montado

- **etcd** — store de configuração do APISIX (rotas/upstreams/plugins
  vivem lá, não em arquivo estático — dá pra mudar via Admin API sem
  reiniciar nada). Um nó só, fixo num worker conhecido (mesmo padrão do
  oauth2-proxy: precisa de endereço estável, sem cluster de peers).
- **APISIX**, `count = 2`, `distinct_hosts` — mesmo padrão de HA do
  resto do lab.
- **Rota e upstream de cada app** configurados via **Admin API** depois
  do deploy (não fazem parte do `config.yaml` do job) — um passo a mais
  no pipeline do `stack-hashicorp-apps` que faz o `PUT` num upstream por
  app (`discovery_type: dns`, `service_name: <app>.service.consul`) e
  numa rota por app. Só a rota do `tasks-api` tem o plugin `limit-count`
  (20 requisições / 60s, por IP, `rejected_code: 429`) — é a única API
  pública do lab; as demais (incluindo as 6 administrativas) não têm
  rate limit próprio, porque já são protegidas por SSO ou já rodam rate
  limit na própria aplicação.

## SSO continua no Traefik, não no APISIX

As 6 rotas administrativas (grafana, portainer, prometheus, keycloak,
vault-ui, nomad-ui) mantêm o middleware do oauth2-proxy **na tag do
Traefik**, não dentro do APISIX — ou seja, o oauth2-proxy intercepta
*antes* de a requisição sequer chegar no APISIX. Isso foi deliberado:
colocar autenticação dentro do gateway funcionaria, mas duplicaria uma
peça que o Traefik já resolve bem, e a única (o `keycloak`) que
*não* leva o middleware é o próprio provedor de SSO — não dá pra
exigir login pra chegar na página de login.

O Keycloak também está atrás do APISIX (sem rate limit — ver acima), o
que só foi seguro fazer depois de resolver o
[clustering real via JDBC_PING](07-keycloak-sso), porque antes disso a
troca de código OIDC por token (uma chamada servidor-a-servidor do
forward-auth, sem cookie de sticky session) tinha ~50% de chance de
cair numa réplica que não conhecia aquele código.

## Bug real #1: por que não é `discovery.consul` nativo

O módulo `discovery.consul` do APISIX varre o **catálogo inteiro** do
Consul pra montar seu cache — não só o serviço que alguém pediu. Duas
coisas quebraram nisso:

1. **Serviços com porta zero**: a maioria das apps deste lab registra
   sua porta real só na tag `traefik.http.services.X.loadbalancer.server.port`,
   não no campo nativo `service.port` do Nomad — então o Consul guarda
   `ServicePort: 0` pra elas (loja, blog, keycloak, grafana, portainer,
   prometheus, forward-auth, traefik). O módulo do APISIX quebra com
   `attempt to concatenate local 'svc_port' (a nil value)` ao tentar
   montar `host:porta` com porta zero. Corrigido em parte declarando
   porta explícita em serviços que faziam sentido ter uma (Loki, Tempo),
   e contornado no resto com uma lista `skip_services` no config do
   APISIX.
2. **Endereço em branco**: mesmo pulando os serviços problemáticos, o
   campo `Service.Address` do `tasks-api` no catálogo do Consul vem
   **vazio** (consequência de registrar com `address_mode = "driver"`,
   necessário porque o job roda em `network_mode = "host"` sem
   `network{}` stanza — ver [Nomad](04-nomad)). O `discovery.consul` do
   APISIX não faz fallback pro endereço do *node* quando o do *serviço*
   está em branco, e falha com `no host while connecting to upstream`.

A solução foi trocar de mecanismo: usar a **interface DNS do Consul**
(porta 8600, sempre ligada) em vez do módulo nativo. Consultar
`tasks-api.service.consul` via DNS resolve certo pro IP do node mesmo
quando o campo de serviço está vazio — porque o servidor DNS do Consul
já foi escrito pra lidar com esse caso, o módulo Lua do APISIX não.

## Bug real #2: Traefik não linka router com service ambíguo

Ao mover a 2ª, 3ª e 4ª rota (`loja`, `blog`, `lab-docs`) pro mesmo
serviço Consul `apisix`, todas as rotas — inclusive o `tasks-api`, que
já funcionava havia dias — começaram a devolver `404` puro do Traefik,
sem log de erro óbvio. `curl` direto no APISIX (pulando o Traefik)
funcionava perfeitamente; só o Traefik na frente quebrava.

A causa, achada no log do próprio Traefik
(`nomad alloc logs` no worker, não no Consul nem no APISIX):

```
ERR Router loja cannot be linked automatically with multiple Services: ["blog" "lab-docs" "loja" "tasks-api"] providerName=consulcatalog routerName=loja
```

O provider `consulcatalog` do Traefik faz o link automático
router→service **só quando existe exatamente um** `traefik.http.services.X`
declarado nas tags daquele registro do Consul. Com 4 (depois 10)
serviços diferentes descritos nas tags de uma única entrada Consul
(`apisix`), o Traefik não tem como adivinhar sozinho qual service cada
router deveria usar — e falha *silenciosamente* pra todos, não só pro
router novo.

A correção é declarar o vínculo explicitamente, por router:

```
"traefik.http.routers.loja.service=loja",
```

Sem essa linha, o comportamento é tudo ou nada: um router a mais
usando o padrão implícito derruba os que já funcionavam.

## Fazendo manualmente

Rodar etcd + APISIX localmente, sem Nomad, só pra entender o
mecanismo:

```bash
docker run -d --name etcd --network host quay.io/coreos/etcd:v3.5.17 \
  /usr/local/bin/etcd --data-dir=/etcd-data \
  --listen-client-urls=http://0.0.0.0:2379 \
  --advertise-client-urls=http://127.0.0.1:2379

docker run -d --name apisix --network host \
  -v $(pwd)/config.yaml:/usr/local/apisix/conf/config.yaml \
  apache/apisix:3.9.0-debian
```

Configurar upstream + rota via Admin API (o que o pipeline automatiza
a cada deploy):

```bash
curl -X PUT "http://127.0.0.1:9180/apisix/admin/upstreams/1" \
  -H "X-API-KEY: <admin_key>" \
  -d '{
    "type": "roundrobin",
    "discovery_type": "dns",
    "service_name": "minha-app.service.consul"
  }'

curl -X PUT "http://127.0.0.1:9180/apisix/admin/routes/1" \
  -H "X-API-KEY: <admin_key>" \
  -d '{
    "uri": "/*",
    "upstream_id": "1",
    "plugins": {
      "limit-count": {
        "count": 20,
        "time_window": 60,
        "rejected_code": 429,
        "key": "remote_addr"
      }
    }
  }'
```

Testar o rate limit na mão (o teste feito pra validar esse exato
deploy):

```bash
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code} " http://127.0.0.1:9081/tasks
done
# esperado: "200 " vinte vezes, depois "429 " no resto
```

Testar a descoberta via DNS do Consul isoladamente (útil pra separar
"problema é o APISIX" de "problema é o Consul"):

```bash
dig @127.0.0.1 -p 8600 minha-app.service.consul A +short
dig @127.0.0.1 -p 8600 minha-app.service.consul SRV +short
```

Ver rotas e upstreams já configurados:

```bash
curl -H "X-API-KEY: <admin_key>" http://127.0.0.1:9180/apisix/admin/routes
curl -H "X-API-KEY: <admin_key>" http://127.0.0.1:9180/apisix/admin/upstreams
```
