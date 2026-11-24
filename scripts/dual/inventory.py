"""Read-only inspection of the legacy deployment and candidate STG/PROD resources."""

import json
from pathlib import Path
import re
import subprocess
import sys

import release as ops
from legacy_inventory import metadata


def main(args):
    ops.require(len(args) == 2 and args[0] == "--observe" and args[1].isdigit(),
                "Usage: f1-dual-inventory --observe POSTGRES_PORT")
    port = int(args[1])
    ops.require(1024 <= port <= 65535, "Invalid cluster port")
    previous = ops.run(sys.executable, "-EsB", str(Path(__file__).with_name("legacy_inventory.py")),
                       "--observe", stdout=subprocess.PIPE)
    result = json.loads(previous.stdout)
    for name, info in list(result["paths"].items()):
        if name.startswith("/etc/nginx/sites-enabled/") and info.get("link"):
            target = Path(name).resolve(strict=True)
            ops.require(target.parent == Path("/etc/nginx/sites-available"),
                        f"Review unusual legacy Nginx target: {target}")
            result["paths"][str(target)] = metadata(target)
    result["candidatePaths"] = {str(path): metadata(path) for path in (
        ops.ROOT, ops.ETC, Path("/opt/f1-dual-toolchain"), Path("/etc/systemd/system/f1-dual@.service"),
        Path("/etc/nginx/conf.d/f1-dual-stg.conf"), Path("/etc/nginx/conf.d/f1-dual-prod.conf"))}
    result["listeners"] = ops.run("ss", "-ltnp", stdout=subprocess.PIPE, text=True).stdout.splitlines()
    nginx = ops.run("nginx", "-T", stdout=subprocess.PIPE, text=True).stdout
    result["nginxServerNames"] = re.findall(r"(?m)^\s*server_name\s+([^;]+);", nginx)
    result["databaseCatalog"] = json.loads(ops.sql(port, "postgres", """
       SELECT json_build_object(
         'databases',(SELECT json_agg(json_build_object('name',datname,'oid',oid,'owner',pg_get_userbyid(datdba)))
             FROM pg_database WHERE datname IN ('f1guess_prod','f1dg3_stg','f1dg3_prod')),
         'roleDependencies',(SELECT json_agg(json_build_object('role',rolname,'databaseOid',dbid,'type',deptype))
             FROM pg_shdepend JOIN pg_roles ON refobjid=pg_roles.oid
             WHERE refclassid='pg_authid'::regclass AND (rolname LIKE 'f1guess%' OR rolname LIKE 'f1dg3%')),
         'connections',(SELECT json_agg(json_build_object('db',datname,'role',usename,'count',connections))
             FROM (SELECT datname,usename,count(*) connections FROM pg_stat_activity
               WHERE datname IN ('f1guess_prod','f1dg3_stg','f1dg3_prod') GROUP BY datname,usename) active));
    """))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"Inventory stopped: {error}", file=sys.stderr)
        sys.exit(1)
