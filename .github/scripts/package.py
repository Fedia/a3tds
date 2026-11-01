"""Package existing sources on a GitHub-hosted runner; no build or downloads."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "dist"
EXCLUDED = {".git", "dist", "__pycache__", ".DS_Store"}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def local_file(relative):
    path = (ROOT / relative).resolve()
    if not path.is_relative_to(ROOT) or not path.is_file():
        raise ValueError(f"Missing or unsafe extension resource: {relative}")
    return path


def package():
    manifest = json.loads(local_file("manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise ValueError("Expected Manifest V3")
    for relative in [
        manifest["background"]["service_worker"],
        manifest["side_panel"]["default_path"],
        *manifest["sandbox"]["pages"],
        "workspace.html", "src/python-worker.js",
    ]:
        local_file(relative)

    # Use the checked-in official runtime only; never download dependencies in CI.
    vendor = ROOT / "vendor" / "pyodide"
    for line in (vendor / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        expected, name = line.split("  ", 1)
        if sha256(local_file(f"vendor/pyodide/{name}").read_bytes()) != expected:
            raise ValueError(f"Vendor checksum mismatch: {name}")
    lock = json.loads((vendor / "pyodide-lock.json").read_text(encoding="utf-8"))
    packages = json.loads((vendor / "PACKAGES.json").read_text(encoding="utf-8"))
    for name, info in packages.items():
        wheel = local_file(f"vendor/pyodide/{info['file_name']}")
        if sha256(wheel.read_bytes()) != lock["packages"][name]["sha256"]:
            raise ValueError(f"Official wheel checksum mismatch: {name}")
        if any(dependency not in packages for dependency in info["depends"]):
            raise ValueError(f"Incomplete dependencies: {name}")

    files = []
    for path in sorted(ROOT.rglob("*")):
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDED for part in relative.parts):
            continue
        if path.is_symlink():
            raise ValueError(f"Symlink is not allowed: {relative}")
        if path.is_file() and relative.as_posix() != "CHECKSUMS.sha256":
            files.append((relative.as_posix(), path.read_bytes()))
    checksums = "".join(f"{sha256(data)}  {name}\n" for name, data in files)
    files.append(("CHECKSUMS.sha256", checksums.encode("utf-8")))

    DIST.mkdir(exist_ok=True)
    archive = DIST / "psy-agent.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for name, data in files:
            entry = zipfile.ZipInfo(f"psy-agent/{name}", date_time=(1980, 1, 1, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(entry, data)
    with zipfile.ZipFile(archive) as output:
        if output.testzip() is not None:
            raise ValueError("ZIP integrity check failed")
    (DIST / "psy-agent.zip.sha256").write_text(
        f"{sha256(archive.read_bytes())}  psy-agent.zip\n", encoding="utf-8"
    )
    print(f"Packaged {len(files)} files: {archive.name} ({archive.stat().st_size} bytes)")


if __name__ == "__main__":
    package()
