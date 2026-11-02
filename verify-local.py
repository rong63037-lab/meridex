#!/usr/bin/env python3
"""Check that the customer site and the admin console are split."""
import sys
import urllib.error
import urllib.request

CUSTOMER = "http://127.0.0.1:4317"
ADMIN = "http://127.0.0.1:4318"
POOL = "http://127.0.0.1:4319"
GATEWAY = "http://127.0.0.1:7108"


def get(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            return res.status, res.read(8000).decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read(8000).decode("utf-8", "replace")


def main() -> int:
    checks = []

    def expect(name: str, ok: bool, detail: str) -> None:
        checks.append((ok, name, detail))
        print(("ok  " if ok else "FAIL") + f" {name} {detail}")

    status, body = get(CUSTOMER + "/")
    expect("customer home", status == 200 and "MERIDEX" in body, f"{status}")
    status, body = get(ADMIN + "/login")
    expect("admin login", status == 200 and "MERIDEX ADMIN" in body, f"{status}")
    status, body = get(CUSTOMER + "/admin")
    expect("customer hides /admin", status == 404, f"{status}")
    status, body = get(CUSTOMER + "/api/admin/users")
    expect("customer proxy blocks admin api", status == 404 and "NOT_FOUND" in body, f"{status} {body[:80]}")
    status, body = get(ADMIN + "/api/orders")
    expect("admin proxy blocks customer api", status == 404 and "NOT_FOUND" in body, f"{status} {body[:80]}")
    status, body = get(POOL + "/login")
    expect("address desk", status == 200 and "地址" in body, f"{status}")
    status, body = get(POOL + "/api/admin/treasury/pool")
    expect("address desk blocks admin api", status == 404 and "NOT_FOUND" in body, f"{status} {body[:80]}")
    status, body = get(ADMIN + "/api/pool/treasury/pool")
    expect("admin blocks address api", status == 404 and "NOT_FOUND" in body, f"{status} {body[:80]}")
    status, _ = get(GATEWAY + "/healthz")
    expect("gateway", status == 200, f"{status}")

    failed = [row for row in checks if not row[0]]
    print(f"verify={len(checks) - len(failed)}/{len(checks)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
