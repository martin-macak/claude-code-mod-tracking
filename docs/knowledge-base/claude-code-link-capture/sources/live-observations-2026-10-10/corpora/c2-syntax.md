CASE-a nested: [a [b]](https://e.com/p_(q)) end

CASE-b angle: [a](<https://e.com/sp ace>) end

CASE-c trailing: see https://e.com/t1. And (https://e.com/t2) and https://e.com/t3, then https://e.com/t4! also https://e.com/t5?x=1&y=2; ok https://e.com/t6) x

CASE-d emph: **https://e.com/em1** and *https://e.com/em2* and _https://e.com/em3_ and ~~https://e.com/em4~~

CASE-e fenced:

```
https://e.com/fence
[x](https://e.com/fenceinline)
```

CASE-f indented:

    https://e.com/indent
    [x](https://e.com/indentinline)

CASE-g escape: \[x](https://e.com/esc1) and [x\](https://e.com/esc2) and \<https://e.com/esc3>

CASE-h image: ![alt](https://e.com/img.png) and ![](https://e.com/img2.png)

CASE-i autolinks: <ftp://e.com/al1> <mailto:a@b.com> <foo:bar> <a@b.com> <https://e.com/al5>

CASE-j html: <a href="https://e.com/html1">h</a> and <https://e.com/al6 trailing>

CASE-k labels: [](https://e.com/empty) and [https://e.com/same](https://e.com/same) and [https://a.com/lbl](https://b.com/dest)

CASE-l bare variants: http://localhost:3000/x and HTTPS://E.COM/UP and ftp://e.com/ftp and e.com/noscheme and www.e.com and https://e.com/a_b_c_ and git@github.com:o/r.git

CASE-m table:

| a | b |
|---|---|
| [x](https://e.com/tbl1) | https://e.com/tbl2 |

CASE-n list and quote:

- item https://e.com/li1
  - [n](https://e.com/li2)

> quote [q](https://e.com/bq) https://e.com/bq2

# Heading [h](https://e.com/hd) https://e.com/hd2

CASE-o in codespan variants: `a` [`code`](https://e.com/cs1) and ``x `https://e.com/cs2` y``

CASE-p link with title: [t](https://e.com/title1 "T") [t](https://e.com/title2 'T') [t](https://e.com/title3 (T))

CASE-q multi-line label: [multi
line](https://e.com/ml1) and url across wrap https://e.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/end

CASE-r percent/space/unicode: [u](https://e.com/ü/é) [s](https://e.com/a%20b) bare https://e.com/ü

CASE-s dup and ids: https://e.com/dup https://e.com/dup

CASE-end
