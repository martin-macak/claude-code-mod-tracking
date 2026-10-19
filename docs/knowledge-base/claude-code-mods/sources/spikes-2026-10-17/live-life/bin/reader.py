import json, os, sys, time
path, secs, outp = sys.argv[1], float(sys.argv[2]), sys.argv[3]
MIB = 1048576
tally = dict(reads=0, empty=0, partial=0, full_uniform=0, full_mixed=0, enoent=0, errors=0)
sizes = {}
inodes = set()
end = time.time() + secs
while time.time() < end:
    try:
        st = os.stat(path); inodes.add(st.st_ino)
        with open(path, 'rb') as f: data = f.read()
    except FileNotFoundError:
        tally['enoent'] += 1; continue
    except Exception as e:
        tally['errors'] += 1; continue
    tally['reads'] += 1
    n = len(data)
    if n == 0: tally['empty'] += 1
    elif n != MIB: tally['partial'] += 1; sizes[n] = sizes.get(n, 0) + 1
    elif data[:MIB-1] == bytes([data[0]]) * (MIB-1): tally['full_uniform'] += 1
    else: tally['full_mixed'] += 1
json.dump(dict(tally=tally, partial_sizes_sample=dict(list(sizes.items())[:10]), inodes=sorted(inodes)), open(outp, 'w'), indent=1)
