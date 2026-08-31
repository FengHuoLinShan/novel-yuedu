#!/usr/bin/env python3
"""从 src/background/ad-domains.js 读取域名列表，生成 rules/dnr-blocklist.json 静态规则。"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / "src/background/ad-domains.js").read_text(encoding="utf-8")
domains = re.findall(r'"([a-z0-9.*-]+\.[a-z.]+)"', src)

rules = []
for i, d in enumerate(domains, 1):
    rules.append({
        "id": i,
        "priority": 1,
        "action": {"type": "block"},
        "condition": {
            "urlFilter": f"||{d}^",
            "resourceTypes": ["script", "image", "sub_frame", "xmlhttprequest", "other", "media"],
        },
    })

out = ROOT / "rules/dnr-blocklist.json"
out.write_text(json.dumps(rules, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"generated {len(rules)} rules -> {out}")
