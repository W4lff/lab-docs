---
title: Esteira DevSecOps
order: 14
---

# Esteira DevSecOps

Todo repo de aplicação deste lab passou a usar um **workflow reusável
único** (`gh-actions-templates`) em vez de reimplementar a mesma
esteira de build em cada repo. A motivação foi dupla: parar de repetir
YAML, e colocar segurança de verdade no meio do caminho — não só
"builda e sobe".

## O que a esteira faz, em ordem

```
checkout
  → secret scan (gitleaks)
  → auditoria de dependências (npm audit)     [se o app tem package.json]
  → SAST (CodeQL, JavaScript/TypeScript)       [se o app tem package.json]
  → testes + cobertura                        [se o app tem package.json]
  → docker build
  → scan de vulnerabilidade da imagem (Trivy)
  → SBOM (inventário da imagem, formato SPDX)
  → docker push (só se tudo acima passou)
```

Cada etapa **derruba o build** se achar algo — não é relatório
informativo, é gate de verdade. Isso importa: foi rodando essa esteira
pela primeira vez em cada repo que apareceram os problemas reais
descritos abaixo.

## Bugs e vulnerabilidades reais encontradas montando isso

Vale registrar porque são exatamente o tipo de coisa que uma esteira
dessas existe pra pegar:

1. **`aquasecurity/trivy-action@0.28.0` não existe** — a tag correta
   tem um `v` na frente (`v0.28.0`). E essa versão específica tinha uma
   dependência interna quebrada (`aquasecurity/setup-trivy@v0.2.1`,
   também inexistente) — precisou pular pra uma versão mais nova
   (`v0.36.0`).

2. **`npm audit` achou uma vulnerabilidade HIGH real** no `tasks-api` e
   no `lab-docs`: o pacote `@opentelemetry/auto-instrumentations-node`
   empacota detectores de recurso pra GCP/AWS/Azure/Alibaba Cloud — e o
   detector do GCP arrasta uma cadeia de dependência vulnerável
   (`gcp-metadata` → `gaxios` → `rimraf` → `glob` → `minimatch` →
   `brace-expansion`, [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg))
   sem correção disponível upstream. Nenhuma das duas aplicações roda
   no GCP. A correção real foi trocar o pacote mega-bundle pelas
   instrumentações específicas de fato usadas (`instrumentation-http`,
   `instrumentation-express`, `instrumentation-pg`), eliminando a
   dependência problemática pela raiz em vez de esperar um fix que não
   existe.

3. **O scan de imagem (Trivy) achou CVEs que não eram da aplicação**:
   `glob`, `minimatch`, `tar`, `sigstore`, `cross-spawn` apareceram como
   vulneráveis dentro da imagem final — mas investigando, esses pacotes
   viviam em `/usr/local/lib/node_modules/npm`, o **npm global embutido
   na própria imagem base** `node:20-alpine`, não nas dependências da
   aplicação. Como o container só roda `node` em produção (nunca
   `npm`), a correção foi remover o npm global da imagem final depois
   de instalar as dependências:
   ```dockerfile
   RUN npm install --omit=dev \
       && rm -rf /usr/local/lib/node_modules/npm
   ```
   Esse é um padrão que vale lembrar pra qualquer imagem Node: o scan
   de vulnerabilidade de imagem, ao contrário do `npm audit`, enxerga
   **tudo** que está na imagem, inclusive ferramentas de build que
   nunca deveriam ter ido pra produção.

4. **Gitleaks com fingerprint instável**: por padrão o gitleaks escaneia
   o **histórico de commits** (`git log`), e o fingerprint de cada
   achado inclui o SHA do commit. Só que `actions/checkout` faz clone
   raso por padrão (profundidade 1) — cada push só tem *um* commit
   disponível (o próprio), e o SHA dele muda a cada push. Resultado: um
   `.gitleaksignore` pra um falso positivo funcionava uma vez e
   invalidava sozinho no push seguinte. Correção: rodar com `--no-git`
   (escaneia o conteúdo do checkout, não o histórico) — o fingerprint
   vira só `arquivo:regra:linha`, estável entre commits. Auditoria de
   histórico completo é trabalho forense pontual (foi feita manualmente
   uma vez, ver [Registry de imagens](09-harbor)), não algo pra repetir
   a cada push.

## GitHub nativo: o que dá pra ligar sem esforço

Além da esteira em si, dá pra habilitar por API/configuração do
repositório (sem escrever workflow nenhum):

- **Secret scanning + push protection** — bloqueia o próprio `git push`
  se detectar um padrão de segredo conhecido (tokens de provedores
  como AWS/GCP/Stripe/etc). **Só funciona de graça em repositório
  público** — em privado exige GitHub Advanced Security (plano pago).
  Ligado nos dois repos públicos deste lab (`lab-docs`,
  `gh-actions-templates`); nos privados, o gitleaks do workflow cobre
  o mesmo caso de uso sem depender de licença.
- **Dependabot alerts** + **Dependabot security updates** — esses
  **funcionam em qualquer repositório**, público ou privado, sem
  licença nenhuma. Alerta quando uma dependência do `package.json` tem
  vulnerabilidade conhecida, e abre PR automático com a correção.
  Ligado em todos os 7 repositórios do lab.

## Fazendo manualmente

Rodar gitleaks localmente, do jeito que o workflow roda (conteúdo do
checkout, não histórico):

```bash
docker run --rm -v "$(pwd)":/repo -w /repo zricethezav/gitleaks:latest \
  detect --source . --no-git --redact -v
```

Ignorar um achado específico que é falso positivo (sem desabilitar o
scan inteiro):

```bash
# o "Fingerprint:" aparece na saída do comando acima
echo "arquivo.md:regra:linha" >> .gitleaksignore
```

Auditar dependências e ver exatamente a cadeia de um pacote vulnerável
(o comando usado pra achar a raiz do problema do `gcp-metadata`):

```bash
npm audit --audit-level=high
npm ls gcp-metadata   # mostra quem depende de quem até a raiz
```

Escanear uma imagem já construída (o mesmo comando do workflow, rodado
localmente antes de dar push — evita descobrir o problema só depois
que o CI já rodou):

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image --severity CRITICAL,HIGH --ignore-unfixed \
  minha-imagem:latest
```

Gerar um SBOM manualmente:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  anchore/syft:latest minha-imagem:latest -o spdx-json > sbom.json
```

Habilitar Dependabot alerts num repositório via API (o que foi feito
em todos os repos deste lab):

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DONO/REPO/vulnerability-alerts
```
