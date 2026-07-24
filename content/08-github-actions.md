---
title: GitHub Actions (runners self-hosted)
order: 8
---

# GitHub Actions — quem faz o deploy de verdade

Regra do lab (a mesma citada em [Ansible](02-ansible), do outro lado):
**só o GitHub Actions sobe/atualiza containers de aplicação.** Cada
push em `main` de cada repo de app dispara um pipeline que builda a
imagem, dá push pro ghcr.io, e roda `nomad job run`.

## Runner self-hosted vs runner hospedado — o híbrido

Todo repo de app usa hoje **dois runners diferentes no mesmo
pipeline**, um pra cada responsabilidade:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest        # hospedado pelo GitHub
    # builda e dá push pro ghcr.io — não precisa de rede privada nenhuma

  deploy:
    needs: build
    runs-on: [self-hosted, hashicorp-lab]   # dentro da VNet
    # só ele alcança o IP privado do Nomad (10.20.1.10:4646)
```

O motivo de dividir assim: **build não precisa de rede privada**, só
alcançar o ghcr.io (público, TLS válido) — então roda de graça (minutos
ilimitados em repo público, um bom volume grátis mesmo em privado) num
runner hospedado pelo GitHub, sem consumir CPU/disco de nenhuma VM do
lab. Só o passo de **deploy** (`nomad job run`) exige estar dentro da
VNet, e esse continua no runner self-hosted. Isso tirou uma carga real
do `vm-control-01`, que antes rodava os 6 runners (um por repo)
fazendo build inteiro de cada app.

Login no ghcr.io usa o `GITHUB_TOKEN` automático do próprio workflow —
nenhum PAT próprio pra gerenciar nesse passo (diferente da era Harbor,
que exigia uma senha guardada como secret). Ver [Registry de
imagens](09-harbor) pra essa migração completa.

## Runner self-hosted (o que ainda existe)

- Um **runner self-hosted por repositório** (conta pessoal do GitHub
  não compartilha runners entre repos), rodando como container Docker
  (`myoung34/github-runner`) numa das VMs do lab.
- Registro via **`ACCESS_TOKEN`** (Personal Access Token), não o
  `RUNNER_TOKEN` efêmero que a interface do GitHub oferece — o
  `RUNNER_TOKEN` expira em pouco tempo; se o container do runner
  reiniciar (por exemplo, depois de um `docker daemon restart`) com um
  token já expirado, ele não re-registra e fica offline. O `ACCESS_TOKEN`
  deixa o próprio entrypoint da imagem gerar um `RUNNER_TOKEN` novo a
  cada start, então o runner sobrevive a restarts do Docker.
- Repos que só sobem imagens **públicas** (Prometheus, Loki, Tempo,
  Grafana, no repo `monitoring-stack`) nem precisam do job `build` —
  só `nomad job validate` + `nomad job run` de cada `.nomad.hcl`, tudo
  no runner self-hosted mesmo.
- `NOMAD_ADDR` aponta pro IP privado de um control-plane
  (`http://10.20.1.10:4646`) — o runner, rodando dentro da própria VNet,
  fala direto com a API do Nomad sem passar pelo Traefik.

## Fazendo manualmente

Registrar um runner self-hosted à mão (o que o `docker run
myoung34/github-runner` automatiza):

```bash
# Na página Settings > Actions > Runners > New self-hosted runner do repo,
# o GitHub mostra um RUNNER_TOKEN efêmero (~1h de validade)
mkdir actions-runner && cd actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.336.0/actions-runner-linux-x64-2.336.0.tar.gz
tar xzf runner.tar.gz

./config.sh --url https://github.com/W4lff/tasks-app \
  --token <RUNNER_TOKEN-da-tela> \
  --labels hashicorp-lab

./run.sh   # fica escutando jobs
```

Gerar um `RUNNER_TOKEN` novo via API, usando um PAT (é isso que a imagem
`myoung34/github-runner` faz sozinha quando você dá um `ACCESS_TOKEN` a
ela):

```bash
curl -s -X POST \
  -H "Authorization: token <SEU_PAT>" \
  https://api.github.com/repos/W4lff/tasks-app/actions/runners/registration-token \
  | jq -r .token
```

Rodar o runner como container (o padrão real usado neste lab):

```bash
docker run -d --name gh-runner-tasks-app \
  --restart unless-stopped \
  -e REPO_URL=https://github.com/W4lff/tasks-app \
  -e ACCESS_TOKEN=<SEU_PAT> \
  -e RUNNER_NAME=vm-control-01 \
  -e LABELS=self-hosted,hashicorp-lab \
  -v /var/run/docker.sock:/var/run/docker.sock \
  myoung34/github-runner:latest
```

Disparar manualmente o mesmo deploy que o CI faz, direto da linha de
comando (útil pra testar antes de dar push — foi assim que boa parte
dos bugs deste lab foi corrigida antes de virar commit):

```bash
nomad job validate meu-job.nomad.hcl
nomad job run -detach meu-job.nomad.hcl
```
