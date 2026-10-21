// Short, pronounceable peer handles: "P-Ember", "P-Kestrel", "P-Vexwyn".
// Shared by the browser launcher and the node-side launchers (plain ESM).

const WORDS = [
  'Ember', 'Kestrel', 'Onyx', 'Sable', 'Rook', 'Fenwick', 'Larkin', 'Thorne', 'Vesper', 'Ashby',
  'Corvid', 'Driftwood', 'Glimmer', 'Hollow', 'Ironwing', 'Juniper', 'Kindle', 'Lumen', 'Marrow', 'Nightjar',
  'Oriel', 'Pyre', 'Quill', 'Rune', 'Slate', 'Tinder', 'Umber', 'Vale', 'Wisp', 'Zephyr',
  'Brindle', 'Cinder', 'Dusk', 'Ferrous', 'Gale', 'Hawthorn', 'Ivory', 'Jasper', 'Moth', 'Nettle',
];

export function fancyLabel(taken = new Set(), rnd = Math.random) {
  const pick = () => WORDS[Math.floor(rnd() * WORDS.length)];
  for (let i = 0; i < 40; i++) {
    const name = `P-${pick()}`;
    if (!taken.has(name)) return name;
  }
  // Everyone picked the same word? Append a short tag.
  return `P-${pick()}-${Math.floor(rnd() * 90 + 10)}`;
}
