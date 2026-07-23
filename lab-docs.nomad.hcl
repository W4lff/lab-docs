variable "image_tag" {
  type    = string
  default = "latest"
}

job "lab-docs" {
  datacenters = ["dc1"]
  type        = "service"

  # count=2 + distinct_hosts: stateless (conteúdo é lido do próprio
  # container, sem banco), uma réplica por worker.
  group "lab-docs" {
    count = 2

    constraint {
      distinct_hosts = true
    }

    task "lab-docs" {
      driver = "docker"

      config {
        # ghcr.io em vez do Harbor: build roda no runner hospedado pelo
        # GitHub (ver .github/workflows/deploy.yml), então a imagem já
        # nasce lá — TLS válido, sem precisar de insecure-registries no
        # Docker dos workers.
        image        = "ghcr.io/w4lff/lab-docs:${var.image_tag}"
        network_mode = "host"
      }

      # Mesmo padrão de loja/blog/tasks-api: segredo vindo do Vault via
      # workload identity, nunca em texto no job ou no código.
      vault {
        role = "nomad-lab-docs"
      }

      env {
        OTEL_SERVICE_NAME           = "lab-docs"
        OTEL_EXPORTER_OTLP_ENDPOINT = "http://10.20.4.10:4318"
      }

      template {
        data        = <<-EOF
          {{ with secret "secret/data/lab-docs" }}
          {"greeting":"{{ .Data.data.greeting }}"}
          {{ end }}
        EOF
        destination = "local/vault-data.json"
      }

      service {
        name         = "lab-docs"
        port         = "8090"
        address_mode = "driver"
        tags = [
          "traefik.enable=true",
          "traefik.http.routers.lab-docs.rule=Host(`docs.lab.evalabs.com.br`)",
          "traefik.http.routers.lab-docs.entrypoints=web",
          "traefik.http.services.lab-docs.loadbalancer.server.port=8090",
        ]

        check {
          type         = "http"
          path         = "/healthz"
          port         = "8090"
          address_mode = "driver"
          interval     = "10s"
          timeout      = "2s"
        }
      }

      resources {
        cpu    = 150
        memory = 128
      }
    }
  }
}
