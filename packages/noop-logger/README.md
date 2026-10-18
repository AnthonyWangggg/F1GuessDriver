# Original silent logger

Original six-method silent logging interface authored for this project, licensed under MIT by WONTONANTI. No upstream implementation was copied. Fastify supplies its disabled logger's `child` and `level` properties.

The private package retains the requested module name solely for dependency compatibility, with the distinct version `0.0.0-f1-original.1`. It is not an upstream release and must not be published as one.

The workspace override replaces the `abstract-logging` runtime dependency. It does not claim to license any release of that third-party package. Enabled Pino logging continues to use Pino.
