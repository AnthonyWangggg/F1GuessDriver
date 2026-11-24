#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test "$(id -u)" = 0
install -d -m 0755 /usr/local/lib/f1-dual
install -d -m 0711 /etc/f1-dual
for file in release bootstrap isolate inventory first_prod; do
  install -o root -g root -m 0644 "$root/scripts/dual/$file.py" /usr/local/lib/f1-dual/
done
printf '#!/bin/sh\nexec /usr/bin/python3 -EsB /usr/local/lib/f1-dual/first_prod.py "$@"\n' > /usr/local/sbin/f1-dual-first-prod.next
chown root:root /usr/local/sbin/f1-dual-first-prod.next
chmod 0755 /usr/local/sbin/f1-dual-first-prod.next
mv -fT /usr/local/sbin/f1-dual-first-prod.next /usr/local/sbin/f1-dual-first-prod
install -o root -g root -m 0644 "$root/scripts/fresh-deploy/inventory.py" /usr/local/lib/f1-dual/legacy_inventory.py
install -o root -g root -m 0644 "$root/scripts/fresh-deploy/check-linux-archive.py" /usr/local/lib/f1-dual/
for file in build.sh f1-dual@.service nginx.conf.example; do
  install -o root -g root -m 0644 "$root/deploy/dual/$file" /usr/local/lib/f1-dual/
done
for command in release bootstrap inventory; do
  printf '#!/bin/sh\nexec /usr/bin/python3 -EsB /usr/local/lib/f1-dual/%s.py "$@"\n' "$command" > "/usr/local/sbin/f1-dual-$command.next"
  chown root:root "/usr/local/sbin/f1-dual-$command.next"
  chmod 0755 "/usr/local/sbin/f1-dual-$command.next"
  mv -fT "/usr/local/sbin/f1-dual-$command.next" "/usr/local/sbin/f1-dual-$command"
done
cat > /usr/local/sbin/f1-dual-bootstrap-build.next <<'EOF'
#!/bin/sh
test "$#" = 4 && test "$1" = build || exit 2
exec /usr/local/sbin/f1-dual-bootstrap "$@"
EOF
chown root:root /usr/local/sbin/f1-dual-bootstrap-build.next
chmod 0755 /usr/local/sbin/f1-dual-bootstrap-build.next
mv -fT /usr/local/sbin/f1-dual-bootstrap-build.next /usr/local/sbin/f1-dual-bootstrap-build
