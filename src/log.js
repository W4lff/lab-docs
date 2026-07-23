const { trace } = require("@opentelemetry/api");

// Injeta trace_id/span_id (do span ativo do OpenTelemetry) em todo log
// estruturado — é isso que permite, no Grafana, ir de uma linha de log
// no Loki direto pro trace correspondente no Tempo (e vice-versa, via
// o tracesToLogsV2 configurado no datasource do Tempo).
function log(msg, extra = {}) {
  const span = trace.getActiveSpan();
  const ctx = span && span.spanContext();
  const entry = {
    level: "info",
    msg,
    time: new Date().toISOString(),
    ...(ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {}),
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

module.exports = { log };
