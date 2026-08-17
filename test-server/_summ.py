import sys, json

d = json.load(sys.stdin)
data = d.get("data") or {}
res = data.get("result") if isinstance(data, dict) else None
print("status:", d.get("status"), "| skill:", data.get("skillId"),
      "| durationMs:", data.get("durationMs"), "| htmlBytes:", data.get("htmlBytes"))

steps = (data.get("steps") if isinstance(data, dict) else None) or d.get("steps") or []
fails = [s for s in steps if isinstance(s, dict) and "failed" in (s.get("label") or "")]

if not isinstance(res, dict):
    print("NO RESULT. steps:", [s.get("label") for s in steps if isinstance(s, dict)][:25])
    print("error:", d.get("error"))
    sys.exit(0)

# The list key varies by extractor.
listkey = None
for k in ("people", "companies", "conversations", "posts", "items", "profiles"):
    if isinstance(res.get(k), list):
        listkey = k
        break

print("query:", res.get("query"), "| header:", res.get("resultsHeader"))
print("count:", res.get("count"), "| listkey:", listkey,
      "| _probe:", json.dumps(res.get("_probe"), ensure_ascii=False))

rows = res.get(listkey) or [] if listkey else []
for i, p in enumerate(rows[:6]):
    if not isinstance(p, dict):
        print("--", i, repr(p)[:120]); continue
    keys = [k for k in ("full_name", "name", "tag_line", "industry", "location",
                        "localisation", "degree", "followers", "snippet", "time",
                        "unread", "profile_url", "company_url", "thread_url") if k in p]
    print("--", i, {k: p.get(k) for k in keys})

if rows:
    def fill(k):
        return sum(1 for p in rows if isinstance(p, dict) and p.get(k))
    for k in ("full_name", "name", "tag_line", "industry", "location", "localisation",
              "profile_url", "company_url", "snippet", "time", "thread_url"):
        n = fill(k)
        if n:
            print(f"fill {k}: {n}/{len(rows)}")

for f in fails[:6]:
    print("  fail:", f.get("label"), f.get("message") or f.get("sel"))
