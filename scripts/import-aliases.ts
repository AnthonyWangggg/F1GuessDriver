import { importAliases } from './lib/aliases.js'
import { main, withImport } from './lib/runtime.js'

main(() => withImport(({ db }) => importAliases(db)))
