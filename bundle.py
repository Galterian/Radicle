"""Pack every data/*.json file into one bundle.

Shape of the output:
    {
      "schema_version": "0.2.0",
      "bundled_at": "<ISO date>",
      "source_dir": "data",
      "load_order": [...],              # from data/index.json if present
      "collections": {                  # one entry per bundled file
        "<id>": {
          "file": "<name>.json",
          "entry_count": N,             # len(entries) if it is a collection file
          "data": <full file contents>
        },
        ...
      }
    }

Usage (Windows, run from the project root):
    PYTHONIOENCODING=utf-8 python bundle.py
    PYTHONIOENCODING=utf-8 python bundle.py --out dist/bundle.json
"""
import argparse
import datetime
import json
import pathlib
import sys


def collection_id(data: dict, filename: str) -> str:
    """Prefer the file's own `collection` or `id` field, fall back to the filename stem."""
    if isinstance(data, dict):
        for key in ("collection", "id", "name"):
            if isinstance(data.get(key), str):
                return data[key]
    return pathlib.Path(filename).stem


def main() -> int:
    ap = argparse.ArgumentParser(description="Bundle data/*.json into a single JSON.")
    ap.add_argument("--data", default="data", help="source directory (default: data)")
    ap.add_argument("--out", default="dimensions-bundle.json", help="output path")
    ap.add_argument("--pretty", action="store_true", help="indent output (bigger file, easier to diff)")
    ap.add_argument("--exclude", nargs="*", default=[], help="filenames to skip")
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent
    data_dir = (root / args.data).resolve()
    if not data_dir.is_dir():
        print(f"error: {data_dir} is not a directory", file=sys.stderr)
        return 2

    skip = set(args.exclude) | {pathlib.Path(args.out).name}
    files = sorted(p for p in data_dir.glob("*.json") if p.name not in skip)
    if not files:
        print(f"error: no .json files found in {data_dir}", file=sys.stderr)
        return 2

    # Pull load_order from index.json so the engine can replay the bundle in the right order.
    load_order = []
    schema_version = None
    index_path = data_dir / "index.json"
    if index_path.exists():
        try:
            idx = json.loads(index_path.read_text(encoding="utf-8"))
            load_order = list(idx.get("load_order_for_engine") or [])
            schema_version = idx.get("schema_version")
        except Exception as exc:
            print(f"warn: could not parse index.json ({exc})", file=sys.stderr)

    collections = {}
    for p in files:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"error: {p.name} is not valid JSON ({exc})", file=sys.stderr)
            return 2
        cid = collection_id(data, p.name)
        entry_count = len(data["entries"]) if isinstance(data, dict) and isinstance(data.get("entries"), list) else None
        collections[cid] = {
            "file": p.name,
            "entry_count": entry_count,
            "data": data,
        }

    bundle = {
        "schema_version": schema_version or "unknown",
        "bundled_at": datetime.date.today().isoformat(),
        "source_dir": args.data,
        "load_order": load_order,
        "collections": collections,
    }

    out_path = (root / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        if args.pretty:
            json.dump(bundle, fh, indent=2, ensure_ascii=False)
        else:
            json.dump(bundle, fh, separators=(",", ":"), ensure_ascii=False)

    size = out_path.stat().st_size
    unit = "B"
    size_h = float(size)
    for u in ("B", "KB", "MB"):
        if size_h < 1024:
            unit = u
            break
        size_h /= 1024
    print(f"bundled {len(collections)} collections -> {out_path} ({size_h:.1f} {unit})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
