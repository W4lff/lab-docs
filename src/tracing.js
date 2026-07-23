const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");

// Nome do serviço vem do env OTEL_SERVICE_NAME (detectado automaticamente
// pelo SDK) — mesmo padrão do tasks-api, evita depender da API de Resource
// que muda de versão pra versão do @opentelemetry/resources.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
