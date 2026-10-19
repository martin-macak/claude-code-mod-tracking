import re,sys
S='<SPIKES>/live2-table/out/events.log'
L=open(S).read().strip().split('\n')
start=max(i for i,l in enumerate(L) if ' CMD ' in l)
W=L[start:]
F=[l for l in W if ' F el=' in l and 'origin=person' in l]
R=[l for l in W if ' R rows' in l]
g=lambda rx,ls:[int(re.search(rx,l).group(1)) for l in ls]
n,u,b=g(r'next=(\d+)ms',F),g(r'upd=(\d+)ms',F),g(r'build=(\d+)ms',R)
print(W[0][14:90])
print(f'person F events={len(F)}  R renders={len(R)} (R per F = {len(R)/max(1,len(F)):.2f})')
print(f'next(e) ms mean={sum(n)/len(n):.1f} max={max(n)}; atom update ms mean={sum(u)/len(u):.1f} max={max(u)}; render build ms mean={sum(b)/len(b):.1f} max={max(b)}')
