// Run the example scanner on a text file and print one JSON object per found link.
// usage: node scan-file.mts corpora/c2-syntax.md   (Node 24+ strips the types)
import fs from 'node:fs'
import { scanMarkdown } from '../../example/link-capture/hooks/links.ts'

for (const f of scanMarkdown(fs.readFileSync(process.argv[2]!, 'utf8'))) console.log(JSON.stringify(f))
