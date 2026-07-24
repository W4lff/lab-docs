---
title: APISIX (API Gateway)
order: 13
---

# APISIX — API Gateway na frente do tasks-api

Depois de decidir controlar taxa de requisição numa API específica
(`tasks-api`), avaliamos três ferramentas — KrakenD, Kong e APISIX — e
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
Internet → Traefik (Host + PathPrefix /api, sem mudança)
              → APISIX (rate limit: 20 requisições / 60s por IP)
                  → tasks-api (descoberto via DNS do Consul)
```

Traefik continua sendo o único ponto de entrada público do lab e
continua roteando por domínio exatamente como antes — a única mudança
é que a tag que antes apontava direto pro `tasks-api` agora aponta pro
`apisix`. O `tasks-api` perdeu suas próprias tags de Traefik (ver
[Camada de aplicações](12-apps)) e mantém só o registro simples no
Consul (nome + porta + health check), que é o que o APISIX consulta.

## Como está montado

- **etcd** — store de configuração do APISIX (rotas/upstreams/plugins
  vivem lá, não em arquivo estático — dá pra mudar via Admin API sem
  reiniciar nada). Um nó só, fixo num worker conhecido (mesmo padrão do
  forward-auth: precisa de endereço estável, sem cluster de peers).
- **APISIX**, `count = 2`, `distinct_hosts` — mesmo padrão de HA do
  resto do lab.
- **Rota e upstream** configurados via **Admin API** depois do deploy
  (não fazem parte do `config.yaml` do job) — um passo a mais no
  pipeline do `stack-hashicorp-apps` que faz o `PUT` no upstream
  (`discovery_type: dns`, `service_name: tasks-api.service.consul`) e
  na rota (`limit-count`: 20 requisições / 60s, por IP,
  `rejected_code: 429`).

## O bug real: por que não é `discovery.consul` nativo

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
