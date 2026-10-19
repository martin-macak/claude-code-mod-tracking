export class Core {
  hits: string[] = []
  note(s: string): void {
    this.hits.push(s)
  }
}
