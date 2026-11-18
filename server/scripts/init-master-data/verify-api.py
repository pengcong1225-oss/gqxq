#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Read-only API verification (counts + batch list + samples)."""
import json, sys
import client

def j(path):
    r = client.call("GET", path, headers=client.headers())
    return r.status_code, (r.json().get("data") if r.status_code == 200 else r.text[:300])

out = {}
code, data = j("/grid-reference-options")
out["grid-reference-options"] = {
    "status": code,
    "adminGrids": len(data.get("adminGrids", [])) if code == 200 else None,
    "communities": len(data.get("communities", [])) if code == 200 else None,
    "enterprises": len(data.get("enterprises", [])) if code == 200 else None,
    "businessTypes": data.get("businessTypes") if code == 200 else None,
}
code, data = j("/grids?page=1&size=100")
out["grids"] = {"status": code, "total": data.get("total") if code == 200 else None,
                "published": sum(1 for g in data.get("content", []) if g.get("state") == "published") if code == 200 else None}
code, data = j("/enterprises?page=1&size=100")
out["enterprises"] = {"status": code, "total": data.get("total") if code == 200 else None}
code, data = j("/grids/GRID-ENT-GAS-001")
out["grid-detail"] = {"status": code,
    "adminGrids": len(data.get("adminGridCodes", [])) if code == 200 and isinstance(data, dict) else None,
    "validFrom": data.get("validFrom") if code == 200 and isinstance(data, dict) else None,
    "districtCodes": data.get("adminGridCodes") if code == 200 and isinstance(data, dict) else None}
code, data = j("/admin-grids/420502001")
out["admin-grid-detail"] = {"status": code, "code": data.get("code") if code == 200 else None,
                            "districtCode": data.get("districtCode") if code == 200 else None}
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8"))
