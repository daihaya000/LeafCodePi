#!/usr/bin/env python3
"""Install the optional local English-to-Japanese translation runtime."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import venv
from pathlib import Path


def run(args: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(args, check=True, env=env)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    data_dir = Path(args.data_dir).resolve()
    root = data_dir / "translation"
    venv_dir = root / "venv"
    packages_dir = root / "packages"
    packages_dir.mkdir(parents=True, exist_ok=True)

    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11 or newer is required")
    if not venv_dir.exists():
        venv.EnvBuilder(with_pip=True, clear=False).create(venv_dir)

    python = venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(Path(__file__).with_name("requirements.txt"))])
    run([str(python), "-c", """
import argostranslate.package
argostranslate.package.update_package_index()
packages = argostranslate.package.get_available_packages()
pkg = next((p for p in packages if p.from_code == 'en' and p.to_code == 'ja'), None)
if pkg is None:
    raise SystemExit('English-to-Japanese model is unavailable')
pkg.install()
"""], env={**os.environ, "ARGOS_PACKAGES_DIR": str(packages_dir)})
    print("Local translation is installed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
