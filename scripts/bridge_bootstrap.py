#!/usr/bin/env python3
"""
Dump bridge drawers to JSONL for the bridge adapter bootstrap.

Usage:
    python bridge_bootstrap.py <palace_path> [--limit N] [--collection lmg_bridge_drawers]

Emits one JSON object per line to stdout:
    {"id": "<drawer_id>", "document": "<content>", "metadata": {...}}

Exits non-zero on any error. Intended to be called from Node via execa by
the bridge adapter.
"""

import argparse
import json
import sys

def main() -> int:
    parser = argparse.ArgumentParser(description="Dump bridge drawers as JSONL.")
    parser.add_argument("palace_path", help="Path to the external palace dir.")
    parser.add_argument("--limit", type=int, default=500, help="Max drawers to dump.")
    parser.add_argument("--collection", default="lmg_bridge_drawers", help="ChromaDB collection name.")
    parser.add_argument("--offset", type=int, default=0, help="Skip first N drawers.")
    parser.add_argument("--where", default=None, help="Optional JSON where-clause for chroma.")
    args = parser.parse_args()

    try:
        import chromadb
    except ImportError:
        print("chromadb not installed; install your bridge deps or run pip install chromadb", file=sys.stderr)
        return 2

    try:
        client = chromadb.PersistentClient(path=args.palace_path)
    except Exception as e:
        print(f"failed to open palace at {args.palace_path}: {e}", file=sys.stderr)
        return 3

    try:
        col = client.get_collection(args.collection)
    except Exception as e:
        print(f"collection '{args.collection}' not found in palace: {e}", file=sys.stderr)
        return 4

    where = json.loads(args.where) if args.where else None

    try:
        get_kwargs = {
            "limit": args.limit,
            "offset": args.offset,
            "include": ["documents", "metadatas"],
        }
        if where is not None:
            get_kwargs["where"] = where
        result = col.get(**get_kwargs)
    except Exception as e:
        print(f"failed to fetch drawers: {e}", file=sys.stderr)
        return 5

    ids = result.get("ids", [])
    documents = result.get("documents", []) or []
    metadatas = result.get("metadatas", []) or []

    count = 0
    for i, drawer_id in enumerate(ids):
        doc = documents[i] if i < len(documents) else ""
        md = metadatas[i] if i < len(metadatas) else {}
        try:
            sys.stdout.write(json.dumps({
                "id": drawer_id,
                "document": doc,
                "metadata": md or {},
            }, ensure_ascii=False))
            sys.stdout.write("\n")
            count += 1
        except (OSError, ValueError) as e:
            # Bad data in a single drawer should not kill the whole dump.
            print(f"skipped drawer {drawer_id}: {e}", file=sys.stderr)

    print(f"dumped {count} drawers from {args.palace_path} (collection={args.collection})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
