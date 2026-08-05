const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Nombre total de requetes HTTP servies',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duree des requetes HTTP en secondes',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const tasksCreatedTotal = new client.Counter({
  name: 'tasks_created_total',
  help: 'Nombre de taches creees depuis le demarrage',
  registers: [register],
});

// req.route n'existe que si Express a trouve une route qui matche : le
// label reste un pattern ("/api/tasks/:id"), jamais l'id reel, et une 404
// sur une route inconnue tombe dans un seau "unmatched" borne plutot que
// de disparaitre.
function routeLabel(req) {
  if (req.route) {
    const path = req.route.path === '/' ? '' : req.route.path;
    return (req.baseUrl || '') + path || '/';
  }
  return 'unmatched';
}

function metricsMiddleware(req, res, next) {
  const stop = httpRequestDurationSeconds.startTimer();

  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status: res.statusCode,
    };
    httpRequestsTotal.inc(labels);
    stop(labels);
  });

  next();
}

module.exports = { register, metricsMiddleware, tasksCreatedTotal };
