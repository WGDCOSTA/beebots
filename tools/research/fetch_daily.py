import json, time, urllib.request, sys
COINS="BTC ETH SOL XRP DOGE ADA AVAX LINK DOT LTC BCH BNB TRX UNI NEAR ALGO XLM FIL ATOM ETC AAVE HBAR".split()
out=sys.argv[1]
for c in COINS:
    inst=f"{c}-USDT-SWAP"; rows=[]; after=""
    for _ in range(40):
        url=f"https://eea.okx.com/api/v5/market/history-candles?instId={inst}&bar=1Dutc&limit=100"+(f"&after={after}" if after else "")
        d=json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"curl/8.5"}), timeout=20))
        if d.get("code")!="0" or not d["data"]: break
        rows+=d["data"]; after=d["data"][-1][0]; time.sleep(0.12)
        if len(d["data"])<100: break
    rows=sorted({r[0]:r for r in rows if r[8]=="1"}.values(), key=lambda r:int(r[0]))
    json.dump([{"ts":int(r[0]),"o":float(r[1]),"h":float(r[2]),"l":float(r[3]),"c":float(r[4]),"volUsd":float(r[7])} for r in rows], open(f"{out}/{c}.json","w"))
    print(c, len(rows), time.strftime("%Y-%m-%d", time.gmtime(int(rows[0][0])/1000)) if rows else "-", flush=True)
