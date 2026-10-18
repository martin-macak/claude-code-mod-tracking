import json, os, sys, time
# Chunked reader: os.read in 64 KiB pieces. Waits until the file exists; the window starts at the first successful open.
path, secs, outp, chunk = sys.argv[1], float(sys.argv[2]), sys.argv[3], int(sys.argv[4])
MIB = 1048576
tally = dict(reads=0, empty=0, partial=0, full_uniform=0, full_mixed=0)
deadline = None
while True:
    if deadline is not None and time.time() > deadline: break
    try: fd = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        if deadline is None and time.time() > time.time() + 60: break
        continue
    if deadline is None: deadline = time.time() + secs
    try:
        parts = []
        while True:
            b = os.read(fd, chunk)
            if not b: break
            parts.append(b)
    finally: os.close(fd)
    data = b''.join(parts); n = len(data); tally['reads'] += 1
    if n == 0: tally['empty'] += 1
    elif n != MIB: tally['partial'] += 1
    elif data[:MIB-1] == bytes([data[0]]) * (MIB-1): tally['full_uniform'] += 1
    else: tally['full_mixed'] += 1
json.dump(tally, open(outp, 'w'), indent=1)
