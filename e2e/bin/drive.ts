import { drive, parseDriveArgs } from '../support/drive.ts'

try {
  const output = await drive(parseDriveArgs(process.argv.slice(2)))
  if (output !== '') process.stdout.write(output)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
