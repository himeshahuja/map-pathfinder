// Binary min-heap keyed by a numeric priority.
export class MinHeap {
  constructor() {
    this.items = [];
    this.pris = [];
  }

  get size() { return this.items.length; }

  peekPri() { return this.pris.length ? this.pris[0] : Infinity; }

  push(item, pri) {
    const { items, pris } = this;
    let i = items.length;
    items.push(item);
    pris.push(pri);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (pris[p] <= pri) break;
      items[i] = items[p];
      pris[i] = pris[p];
      i = p;
    }
    items[i] = item;
    pris[i] = pri;
  }

  pop() {
    const { items, pris } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastPri = pris.pop();
    const n = items.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && pris[r] < pris[l] ? r : l;
        if (pris[c] >= lastPri) break;
        items[i] = items[c];
        pris[i] = pris[c];
        i = c;
      }
      items[i] = lastItem;
      pris[i] = lastPri;
    }
    return top;
  }
}
