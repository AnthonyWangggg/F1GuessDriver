"""Inspect a runtime tar before extraction; never writes to the archive."""

import argparse
import tarfile


def name_parts(value):
    if "\\" in value or value.startswith("/") or ".." in value.split("/"):
        raise ValueError(f"unsafe archive member: {value}")
    return tuple(part for part in value.split("/") if part not in ("", "."))


def link_parts(path, target):
    if not target or target.startswith("/") or "\\" in target:
        raise ValueError(f"unsafe link at {path}")
    result = list(path[:-1])
    entered = False
    for part in target.split("/"):
        if part == "..":
            if entered or not result:
                raise ValueError(f"unsafe parent traversal in link at {path}")
            result.pop()
        elif part not in ("", "."):
            entered = True
            result.append(part)
    return tuple(result)


def inspect(archive, arch):
    machine = {"x86_64": 62, "aarch64": 183}[arch]
    members, links = {}, {}
    modules = 0
    with tarfile.open(archive, "r:gz") as tar:
        for entry in tar:
            path = name_parts(entry.name)
            if not path and not entry.isdir():
                raise ValueError("archive root must be a directory")
            if path in members:
                raise ValueError(f"duplicate path: {entry.name}")
            if any(part == ".env" or (part.startswith(".env.") and part != ".env.example")
                   or part in ("local-private", "local-archive", "test-results", "diagnostic-overlay")
                   or part.endswith((".pem", ".key", ".f1backup")) for part in path):
                raise ValueError(f"private material: {entry.name}")
            if path[:2] == ("deploy", "local") or (path[:3] == ("apps", "server", "dist")
                    and any(".spec." in part for part in path)):
                raise ValueError(f"test or local deployment material: {entry.name}")
            if entry.issym():
                links[path] = link_parts(path, entry.linkname)
            elif not entry.isfile() and not entry.isdir():
                raise ValueError(f"unsupported archive entry: {entry.name}")
            elif entry.isfile() and entry.name.endswith(".node"):
                with tar.extractfile(entry) as native:
                    header = native.read(20)
                if len(header) != 20 or header[:6] != b"\x7fELF\x02\x01" or int.from_bytes(header[18:20], "little") != machine:
                    raise ValueError(f"wrong native module architecture: {entry.name}")
                modules += 1
            members[path] = entry.isdir()
    for path in members:
        for length in range(1, len(path)):
            if not members.get(path[:length], False):
                raise ValueError(f"member parent is missing or not a directory: {path}")
    for path, target in links.items():
        seen = {path}
        while target in links:
            if target in seen:
                raise ValueError(f"symlink cycle: {path}")
            seen.add(target)
            target = links[target]
        if target not in members:
            raise ValueError(f"dangling link: {path}")
    for entry in [("apps", "server", "dist", "index.js"), ("apps", "web", "dist", "index.html")]:
        if members.get(entry) is not False or entry in links:
            raise ValueError(f"missing regular runtime entry: {entry}")
    return len(members), len(links), modules


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("archive")
    cli.add_argument("--arch", required=True, choices=("x86_64", "aarch64"))
    args = cli.parse_args()
    entries, links, modules = inspect(args.archive, args.arch)
    print(f"ARCHIVE_PASS entries={entries} links={links} native_modules={modules}")
