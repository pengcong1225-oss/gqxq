#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Thin client for the gqxq master-data import API (preview -> commit), idempotent and re-runnable."""
import json, os, time
import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
LOGDIR = os.path.join(ROOT, ".dev-logs", "import-2025-2026")
BASE = "http://127.0.0.1:3100/api/v1"
ADMIN = os.path.join(LOGDIR, ".init-admin.json")
TOKEN = os.path.join(LOGDIR, ".init-token")

def token(force=False):
    if not force and os.path.exists(TOKEN):
        t = open(TOKEN, encoding="utf-8").read().strip()
        if t:
            return t
    cred = json.load(open(ADMIN, encoding="utf-8"))
    r = requests.post(BASE + "/auth/login", json={"username": cred.get("username"), "password": cred.get("password")}, timeout=30)
    r.raise_for_status()
    t = r.json()["data"]["token"]
    open(TOKEN, "w", encoding="utf-8").write(t)
    return t

def headers(auth=True, content_type=None):
    h = {}
    if auth:
        h["Authorization"] = "Bearer " + token()
    if content_type:
        h["Content-Type"] = content_type
    return h

def call(method, path, retries=3, **kw):
    last = None
    for i in range(retries):
        try:
            r = requests.request(method, BASE + path, timeout=120, **kw)
            if r.status_code >= 500 and i < retries - 1:
                time.sleep(1.5 * (i + 1)); last = r; continue
            return r
        except requests.RequestException as e:
            last = e
            time.sleep(1.5 * (i + 1))
    if isinstance(last, requests.Response):
        return last
    raise last

def preview(kind, name, content_bytes):
    r = call("POST", "/master-data/imports/preview", params={"kind": kind, "name": name},
             headers=headers(content_type="application/octet-stream"), data=content_bytes)
    return r

def commit(batch_id, preview_version, request_id):
    return call("POST", "/master-data/imports/%s/commit" % batch_id,
                headers=headers(content_type="application/json"),
                json={"previewVersion": preview_version, "requestId": request_id})

def errors_csv(batch_id):
    return call("GET", "/master-data/imports/%s/errors" % batch_id, headers=headers())

def run_import(kind, csv_path, request_id, allow_commit=True):
    data = open(csv_path, "rb").read()
    r = preview(kind, os.path.basename(csv_path), data)
    out = {"kind": kind, "file": os.path.basename(csv_path), "bytes": len(data),
           "previewStatus": r.status_code}
    if r.status_code != 200:
        out["error"] = r.text[:800]
        return out
    p = r.json()["data"]
    out.update({"batchId": p["batchId"], "previewVersion": p["previewVersion"], "counts": p["counts"],
                "canCommit": p["canCommit"]})
    if not p["canCommit"]:
        e = errors_csv(p["batchId"])
        out["errorsCsv"] = e.text[:4000]
        return out
    if not allow_commit:
        return out
    c = commit(p["batchId"], p["previewVersion"], request_id)
    out["commitStatus"] = c.status_code
    if c.status_code == 200:
        out["result"] = c.json()["data"]
    else:
        out["commitError"] = c.text[:1200]
    return out

def save_result(record, path=None):
    path = path or os.path.join(LOGDIR, "masterdata", "import-results.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = []
    if os.path.exists(path):
        try:
            data = json.load(open(path, encoding="utf-8"))
        except Exception:
            data = []
    data.append(record)
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return path
