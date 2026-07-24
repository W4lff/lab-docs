---
title: Registry de imagens — do Harbor ao ghcr.io
order: 9
---

# Registry de imagens: do Harbor ao ghcr.io

Este lab rodou seu próprio registry (Harbor) por um tempo, e depois
migrou pra usar o **GitHub Container Registry (ghcr.io)**. As duas
fases valem documentar — a primeira ensina como um registry privado
funciona por baixo dos panos; a segunda é o que está rodando hoje.

## Fase 1 — Harbor (decomissionado)

- VM dedicada (`vm-registry-01`), separada de tudo o resto pelo mesmo
  motivo do node pool de monitoring: um problema de disco/CPU no
  registry não podia derrubar apps já rodando.
- Instalado via o instalador oficial (`install.sh`), não um job Nomad —
  era infraestrutura de suporte ao cluster, não uma aplicação dele.
- Sem certificado TLS válido — todo Docker daemon do lab precisava de
  `insecure-registries` configurado via Ansible.
- **Por que saiu**: builda-e-push acontecia sempre no runner
  self-hosted (só ele enxergava o Harbor, que vivia dentro da VNet
  privada) — nenhuma vantagem de usar um runner hospedado pelo GitHub
  pra essa etapa. E manter um registry próprio de pé (patch, disco,
  backup) é trabalho contínuo pra um lab de aprendizado que já tinha
  aprendido a lição que o Harbor vinha ensinar.
- **Um vazamento real aconteceu aqui**: o `harbor.yml` do repo de
  deploy tinha a senha de admin e a senha do banco interno **em texto
  puro**, commitadas. Foram descobertas numa varredura de segurança,
  a senha de admin foi rotacionada na hora (confirmado que a antiga
  parou de autenticar) via API do próprio Harbor, e o repositório
  inteiro foi apagado do GitHub depois que a VM saiu de cena — não dava
  pra "desfazer" o commit do passado, então a solução foi não deixar
  esse passado existir mais.

## Fase 2 — ghcr.io (atual)

Todo app que builda imagem (loja, blog, tasks-api, tasks-front,
lab-docs) usa hoje o **GitHub Container Registry**, com um pipeline
**híbrido**:

```
build+push  → runner hospedado pelo GitHub (ubuntu-latest)
deploy       → runner self-hosted (só ele alcança a rede privada do Nomad)
```

O motivo de dividir assim: o build não precisa de rede privada
nenhuma, só de alcançar o ghcr.io (público). Só o passo de `nomad job
run` exige estar dentro da VNet. Ver [GitHub Actions](08-github-actions)
pro detalhe do workflow.

- Login no `ghcr.io` usa o `GITHUB_TOKEN` automático do próprio
  workflow (`secrets.GITHUB_TOKEN`) — nenhuma senha própria pra
  gerenciar, ao contrário do Harbor.
- TLS válido de fábrica — acabou o hack de `insecure-registries` nos
  workers.
- **Repositório público vs privado muda tudo**: se o repo do app é
  público (caso do `lab-docs`), a imagem no ghcr.io nasce pública e os
  workers puxam sem credencial nenhuma. Se o repo é privado (caso de
  `ecommerce-demo`, `blog-demo`, `tasks-app`), a imagem nasce **privada**,
  e cada worker precisa de `docker login ghcr.io` configurado — feito
  via Ansible, com um PAT (`read:packages`) guardado fora do repo
  (`group_vars/nomad_clients.yml`, gitignored).
- **Pegadinha real que apareceu aqui**: configurar `docker login` na
  VM não é suficiente. O driver Docker do **Nomad** fala com o daemon
  via API própria, não via `docker` CLI — ele não lê
  `/root/.docker/config.json` sozinho, mesmo rodando como root. Precisa
  apontar explicitamente pro arquivo:
  ```hcl
  plugin "docker" {
    config {
      auth {
        config = "/root/.docker/config.json"
      }
    }
  }
  ```
  Sem isso, todo pull de imagem privada falha com `unauthorized`
  mesmo com o login já feito na VM.

## Fazendo manualmente

Build, login e push pro ghcr.io (o que o runner hospedado faz):

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u SEU_USUARIO --password-stdin

docker build -t ghcr.io/SEU_USUARIO/minha-app:v1 .
docker push ghcr.io/SEU_USUARIO/minha-app:v1
```

Gerar um PAT classic com escopo `read:packages` (o que precisa existir
pra puxar imagem privada, feito uma vez em
`github.com/settings/tokens`), e autenticar um host que só *consome*
imagem (o que o Ansible faz em cada worker):

```bash
echo "$PAT_READ_PACKAGES" | docker login ghcr.io -u SEU_USUARIO --password-stdin
```

Verificar se o Nomad realmente está lendo essas credenciais (o comando
mais direto pra depurar um "unauthorized" que já tem login feito na
VM):

```bash
cat /root/.docker/config.json   # a credencial está aqui?
nomad agent-info | grep -A5 docker   # o plugin carregou o auth.config?
```

Testar visibilidade de um pacote no ghcr.io sem nenhuma credencial (pra
confirmar se está público ou privado):

```bash
docker pull ghcr.io/SEU_USUARIO/minha-app:latest
# "unauthorized" ou "denied" = privado; baixa normal = público
```

Rotacionar uma senha vazada no Harbor, se algo assim acontecer de novo
em outra ferramenta (o comando usado quando a senha do Harbor vazou
aqui):

```bash
curl -u admin:SENHA_ANTIGA -X PUT \
  "http://SEU_HARBOR/api/v2.0/users/1/password" \
  -H "Content-Type: application/json" \
  -d '{"old_password":"SENHA_ANTIGA","new_password":"SENHA_NOVA"}'
```
