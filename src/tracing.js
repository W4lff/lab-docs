const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");

// Instrumentações específicas em vez do pacote auto-instrumentations-node
// (mesmo motivo do tasks-api): aquele mega-pacote embala detector de
// recurso pra GCP que arrasta uma cadeia de dependência vulnerável sem
// fix disponível upstream (gcp-metadata -> gaxios -> rimraf -> glob ->
// minimatch -> brace-expansion, GHSA-mh99-v99m-4gvg), e este app nunca
// roda no GCP mesmo.
//
// Nome do serviço vem do env OTEL_SERVICE_NAME (detectado automaticamente
// pelo SDK) — evita depender da API de Resource, que muda de versão pra
// versão do @opentelemetry/resources.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();

process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
