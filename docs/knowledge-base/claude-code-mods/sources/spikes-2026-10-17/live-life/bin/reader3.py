import json, os, sys, time
# mode "single": f.read() (one read call). mode "chunk": os.read in 64 KiB pieces. Window starts at the first open.
path, secs, outp, mode = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4]
MIB, SMALL = 1048576, 4096
tally = dict(reads=0, empty=0, small_ok=0, big_uniform=0, big_mixed=0, small_mixed=0, other_len=0)
others = {}
deadline = None
while deadline is None or time.time() < deadline:
    try: fd = os.open(path, os.O_RDONLY)
    except FileNotFoundError: continue
    if deadline is None: deadline = time.time() + secs
    try:
        if mode == 'single':
            st = os.fstat(fd); data = os.read(fd, st.st_size + 1) if st.st_size else b''
        else:
            parts = []
            while True:
                b = os.read(fd, 65536)
                if not b: break
                parts.append(b)
            data = b''.join(parts)
    finally: os.close(fd)
    n = len(data); tally['reads'] += 1
    if n == 0: tally['empty'] += 1
    elif n == SMALL:
        if data[:SMALL-1] == bytes([data[0]]) * (SMALL-1): tally['small_ok'] += 1
        else: tally['small_mixed'] += 1
    elif n == MIB:
        if data[:MIB-1] == bytes([data[0]]) * (MIB-1): tally['big_uniform'] += 1
        else: tally['big_mixed'] += 1
    else: tally['other_len'] += 1; others[n] = others.get(n, 0) + 1
json.dump(dict(tally=tally, other_lengths=dict(list(others.items())[:10])), open(outp, 'w'), indent=1)
