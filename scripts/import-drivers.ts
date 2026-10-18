import { JolpicaClient } from './lib/api.js'
import { importCatalog } from './lib/importer.js'
import { main, withImport } from './lib/runtime.js'

main(() => withImport((context) => importCatalog(context, new JolpicaClient())))
