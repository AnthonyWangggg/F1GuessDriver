// Original implementation, copyright WONTONANTI; see LICENSE.
// Fastify adds its own child/level interface when logging is disabled.
'use strict'
const logger = {}
for (const name of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
  logger[name] = function () {}
}
module.exports = logger
